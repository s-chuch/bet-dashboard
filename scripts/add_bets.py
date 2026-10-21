#!/usr/bin/env python3
"""Add bets sent from the Upload bets tab (run by .github/workflows/add-bets.yml; safe to run by hand).

Input comes from the environment only (never a command line or shell string):
  BETS_JSON  a JSON array (max 30) of objects with keys date, book, event, start_et, market, pick, price,
             boosted_price, stake, to_win  (all strings or numbers)
Every field is validated here again (the page validated it too, but the workflow is the real gate). A bet that
duplicates an existing one (same book + event + pick + stake) is skipped, not an error. Each accepted bet goes through
ledger.log, which assigns the id, writes data/bets.csv and deducts the stake in data/ledger.csv.
Exit 0 = at least one bet added or all were duplicates, 2 = bad input (nothing written), 1 = nothing could be added.
"""
import sys, os, re, io, json, datetime, contextlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import lock, now_et, all_bets
import ledger as LG

BOOKS = {"DraftKings", "FanDuel", "Caesars", "PointsBet", "bet365", "theScore", "Hard Rock", "BetMGM", "BetRivers", "Bet99", "888sport", "Betway", "LeoVegas", "Sports Interaction", "Pinnacle", "Proline", "Bally Bet", "NorthStar Bets"}
KEYS = ("date", "book", "event", "start_et", "market", "pick", "price", "boosted_price", "stake", "to_win", "force")
LIMIT = {"event": 120, "start_et": 40, "market": 80, "pick": 400}
ODDS_RE = re.compile(r"[+-](?:1[0-9]{2}|[2-9][0-9]{2}|[0-9]{4,5})")   # American odds, magnitude >= 100
MONEY_RE = re.compile(r"[0-9]{1,6}(\.[0-9]{1,2})?")
DATE_RE = re.compile(r"20[0-9]{2}-[01][0-9]-[0-3][0-9]")
BAD_CH = re.compile(r"[\x00-\x1f\x7f]")

STOP = {"to", "win", "wins", "ml", "moneyline", "pts", "points", "pt", "sog", "sot", "shots", "shot", "on", "goal", "goals", "team", "total", "the", "fc", "and", "of", "sgp", "leg", "legs", "vs", "v", "at", "target", "parlay"}

def sig(r):
    """(words, numbers) of event + pick: names and line numbers, ignoring stat/market filler."""
    t = re.findall(r"[a-z]+|\d+(?:\.\d+)?", (r.get("event", "") + " " + r.get("pick", "")).lower())
    nums = {x for x in t if x[0].isdigit()}
    return {x for x in t if not x[0].isdigit() and x not in STOP and len(x) > 1}, nums

def same_bet(a, b):
    """Fuzzy duplicate test, tolerant of OCR / wording differences ('Celtics ML' vs 'Boston Celtics ML'):
    same book, same stake, placed within 3 days, same set of line numbers, and the names of one overlap >= 75% with the other."""
    if a["book"].strip().lower() != b["book"].strip().lower(): return False
    try:
        if abs(float(str(a["stake"]).split(" ")[0]) - float(str(b["stake"]).split(" ")[0])) > 0.005: return False
        if abs((datetime.date.fromisoformat(a["date"]) - datetime.date.fromisoformat(b["date"])).days) > 3: return False
    except (ValueError, KeyError): return False
    wa, na = sig(a); wb, nb = sig(b)
    if na != nb or not wa or not wb: return False
    return len(wa & wb) / min(len(wa), len(wb)) >= 0.75

def die(msg, code=2):
    print((f"::error::add bets refused: {msg}") if os.environ.get("GITHUB_ACTIONS") else f"REFUSED: {msg}", flush=True)
    sys.exit(code)

def clean(i, k, v):
    s = "" if v is None else str(v).strip()
    if BAD_CH.search(s): die(f"bet {i}: control character in {k}")
    s = re.sub(r"\s+", " ", s)
    if s[:1] in ("=", "@") or (s[:1] in ("+", "-") and k not in ("price", "boosted_price")): die(f"bet {i}: {k} may not start with {s[:1]!r}")
    return s

def validate(i, b):
    if not isinstance(b, dict): die(f"bet {i}: not an object")
    if set(b) - set(KEYS): die(f"bet {i}: unknown field(s) {sorted(set(b) - set(KEYS))}")
    r = {k: clean(i, k, b.get(k)) for k in KEYS}
    if r["force"] not in ("", "1"): die(f"bet {i}: bad force flag")
    if not DATE_RE.fullmatch(r["date"]): die(f"bet {i}: bad date")
    try: d = datetime.date.fromisoformat(r["date"])
    except ValueError: die(f"bet {i}: bad date")
    today = now_et().date()
    if abs((d - today).days) > 60: die(f"bet {i}: date is more than 60 days from today")
    if r["book"] not in BOOKS:
        known = {x["book"] for x in LG.load_ledger()}
        if r["book"] not in known: die(f"bet {i}: unknown book {r['book']!r}")
    for k, n in LIMIT.items():
        if len(r[k]) > n: die(f"bet {i}: {k} too long")
    if not r["event"] or not r["pick"]: die(f"bet {i}: event and pick are required")
    if not ODDS_RE.fullmatch(r["price"]): die(f"bet {i}: price must be American odds like +325")
    if r["boosted_price"] and not ODDS_RE.fullmatch(r["boosted_price"]): die(f"bet {i}: bad boosted_price")
    bonus = r["stake"].endswith(" (bonus)")      # bonus / free bets: the tracker writes the stake as "15.00 (bonus)" so no cash is deducted
    base = r["stake"][:-8] if bonus else r["stake"]
    if bonus and not re.search(r"bonus bet|free bet", r["market"], re.I): die(f"bet {i}: a bonus stake needs 'bonus bet $N' in the market")
    if not MONEY_RE.fullmatch(base) or not (0 < float(base) <= 500): die(f"bet {i}: stake must be 0.01 to 500")
    if not MONEY_RE.fullmatch(r["to_win"]) or not (0 < float(r["to_win"]) <= 100000): die(f"bet {i}: to_win must be above 0")
    return r

def main():
    try: bets = json.loads(os.environ.get("BETS_JSON", ""))
    except ValueError: die("BETS_JSON is not valid JSON")
    if not isinstance(bets, list) or not 1 <= len(bets) <= 30: die("send between 1 and 30 bets")
    rows = [validate(i + 1, b) for i, b in enumerate(bets)]
    added = dup = 0
    with lock():
        known = [dict(x) for x in all_bets()]      # live + archived + settled: the whole history
        for r in rows:
            force = r.pop("force") == "1"
            twin = next((x for x in known if same_bet(r, x)), None)
            if twin and not force:
                dup += 1; print(f"skipped duplicate (same as {twin.get('bet_id') or 'an earlier row of this upload'}): {r['book']} | {r['pick'][:60]}"); continue
            argv = ["log"] + [f"{k}={v}" for k, v in r.items() if v != ""] + (["--force"] if force else [])
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf): LG.main(argv)
                added += 1; known.append(dict(r)); print(f"added: {r['book']} | {r['pick'][:60]}")
            except SystemExit as e:
                if "REJECTED duplicate" in buf.getvalue(): dup += 1; print(f"skipped duplicate: {r['book']} | {r['pick'][:60]}")
                else: print(f"failed: {r['book']} | {r['pick'][:60]} ({e})"); 
    print(f"summary: {added} added, {dup} duplicate(s) skipped, {len(rows) - added - dup} failed")
    sys.exit(0 if (added or dup) and added + dup == len(rows) else 1)   # any failed row -> red run

if __name__ == "__main__":
    main()
