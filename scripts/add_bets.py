#!/usr/bin/env python3
"""Add bets sent from the Upload bets tab (run by .github/workflows/add-bets.yml; safe to run by hand).

Input comes from the environment only (never a command line or shell string):
  BETS_JSON  a JSON array (max 30) of objects with keys date, book, event, start_et, market, pick, price,
             boosted_price, stake, to_win  (all strings or numbers), optional force ("1") and result
             (won|lost|push|void: the slip was already settled; the bet is logged, then settled through ledger.settle)
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
KEYS = ("date", "book", "event", "start_et", "market", "pick", "price", "boosted_price", "stake", "to_win", "force", "result")
# optional Bet Finder fields: link the bet to a recommendation row (or record a skip) - never written to bets.csv
FINDER = ("placed_at", "kind", "sport", "game_start", "selection", "fair", "ev", "rec_price", "key", "skip", "reason")
SKIPS = os.path.join(os.path.dirname(HERE), "data", "finder_skips.csv")
TS_RE = re.compile(r"20[0-9]{2}-[01][0-9]-[0-3][0-9] [0-2][0-9]:[0-5][0-9]")
RESULTS = ("", "won", "lost", "push", "void")
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
    if set(b) - set(KEYS) - set(FINDER): die(f"bet {i}: unknown field(s) {sorted(set(b) - set(KEYS) - set(FINDER))}")
    f = finder_fields(i, b)
    if f.get("skip") == "1":
        if not (b.get("book") and b.get("event") and f.get("key")): die(f"bet {i}: a skip needs book, event and key")
        return {"_skip": True, "_f": f, "book": clean(i, "book", b.get("book")), "event": clean(i, "event", b.get("event"))[:120],
                "price": clean(i, "price", b.get("price"))}
    r = {k: clean(i, k, b.get(k)) for k in KEYS}
    r["_f"] = f
    if r["force"] not in ("", "1"): die(f"bet {i}: bad force flag")
    r["result"] = r["result"].lower()
    if r["result"] not in RESULTS: die(f"bet {i}: result must be won, lost, push or void")
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

def finder_fields(i, b):
    f = {}
    for k in FINDER:
        v = b.get(k)
        if v in (None, ""): continue
        v = re.sub(r"\s+", " ", str(v).strip())
        if BAD_CH.search(v) or v[:1] in ("=", "@") or len(v) > 160: die(f"bet {i}: bad {k}")
        f[k] = v
    if f.get("placed_at") and not TS_RE.fullmatch(f["placed_at"]): die(f"bet {i}: placed_at must be YYYY-MM-DD HH:MM")
    if f.get("game_start") and not TS_RE.fullmatch(f["game_start"]): die(f"bet {i}: game_start must be YYYY-MM-DD HH:MM")
    if f.get("kind", "cash") not in ("cash", "bonus", "boost"): die(f"bet {i}: kind must be cash, bonus or boost")
    if f.get("skip", "1") != "1": die(f"bet {i}: bad skip flag")
    for k in ("fair", "ev"):
        if k in f and not re.fullmatch(r"-?[0-9]{1,3}(\.[0-9]{1,2})?", f[k]): die(f"bet {i}: bad {k}")
    return f

PROMO = {"cash": "cash", "bonus": "bonus bet", "boost": "profit boost"}
def rec_row(b, f, placed, bet_id="", note=""):
    now = now_et()
    return {"rec_date": now.strftime("%Y-%m-%d"), "rec_time_et": now.strftime("%H:%M"), "sport": f.get("sport", ""), "event": b["event"],
            "game_start_et": f.get("game_start", ""), "market": b.get("market", "") or f.get("kind", ""), "selection": f.get("selection") or b.get("pick", ""),
            "book": b["book"], "rec_price": f.get("rec_price") or b.get("price", ""), "eff_price": b.get("boosted_price") or b.get("price", ""),
            "fair_pct": f.get("fair", ""), "ev_pct": f.get("ev", ""), "stake": b.get("stake", "").split(" ")[0], "promo": PROMO.get(f.get("kind", "cash"), "cash"),
            "friend": "no", "placed": "yes" if placed else "no", "bet_ids": bet_id, "source": "finder", "notes": note}

def link_rec(b, f, bet_id):
    """Bet Finder 'Log it': attach the new bet to its rec (adding the rec if the Finder pick was never logged as one)."""
    if not f.get("selection"): return
    try:
        import rec as RC
        rows = RC.load(); new = rec_row(b, f, True, bet_id, "logged from Bet Finder" + (f" (key {f['key']})" if f.get("key") else ""))
        hit = next((x for x in rows if new["game_start_et"] and RC.same_rec_book(x, new)), None)   # same book only: never a rec at another sportsbook
        if hit:
            hit["placed"] = "yes"; hit["bet_ids"] = ";".join([x for x in hit["bet_ids"].split(";") if x] + [bet_id]); print(f"rec linked: {hit['rec_id']}")
        else:
            RC.add(rows, new, quiet=True, by_book=True); print("rec added for finder pick")
        RC.save(rows)
    except Exception as e: print(f"::warning::rec link failed: {e}")

def record_skip(r):
    """Bet Finder 'Skip': hide that pick for the rest of the day and count it as skipped in the recs log (never as placed)."""
    f = r["_f"]; now = now_et(); reason = f.get("reason") or "odds wrong/moved"
    import csv
    rows = list(csv.DictReader(open(SKIPS))) if os.path.exists(SKIPS) else []
    if any(x["date_et"] == now.strftime("%Y-%m-%d") and x["key"] == f["key"] for x in rows): print(f"skip already recorded: {f['key'][:60]}"); return
    rows.append({"date_et": now.strftime("%Y-%m-%d"), "ts_et": now.strftime("%Y-%m-%d %H:%M"), "key": f["key"], "book": r["book"], "reason": reason})
    with open(SKIPS, "w", newline="") as fh:
        w = csv.DictWriter(fh, ["date_et", "ts_et", "key", "book", "reason"]); w.writeheader(); w.writerows(rows)
    try:
        import rec as RC
        recs = RC.load(); new = rec_row({"event": r["event"], "book": r["book"], "price": r["price"]}, f, False, "", "SKIPPED in Bet Finder: " + reason)
        hit = next((x for x in recs if new["game_start_et"] and RC.same_rec_book(x, new)), None)
        if hit:
            if hit["placed"] != "yes" and "SKIPPED" not in hit["notes"]: hit["notes"] = "; ".join(filter(None, [hit["notes"], new["notes"]]))
        else: RC.add(recs, new, quiet=True, by_book=True)
        RC.save(recs)
    except Exception as e: print(f"::warning::skip rec note failed: {e}")
    print(f"skipped: {r['book']} | {f['key'][:60]} ({reason})")

def settle_new(log_out, result, r):
    """Settle a bet that was just logged from an already-settled slip, through the ledger (so the return hits the balance)."""
    m = re.search(r"^logged ([0-9a-f]{6,16})$", log_out, re.M)
    if not m: print(f"::warning::logged but could not find the new bet id to settle ({r['pick'][:40]}); settle it by hand"); return
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf): LG.main(["settle", m.group(1), result])
    except SystemExit as e: print(f"::warning::settle {m.group(1)} {result} failed ({e})"); return
    print(f"settled: {m.group(1)} {result}" if f"settled {m.group(1)}" in buf.getvalue() else f"::warning::settle {m.group(1)} said: {buf.getvalue().strip()[:200]}")

def main():
    try: bets = json.loads(os.environ.get("BETS_JSON", ""))
    except ValueError: die("BETS_JSON is not valid JSON")
    if not isinstance(bets, list) or not 1 <= len(bets) <= 30: die("send between 1 and 30 bets")
    rows = [validate(i + 1, b) for i, b in enumerate(bets)]
    added = dup = 0
    with lock():
        known = [dict(x) for x in all_bets()]      # live + archived + settled: the whole history
        for r in rows:
            if r.get("_skip"): record_skip(r); added += 1; continue
            f = r.pop("_f")
            force = r.pop("force") == "1"; result = r.pop("result")
            twin = next((x for x in known if same_bet(r, x)), None)
            if twin and not force:
                dup += 1; print(f"skipped duplicate (same as {twin.get('bet_id') or 'an earlier row of this upload'}): {r['book']} | {r['pick'][:60]}"); continue
            if f.get("fair") and not r.get("fair_pct"): r["fair_pct"] = f["fair"]     # keep the Finder's fair chance and EV on the bet itself,
            if f.get("ev") and not r.get("ev_pct"): r["ev_pct"] = f["ev"]             # so the slip can colour the price by what it was worth
            argv = ["log"] + [f"{k}={v}" for k, v in r.items() if v != ""] + (["--force"] if force else []) + (["--no-rec"] if f.get("selection") else [])   # Finder bets are linked by link_rec below
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf): LG.main(argv)
                added += 1; known.append(dict(r)); print(f"added: {r['book']} | {r['pick'][:60]}")
                for ln in buf.getvalue().splitlines():   # rec link / rule-3 and boost-rule warnings from ledger log
                    if ln.startswith(("rec ", "WARNING", "BOOST RULE", "boost rule")): print(ln)
                if f.get("selection"):   # ledger ran with --no-rec, which also skips its boost-rule check: run it here (warning only, never creates a rec)
                    try:
                        import rules; bc = rules.boost_check_bet(r)
                        if bc: print(bc[1])
                    except Exception as e: print(f"::warning::boost rule check failed: {e}")
                m = re.search(r"^logged ([0-9a-f]{6,16})$", buf.getvalue(), re.M)
                if m and f:
                    if f.get("placed_at"):
                        try:
                            import clv; c = clv.load(); c.setdefault(m.group(1), {"bet_id": m.group(1)})["placed_at"] = f["placed_at"]; clv.save(c)
                        except Exception as e: print(f"::warning::placed_at not saved: {e}")
                    link_rec(r, f, m.group(1))
                if result: settle_new(buf.getvalue(), result, r)
            except SystemExit as e:
                if "REJECTED duplicate" in buf.getvalue(): dup += 1; print(f"skipped duplicate: {r['book']} | {r['pick'][:60]}")
                else: print(f"failed: {r['book']} | {r['pick'][:60]} ({e})"); 
    print(f"summary: {added} added, {dup} duplicate(s) skipped, {len(rows) - added - dup} failed")
    sys.exit(0 if (added or dup) and added + dup == len(rows) else 1)   # any failed row -> red run

if __name__ == "__main__":
    main()
