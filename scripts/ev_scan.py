#!/usr/bin/env python3
"""Bet Finder: strict +EV scan (port of the box's ev_strict.py / ev_finder.py), stdlib only.

Rules:
  * Fair = Pinnacle no-vig, multiplicative, SAME market, EXACT same side + line (main or alternate).
    If Pinnacle lacks any side of that line -> excluded ("not confirmed").
  * Books: FanDuel, DraftKings, bet365, theScore Bet (Ontario Action Network feeds).
  * EV = fair * decimal - 1.  BET if EV >= +2%, SKIP 0..+1.99%, NO below 0.
  * Kill price = worst American price that still gives EV >= +2%.
  * bet365 picks must be +100 or longer (shorter prices are excluded).
  * Stake = 0.5% of that book's balance in data/balances.csv (read only).
  * Games/teams with an open bet in data/bets.csv are excluded.
Output: finder.json (repo root, outside data/ so it does not trigger autorun).
Usage: python3 scripts/ev_scan.py [--out finder.json] [--hours 36] [--leagues mlb,nfl,...]
"""
import argparse, csv, datetime as dt, difflib, json, math, os, re, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/Toronto")
except Exception:  # pragma: no cover
    ET = dt.timezone(dt.timedelta(hours=-4))
BOOKS = {1998: "FanDuel", 1634: "DraftKings", 1270: "bet365", 2668: "theScore"}
BOOK_APP = {"FanDuel": "FanDuel", "DraftKings": "DraftKings", "bet365": "bet365", "theScore": "theScore Bet"}
LEAGUES = {"mlb": (3, ["MLB"]), "nfl": (15, ["NFL"]), "ncaaf": (15, ["NCAA"]), "nhl": (19, ["NHL"]),
           "nba": (4, ["NBA"]), "wnba": (4, ["WNBA"]), "soccer": (29, None)}
SPORT = {"mlb": ("BASEBALL", "MLB"), "nfl": ("FOOTBALL", "NFL"), "ncaaf": ("FOOTBALL", "NCAAF"),
         "nhl": ("HOCKEY", "NHL"), "nba": ("BASKETBALL", "NBA"), "wnba": ("BASKETBALL", "WNBA"),
         "soccer": ("SOCCER", "SOCCER")}
THR, STAKE_PCT = 0.02, 0.005

# ---------- math ----------
def implied(a): return -a / (-a + 100) if a < 0 else 100 / (a + 100)
def am2dec(a): return 1 + 100 / -a if a < 0 else 1 + a / 100
def dec2am(d): return round((d - 1) * 100) if d >= 2 else round(-100 / (d - 1))
def fair_probs(prices):
    imp = {k: implied(v) for k, v in prices.items()}; s = sum(imp.values())
    return {k: v / s for k, v in imp.items()}
def ev_of(fair, odds): return fair * am2dec(odds) - 1
def kill_price(fair, thr=THR):
    dmin = (1 + thr) / fair
    if dmin >= 2: return math.ceil(round((dmin - 1) * 100, 9))
    return -math.floor(round(100 / (dmin - 1), 9))
def classify(ev): return "BET" if ev >= THR - 1e-12 else ("SKIP" if ev >= 0 else "NO")
def book_allowed(book, odds): return not (book == "bet365" and odds < 100)

# ---------- tracker (read only) ----------
def balances(path):
    out = {}
    try:
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try: out[r["book"].strip()] = float(r["balance_cad"])
                except (KeyError, ValueError): pass
    except FileNotFoundError: pass
    return out

def open_events(path):
    ev = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if (r.get("result") or "").strip().lower() in ("", "open"):
                    ev.append(((r.get("event") or "") + " " + (r.get("pick") or "")).lower())
    except FileNotFoundError: pass
    return ev

GENERIC = {"fc", "cf", "sc", "united", "city", "state", "team", "club", "real", "sporting", "athletic", "the"}
def team_keys(team):
    keys = set()
    for f in ("full_name", "display_name"):
        v = (team.get(f) or "").strip().lower()
        if len(v) > 3 and v not in GENERIC: keys.add(v)
    return keys
def exposed(home, away, opens):
    keys = team_keys(home) | team_keys(away)
    return any(re.search(r"(?<![a-z])" + re.escape(k) + r"(?![a-z])", e) for k in keys for e in opens)

# ---------- feeds ----------
def get(url, headers=None):
    h = dict(UA); h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=40) as r:
        return json.loads(r.read().decode())
def pinnacle_key(): return get("https://www.pinnacle.com/config/app.json")["api"]["haywire"]["apiKey"]

def pinnacle_sport(sid, key):
    base = "https://guest.api.arcadia.pinnacle.com/0.1"
    hdr = {"X-API-Key": key, "Referer": "https://www.pinnacle.com/"}
    mus = get(f"{base}/sports/{sid}/matchups?withSpecials=false&brandId=0", hdr)
    mks = get(f"{base}/sports/{sid}/markets/straight?primaryOnly=false&withSpecials=false", hdr)
    games = {}
    for m in mus:
        if m.get("type") != "matchup" or m.get("parent") or m.get("isLive"): continue
        if m.get("units") not in (None, "Regular", "Goals", "Runs", "Points"): continue
        parts = {p["alignment"]: p["name"] for p in m.get("participants", [])}
        if "home" not in parts or "away" not in parts: continue
        games[m["id"]] = {"id": m["id"], "league": m["league"]["name"], "start": m["startTime"],
                          "home": parts["home"], "away": parts["away"], "markets": {}}
    for k in mks:
        g = games.get(k["matchupId"])
        if not g or k.get("period") != 0 or k.get("status") != "open": continue
        pr = {p["designation"]: p for p in k["prices"] if p.get("price") is not None}
        alt = bool(k.get("isAlternate"))
        if k["type"] == "moneyline":
            g["markets"]["ml"] = {"prices": {d: p["price"] for d, p in pr.items()}, "alt": alt}
        elif k["type"] == "spread":
            hp = pr["home"]["points"] if "home" in pr else (-pr["away"]["points"] if "away" in pr else None)
            if hp is None: continue
            g["markets"][("sp", float(hp))] = {"prices": {d: pr[d]["price"] for d in ("home", "away") if d in pr}, "alt": alt}
        elif k["type"] == "total":
            pts = (pr.get("over") or pr.get("under") or {}).get("points")
            if pts is None: continue
            g["markets"][("tot", float(pts))] = {"prices": {d: pr[d]["price"] for d in ("over", "under") if d in pr}, "alt": alt}
    return list(games.values())

def an_games(league, date, books, notes):
    url = f"https://api.actionnetwork.com/web/v2/scoreboard/{league}?bookIds={','.join(map(str, books))}&date={date}"
    try: d = get(url)
    except Exception as e:
        notes.append(f"{league} {date}: Action Network fetch failed: {e}"); return []
    out = []
    for g in d.get("games", []):
        if g.get("status") != "scheduled": continue
        teams = {t["id"]: t for t in g.get("teams", [])}
        home, away = teams.get(g.get("home_team_id")), teams.get(g.get("away_team_id"))
        if home and away:
            out.append({"id": g["id"], "start": g["start_time"], "home": home, "away": away, "markets": g.get("markets") or {}})
    return out

ALIASES = {"massachusetts": "umass", "ul lafayette": "louisiana", "ul monroe": "louisiana monroe",
           "miami ohio": "miami oh", "southern california": "usc", "central florida": "ucf"}
def norm(s): return re.sub(r"[^a-z0-9 ]", "", s.lower().replace("st.", "state").replace("&", "and"))
def name_score(t, pin_name):
    cands = [t.get(f) for f in ("full_name", "display_name", "location", "short_name") if t.get(f)]
    pn = norm(re.sub(r"\(.*?\)", "", pin_name)).strip(); pn = ALIASES.get(pn, pn)
    return max(difflib.SequenceMatcher(None, norm(c), pn).ratio() for c in cands)
def parse_t(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def match(an, pins):
    best, bs = None, 0; t = parse_t(an["start"])
    for p in pins:
        if abs((parse_t(p["start"]) - t).total_seconds()) > 3 * 3600: continue
        s = min(name_score(an["home"], p["home"]), name_score(an["away"], p["away"]))
        if s > bs: best, bs = p, s
    return (best, bs) if bs >= 0.6 else (None, bs)

# ---------- wording ----------
def app_market(lg, market, three_way):
    if market == "Moneyline": return "Match Result (3-way, 90 min)" if three_way else "Moneyline"
    if market == "Spread":
        return {"nhl": "Puck Line", "mlb": "Run Line", "soccer": "Asian Handicap / Spread"}.get(lg, "Spread")
    return {"nhl": "Total Goals", "mlb": "Total Runs", "soccer": "Total Goals"}.get(lg, "Total Points")
def unit(lg): return {"nhl": "goals", "soccer": "goals", "mlb": "runs"}.get(lg, "points")
def wins_if(lg, market, side, team, value, three_way):
    u = unit(lg)
    if market == "Moneyline":
        if side == "draw": return "The match is tied after 90 minutes plus stoppage time."
        return f"{team} win" + (" in 90 minutes plus stoppage time (a draw loses)." if three_way else
                                (" the game, including overtime/extra innings." if lg in ("nhl", "mlb", "nba", "wnba") else " the game."))
    if market == "Spread":
        if value < 0: return f"{team} win by more than {abs(value):g} {u}."
        return f"{team} win, or lose by less than {value:g} {u}."
    n = math.floor(value) + 1 if side == "over" else math.ceil(value) - 1
    return (f"Both teams combine for {n} or more {u}." if side == "over" else f"Both teams combine for {n} or fewer {u}.") + (" Whole-number line: exactly that total is a push." if value == int(value) else "")

# ---------- evaluation ----------
def evaluate(lg, an, pin, stats, bal):
    rows = []; pm = pin["markets"]
    H, A = an["home"]["full_name"], an["away"]["full_name"]
    three_way = "draw" in (pm.get("ml") or {}).get("prices", {})
    start = parse_t(an["start"]).astimezone(ET)
    def add(market, sel, book, odds, pmk, side, need, team=None, value=None):
        if pmk is None: stats["no_pin_line"] += 1; return
        if not all(s in pmk["prices"] for s in need): stats["not_confirmed"] += 1; return
        if not book_allowed(book, odds): stats["bet365_short"] += 1; return
        fair = fair_probs({s: pmk["prices"][s] for s in need})[side]
        ev = ev_of(fair, odds); b = bal.get(book)
        stake = round(b * STAKE_PCT, 2) if b is not None else None
        sp, lgname = SPORT[lg]
        rows.append({"league": lgname, "sport": sp, "event": f"{A} @ {H}", "away": A, "home": H,
                     "start_utc": an["start"], "start_et": start.strftime("%a %b %d, %-I:%M %p ET"),
                     "market": market, "app_market": app_market(lg, market, three_way and market == "Moneyline"),
                     "selection": sel, "book": book, "book_app": BOOK_APP[book], "odds": odds,
                     "fair_pct": round(fair * 100, 2), "fair_odds": dec2am(1 / fair), "ev_pct": round(ev * 100, 2),
                     "class": classify(ev), "kill_price": kill_price(fair),
                     "pin_prices": " / ".join(f"{s} {pmk['prices'][s]:+d}" for s in need),
                     "pin_line_type": "alt" if pmk["alt"] else "main",
                     "balance": b, "stake": stake, "stake_pct": STAKE_PCT * 100,
                     "ev_dollars": round(stake * ev, 2) if stake is not None else None,
                     "wins_if": wins_if(lg, market, side, team, value, three_way and market == "Moneyline")})
    ok = lambda o: not o.get("is_live") and o.get("line_status", "normal") == "normal" and o.get("odds") is not None
    for bid, per in an["markets"].items():
        try: bid = int(bid)
        except ValueError: continue
        if bid not in BOOKS: continue
        book = BOOKS[bid]; em = (per or {}).get("event", {}) or {}
        for o in em.get("moneyline", []):
            if not ok(o) or o.get("side") not in ("home", "away", "draw"): continue
            pmk = pm.get("ml")
            need = ["home", "away"] + (["draw"] if (pmk and "draw" in pmk["prices"]) or o["side"] == "draw" else [])
            team = {"home": H, "away": A, "draw": "Draw"}[o["side"]]
            add("Moneyline", team if o["side"] == "draw" else f"{team} to win", book, o["odds"], pmk, o["side"], need, team)
        for o in em.get("spread", []):
            if not ok(o) or o.get("side") not in ("home", "away"): continue
            v = float(o["value"]); hp = v if o["side"] == "home" else -v
            team = H if o["side"] == "home" else A
            add("Spread", f"{team} {v:+g}", book, o["odds"], pm.get(("sp", hp)), o["side"], ["home", "away"], team, v)
        for o in em.get("total", []):
            if not ok(o) or o.get("side") not in ("over", "under"): continue
            v = float(o["value"])
            add("Total", f'{o["side"].title()} {v:g}', book, o["odds"], pm.get(("tot", v)), o["side"], ["over", "under"], None, v)
    return rows

def scan(leagues, hours, root=ROOT):
    now = dt.datetime.now(ET); until = now + dt.timedelta(hours=hours)
    bal = balances(os.path.join(root, "data", "balances.csv"))
    opens = open_events(os.path.join(root, "data", "bets.csv"))
    dates, d = [], now
    while d.date() <= until.date(): dates.append(d.strftime("%Y%m%d")); d += dt.timedelta(days=1)
    notes, rows, counts, errors = [], [], {}, []
    try: key = pinnacle_key()
    except Exception as e:
        return {"ok": False, "error": f"Pinnacle key fetch failed: {e}", "scanned_et": now.strftime("%Y-%m-%d %I:%M %p ET")}
    pin_cache = {}
    for lg in leagues:
        sid, lf = LEAGUES[lg]
        if sid not in pin_cache:
            try: pin_cache[sid] = pinnacle_sport(sid, key)
            except Exception as e: errors.append(f"{lg}: Pinnacle fetch failed: {e}"); pin_cache[sid] = []
        pins = [p for p in pin_cache[sid] if not lf or any(p["league"].startswith(f) for f in lf)]
        st = {"games": 0, "unmatched": 0, "exposed": 0, "no_pin_line": 0, "not_confirmed": 0, "bet365_short": 0, "prices": 0}
        seen = set()
        for day in dates:
            for g in an_games(lg, day, list(BOOKS), errors):
                if g["id"] in seen: continue
                seen.add(g["id"]); t = parse_t(g["start"]).astimezone(ET)
                if not (now < t <= until): continue
                st["games"] += 1
                if exposed(g["home"], g["away"], opens):
                    st["exposed"] += 1; notes.append(f'{lg}: skipped {g["away"]["full_name"]} @ {g["home"]["full_name"]} (you already have a bet on it)'); continue
                p, s = match(g, pins)
                if not p: st["unmatched"] += 1; continue
                r = evaluate(lg, g, p, st, bal); st["prices"] += len(r); rows += r
        counts[lg] = st
    rows.sort(key=lambda r: -r["ev_pct"])
    bets = [r for r in rows if r["class"] == "BET"]
    near = [r for r in rows if r["class"] == "SKIP"][:10]
    return {"ok": True, "scanned_et": now.strftime("%a %b %d, %Y %-I:%M %p ET"), "scanned_utc": now.astimezone(dt.timezone.utc).isoformat(timespec="seconds"),
            "window_hours": hours, "rules": {"bet_ev_pct": THR * 100, "stake_pct": STAKE_PCT * 100, "books": list(BOOK_APP.values()), "bet365_min_odds": 100},
            "balances": {b: bal.get(b) for b in BOOKS.values()}, "counts": counts,
            "totals": {"prices": len(rows), "bet": len(bets), "skip": sum(r["class"] == "SKIP" for r in rows), "no": sum(r["class"] == "NO" for r in rows)},
            "bets": bets, "near_misses": near, "notes": notes, "errors": errors}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "finder.json"))
    ap.add_argument("--hours", type=float, default=36)
    ap.add_argument("--leagues", default="mlb,nfl,ncaaf,nhl,nba,wnba,soccer")
    a = ap.parse_args()
    res = scan(a.leagues.split(","), a.hours)
    with open(a.out, "w", encoding="utf-8") as f: json.dump(res, f, indent=1)
    if not res.get("ok"): print(res["error"], file=sys.stderr); sys.exit(1)
    print(f'{res["scanned_et"]}: {res["totals"]} errors={len(res["errors"])}')
    for r in res["bets"] + res["near_misses"]:
        print(f'{r["class"]:4} {r["ev_pct"]:6.2f}% {r["league"]} {r["event"]} | {r["market"]}: {r["selection"]} | {r["book"]} {r["odds"]:+d} | fair {r["fair_odds"]:+d} kill {r["kill_price"]:+d} | {r["pin_prices"]} ({r["pin_line_type"]})')
    for e in res["errors"]: print("ERR", e)
    if all(c["games"] == 0 for c in res["counts"].values()) and res["errors"]: sys.exit(1)

if __name__ == "__main__":
    main()
