#!/usr/bin/env python3
"""Recommendation log: every BET/pick Sports Bets gave Shawn, placed or not, graded from final scores.

  python3 rec.py add --sport NFL --event "Away @ Home" --start "2026-10-18 13:00" --market Moneyline \
        --selection "Away Team" --book theScore --price +250 [--fair 30.1 --ev 4.2 --stake 0.2 \
        --promo cash|profit boost|bonus bet|No Sweat|rollover|live boost --eff-price +325 --friend --note ...]
  python3 rec.py grade        # sync placed recs from bets.csv + grade unplaced recs whose game is final (ESPN)
  python3 rec.py stats [--json out.json]
  python3 rec.py backfill     # one-off rebuild from history (bets.csv + scan outputs + chat picks)
File: recommendations.csv (same folder).
"""
import csv, json, os, re, sys, datetime, hashlib, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build as P   # reuse ESPN matching (find_game, team_match, norm, parse_date)
from common import RECS, BETS, lock, now_et

COLS = ["rec_id", "rec_date", "rec_time_et", "sport", "event", "game_start_et", "market", "selection", "book",
        "rec_price", "eff_price", "fair_pct", "ev_pct", "stake", "promo", "friend", "placed", "bet_ids",
        "result", "final_score", "source", "notes"]
MYBOOKS = {"theScore Bet ON": "theScore", "FanDuel ON": "FanDuel", "DraftKings ON": "DraftKings", "bet365 ON": "bet365"}
SPORT_PATHS = {"NFL": ["football/nfl"], "NCAAF": ["football/college-football"], "NBA": ["basketball/nba"],
               "NHL": ["hockey/nhl"], "MLB": ["baseball/mlb"], "WNBA": ["basketball/wnba"], "CFL": ["football/cfl"]}

def load():
    return list(csv.DictReader(open(RECS))) if os.path.exists(RECS) else []
def save(rows):
    rows.sort(key=lambda r: (r["rec_date"], r["rec_time_et"] or "99", r["rec_id"]))
    with open(RECS, "w", newline="") as f:
        w = csv.DictWriter(f, COLS); w.writeheader(); [w.writerow({k: r.get(k, "") for k in COLS}) for r in rows]

def am(s):
    m = re.search(r"[+-]?\d+", str(s or "").replace(",", ""))
    if not m: return None
    v = int(m[0]); return v if abs(v) >= 100 else None
def dec(a): return None if a is None else (1 + a / 100 if a > 0 else 1 + 100 / -a)
def fnum(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "")); return float(m[0]) if m else None
def rid(*parts): return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:8]

def promo_of(text):
    t = text.lower()
    if "friend" in t: pass
    if "live" in t and "boost" in t: return "live boost"
    if "boost" in t: return "profit boost"
    if "bonus" in t: return "bonus bet"
    if re.search(r"no sweat|bet reset|safety net", t): return "No Sweat"
    if re.search(r"welcomedm|rollover|wagering", t): return "rollover"
    return "cash"

SEL_STOP = {"ml", "moneyline", "the", "fc", "w", "women"}
def selwords(s):
    return {w for w in P.norm(re.sub(r"\(.*?\)", " ", s or "")) if w not in SEL_STOP}
def kind(market, sel):
    m = (market + " " + sel).lower()
    if " + " in sel or re.search(r"parlay|sgp", m): return "multi"
    if "draw" in m: return "draw"
    if re.search(r"\b(over|under)\b", m): return "total"
    if re.search(r"spread|puck line|run line|[+-]\d+\.?\d*\s*$", m): return "spread"
    if re.search(r"parlay|sgp", m): return "multi"
    return "ml"
def same_rec(a, b):
    """one rec per selection per game-day"""
    if a["game_start_et"][:10] != b["game_start_et"][:10]: return False
    ka, kb = kind(a["market"], a["selection"]), kind(b["market"], b["selection"])
    if ka != kb or ka == "multi": return False
    wa, wb = selwords(a["selection"]), selwords(b["selection"])
    if not wa or not wb: return False
    if not (wa <= wb or wb <= wa): return False
    if ka in ("total", "spread"):
        la = re.findall(r"\d+(?:\.\d+)?", a["selection"]); lb = re.findall(r"\d+(?:\.\d+)?", b["selection"])
        if la[-1:] != lb[-1:]: return False
    ea, eb = selwords(evclean(a["event"])), selwords(evclean(b["event"]))
    return bool(ea & eb)
def evclean(e): return re.sub(r"\b(london|ncaaf|nfl|nba|nhl|mlb)\b", " ", re.sub(r"\s*\([^)]*\)", "", e), flags=re.I)

# ---------------------------------------------------------------- grading
def teams_of(event):
    e = re.sub(r"\s+London\b", "", re.sub(r"\s*\([^)]*\)", "", event)).strip()
    parts = re.split(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+", e)
    return [p.strip() for p in parts if p.strip()] if len(parts) == 2 else None

def paths_for(r):
    sp = r["sport"].upper()
    if sp in SPORT_PATHS: return SPORT_PATHS[sp]
    if sp and sp not in SPORT_PATHS: return ["soccer/all"]
    return P.DEFAULT_PATHS + ["soccer/all"]

def start_dt(r):
    s = r["game_start_et"]
    try: return datetime.datetime.strptime(s[:16], "%Y-%m-%d %H:%M")
    except Exception:
        try: return datetime.datetime.strptime(s[:10], "%Y-%m-%d")
        except Exception: return None

def find(r):
    names = teams_of(r["event"]); d = start_dt(r)
    if not names or not d: return None
    if r["rec_id"] in _found: return _found[r["rec_id"]]
    women = bool(re.search(r"\bwomen\b|\bW\b|nwsl|wnba", r["event"] + r["sport"], re.I))
    names = [re.sub(r"\s+Women$", "", n) for n in names]
    g = P.find_game(names, paths_for(r), d, women)
    if not g and r["sport"] == "":
        g = P.find_game(names, ["soccer/all"], d, women)
    if g and not r["sport"]:
        r["sport"] = "Soccer" if g["path"].startswith("soccer") else P.SPORT_LABEL.get(g["path"], "")
    _found[r["rec_id"]] = g
    return g
_found = {}

def score_str(snap):
    aw = next(t for t in snap["teams"] if not t["home"]); hm = next(t for t in snap["teams"] if t["home"])
    return f'{aw["abbr"]} {aw["score"]}-{hm["score"]} {hm["abbr"]} ({snap["detail"]})'

def grade_one(r, snap):
    teams = snap["teams"]; k = kind(r["market"], r["selection"])
    sc = [float(t["score"] or 0) for t in teams]
    comp = lambda t: P._snap_comp(t)
    def side():
        sel = re.sub(r"\s+(ML|Moneyline)$", "", re.sub(r"\s*[+-]\d+(\.\d+)?\s*$", "", r["selection"]), flags=re.I).strip()
        sel = re.sub(r"\s+Women$", "", sel)
        hits = [i for i, t in enumerate(teams) if P.team_match(sel, comp(t))]
        if len(hits) != 1:
            hits = [i for i, t in enumerate(teams) if selwords(sel) & set(P.norm(t["name"] or ""))]
        return hits[0] if len(hits) == 1 else None
    if k == "draw": return "won" if sc[0] == sc[1] else "lost"
    if k == "total":
        line = fnum(r["selection"]); tot = sum(sc)
        if tot == line: return "push"
        over = tot > line
        return "won" if over == r["selection"].lower().startswith("over") else "lost"
    i = side()
    if i is None: return None
    me, op = sc[i], sc[1 - i]
    if k == "spread":
        line = fnum(re.search(r"[+-]\d+(\.\d+)?\s*$", r["selection"])[0]) if re.search(r"[+-]\d+(\.\d+)?\s*$", r["selection"]) else None
        if line is None: return None
        m = me + line - op
        return "won" if m > 0 else "push" if m == 0 else "lost"
    return "won" if me > op else "lost"   # ML: a soccer draw loses a 3-way ML

def grade(rows, verbose=True):
    bets = {b["bet_id"]: b for b in csv.DictReader(open(BETS))}
    n = 0
    for r in rows:
        if r["result"] in ("won", "lost", "push", "void"): continue
        ids = [x for x in r["bet_ids"].split(";") if x]
        if ids:   # placed: the tracker result wins
            res = [bets[i]["result"].strip().lower() for i in ids if i in bets]
            fin = [x for x in res if x in ("won", "lost", "push", "void")]
            if fin:
                r["result"] = fin[0]; n += 1
        sd = start_dt(r)
        if r["result"] in ("won", "lost", "push", "void") or ids:
            pass   # placed recs follow the tracker only (never settled from scores here)
        elif sd and sd > now_et():
            r["result"] = "pending"
        elif kind(r["market"], r["selection"]) != "multi":
            g = find(r)
            if g and g["snapshot"].get("completed"):
                res = grade_one(r, g["snapshot"])
                if res: r["result"] = res; n += 1
                r["final_score"] = score_str(g["snapshot"])
            elif not r["result"]: r["result"] = "pending"
        if not r["result"]: r["result"] = "pending"
        if r["result"] != "pending" and not r["final_score"] and kind(r["market"], r["selection"]) != "multi":
            g = find(r)
            if g and g["snapshot"].get("completed"): r["final_score"] = score_str(g["snapshot"])
    if verbose: print(f"graded {n} rec(s); pending {sum(r['result']=='pending' for r in rows)}")
    return rows

# ---------------------------------------------------------------- stats
def units(r):
    """flat $1 at the recommended (effective) price. Bonus bets: stake not returned -> win pays dec-1, loss 0."""
    d = dec(am(r["eff_price"]) or am(r["rec_price"]))
    if d is None or r["result"] not in ("won", "lost", "push", "void"): return None
    bonus = r["promo"] == "bonus bet"
    if r["result"] == "won": return d - 1
    if r["result"] == "lost": return 0.0 if bonus else -1.0
    return 0.0
def exp_units(r):
    if r["ev_pct"] not in ("", None): return float(r["ev_pct"]) / 100
    d = dec(am(r["eff_price"]) or am(r["rec_price"])); p = fnum(r["fair_pct"])
    if d and p: return p / 100 * (d - 1) if r["promo"] == "bonus bet" else p / 100 * d - 1
    return None

def agg(rs):
    g = [r for r in rs if r["result"] in ("won", "lost")]
    w = sum(r["result"] == "won" for r in g); l = len(g) - w
    pu = sum(r["result"] in ("push", "void") for r in rs)
    cash = [r for r in rs if r["promo"] != "bonus bet" and units(r) is not None]
    u = sum(units(r) for r in cash)
    ex = [exp_units(r) for r in cash if exp_units(r) is not None]
    exw = [fnum(r["fair_pct"]) / 100 for r in g if fnum(r["fair_pct"]) is not None]
    return {"n": len(rs), "w": w, "l": l, "p": pu, "pending": sum(r["result"] == "pending" for r in rs),
            "win_pct": round(100 * w / len(g), 1) if g else None,
            "units": round(u, 2), "roi_pct": round(100 * u / len(cash), 1) if cash else None, "roi_n": len(cash),
            "exp_roi_pct": round(100 * sum(ex) / len(ex), 1) if ex else None,
            "exp_wins": round(sum(exw), 1) if exw else None, "exp_wins_n": len(exw),
            "wins_with_fair": sum(r["result"] == "won" for r in g if fnum(r["fair_pct"]) is not None)}

def stats(rows):
    mine = [r for r in rows if r["friend"] != "yes"]
    out = {"overall": agg(mine), "by_promo": {}, "by_sport": {}, "by_placed": {}, "friend": agg([r for r in rows if r["friend"] == "yes"])}
    for key, f in (("by_promo", "promo"), ("by_sport", "sport")):
        for v in sorted({r[f] or "?" for r in mine}): out[key][v] = agg([r for r in mine if (r[f] or "?") == v])
    for v in ("yes", "no"): out["by_placed"][v] = agg([r for r in mine if r["placed"] == v])
    out["clv"] = "not available: no closing Pinnacle prices are stored"
    return out

def fmt(a):
    rec = f'{a["w"]}-{a["l"]}' + (f'-{a["p"]}' if a["p"] else "")
    s = f'{rec:>8}  win {a["win_pct"] if a["win_pct"] is not None else "-":>5}%'
    if a["roi_pct"] is not None: s += f'  ROI {a["roi_pct"]:+.1f}% ({a["units"]:+.2f}u/{a["roi_n"]})  exp {a["exp_roi_pct"]:+.1f}%' if a["exp_roi_pct"] is not None else f'  ROI {a["roi_pct"]:+.1f}%'
    if a["exp_wins"] is not None: s += f'  wins {a["wins_with_fair"]} vs exp {a["exp_wins"]}'
    if a["pending"]: s += f'  pending {a["pending"]}'
    return s

def print_stats(st):
    print("OVERALL     ", fmt(st["overall"]))
    for k in ("by_placed", "by_promo", "by_sport"):
        print(k.replace("by_", "by ").upper())
        for v, a in st[k].items(): print(f"  {v:<12}", fmt(a))
    if st["friend"]["n"]: print("FRIEND      ", fmt(st["friend"]))
    print("CLV:", st["clv"])
    print(f'Sample is small ({st["overall"]["w"] + st["overall"]["l"]} graded): treat win% / ROI as noise; expected-vs-actual is the fairer read.')

def dash_payload(rows):
    st = stats(rows)
    recent = sorted(rows, key=lambda r: (r["rec_date"], r["rec_time_et"]), reverse=True)
    return {"stats": st, "recent": [{k: r[k] for k in ("rec_id", "rec_date", "rec_time_et", "sport", "event", "market", "selection", "book",
            "rec_price", "eff_price", "fair_pct", "ev_pct", "stake", "promo", "friend", "placed", "result", "final_score", "source", "notes")}
            | {"units": None if units(r) is None else round(units(r), 2)} for r in recent]}

# ---------------------------------------------------------------- add / backfill
def add(rows, r, quiet=False):
    r = {k: r.get(k, "") for k in COLS}
    if not r["rec_id"]: r["rec_id"] = rid(r["game_start_et"][:10], r["selection"], r["event"])
    r["friend"] = r["friend"] or "no"; r["placed"] = r["placed"] or "no"; r["result"] = r["result"] or "pending"
    for x in rows:
        if same_rec(x, r):
            if not quiet: print("duplicate of", x["rec_id"], x["selection"], "- not added")
            return x
    rows.append(r)
    if not quiet: print("added", r["rec_id"], r["selection"])
    return r

def link_placed(rows):
    """mark recs that match a bet in bets.csv (same selection & game day) as placed"""
    for b in csv.DictReader(open(BETS)):
        d = P.parse_date(b)
        if not d: continue
        cand = {"game_start_et": d.strftime("%Y-%m-%d %H:%M"), "market": b["market"], "selection": b["pick"], "event": b["event"]}
        for r in rows:
            if r["friend"] == "yes": continue
            if same_rec(r, cand) and b["bet_id"] not in r["bet_ids"].split(";"):
                r["bet_ids"] = ";".join([x for x in r["bet_ids"].split(";") if x] + [b["bet_id"]]); r["placed"] = "yes"

LINE = re.compile(r"^BET\s+(-?[\d.]+)% \| (\w+) (\w{3} \w{3} \d{2} \d{2}:\d{2} [AP]M) ET \| (.+?) \| ([A-Za-z ]+?): (.+?) \| (.+?) ([+-]\d+) \| Pin\((\w+)\) (.+?) \| fair ([\d.]+)%")
def scan_tops():
    """the one exact pick a routine/asked-for scan produced: top BET row at a book Shawn uses (bet365 only at +100 or longer)."""
    files = ["run_1750.txt", "tonight_strict.txt", "sun_1004.txt", "nfl_1004.txt", "scan_1852.txt", "daily_1004.txt", "now_1917.txt",
             "now_1615.txt", "daily_1005.txt", "daily_1006.txt", "daily_1007.txt", "daily_1009.txt", "daily_1010.txt", "daily_1011.txt",
             "/workspace/sb3.log", "/workspace/scan1431.log", "/workspace/scan1745.log"]
    out = []
    for f in files:
        p = f if f.startswith("/") else os.path.join(HERE, f)
        if not os.path.exists(p): continue
        L = open(p).read().splitlines()
        pm = re.match(r"Pulled (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2} [AP]M)", L[0])
        pulled = datetime.datetime.strptime(pm[1] + " " + pm[2], "%Y-%m-%d %I:%M:%S %p")
        for ln in L[1:]:
            m = LINE.match(ln)
            if not m: continue
            ev, lg, st, event, mk, sel, book, odds = float(m[1]), m[2], m[3], m[4], m[5], m[6], m[7], int(m[8])
            if book not in MYBOOKS or (book == "bet365 ON" and odds < 100): continue
            sd = datetime.datetime.strptime(f"{pulled.year} {st}", "%Y %a %b %d %I:%M %p")
            out.append({"rec_date": pulled.strftime("%Y-%m-%d"), "rec_time_et": pulled.strftime("%H:%M"), "sport": lg, "event": event,
                        "game_start_et": sd.strftime("%Y-%m-%d %H:%M"), "market": mk, "selection": sel + ("" if mk != "Moneyline" else ""),
                        "book": MYBOOKS[book], "rec_price": f"{odds:+d}", "eff_price": f"{odds:+d}", "fair_pct": m[11], "ev_pct": f"{ev:.2f}",
                        "stake": "", "promo": "cash", "source": f"scan top pick ({os.path.basename(p)}, Pin {m[9]} {m[10]})",
                        "notes": "inferred: #1 BET row of that scan"})
            break
    return out

CHAT = [  # picks given in chat that never made it to bets.csv (from the conversation history, Oct 17-18)
    dict(rec_date="2026-10-17", rec_time_et="14:32", sport="NCAAF", event="Alabama Crimson Tide @ Tennessee Volunteers", game_start_et="2026-10-17 15:30",
         market="Moneyline", selection="Tennessee Volunteers", book="theScore", rec_price="+280", eff_price="+280", fair_pct="26.98", ev_pct="2.51",
         stake="0.20", promo="cash", source="chat (Find for tonight) / scan1431", notes="placement never confirmed"),
    dict(rec_date="2026-10-17", rec_time_et="17:47", sport="NCAAF", event="New Mexico Lobos @ Hawai'i Warriors", game_start_et="2026-10-17 22:30",
         market="Total", selection="Over 45.5", book="theScore", rec_price="+100", eff_price="+100", fair_pct="52.27", ev_pct="4.54",
         stake="0.15", promo="cash", source="chat (Find for tonight) / scan1745", notes="placement never confirmed"),
    dict(rec_date="2026-10-17", rec_time_et="18:27", sport="NCAAF", event="Alabama Crimson Tide @ Tennessee Volunteers", game_start_et="2026-10-17 15:30",
         market="Moneyline LIVE (30% profit boost)", selection="Alabama Crimson Tide ML", book="DraftKings", rec_price="+353", eff_price="+459",
         fair_pct="25.2", ev_pct="41.0", stake="0.30", promo="live boost", source="chat / live_cfb.json (DK live vs Pinnacle live)",
         notes="placed at +264 (+370 boosted) after the price moved"),
    dict(rec_date="2026-10-18", rec_time_et="07:59", sport="Soccer", event="Alaves @ Celta Vigo", game_start_et="2026-10-18 10:15",
         market="3-Way Draw (WELCOMEDM rollover)", selection="Draw", book="PointsBet", rec_price="+230", eff_price="+230", fair_pct="30.99", ev_pct="2.26",
         stake="10.00", promo="rollover", source="chat (Find pb bets) / pb/sun/out.txt", notes="Shawn placed Alaves to win instead (not this rec)"),
    dict(rec_date="2026-10-18", rec_time_et="07:59", sport="Soccer", event="Deportes Tolima @ Aguilas Doradas", game_start_et="2026-10-18 15:00",
         market="3-Way Draw (WELCOMEDM rollover)", selection="Draw", book="PointsBet", rec_price="+225", eff_price="+225", fair_pct="31.01", ev_pct="0.77",
         stake="10.00", promo="rollover", source="chat (Find pb bets) / pb/sun/out.txt", notes="rollover pick (0%+ EV rule), below the +2% cash bar"),
    dict(rec_date="2026-10-18", rec_time_et="07:59", sport="Soccer", event="Montpellier @ Rodez", game_start_et="2026-10-19 14:45",
         market="3-Way Draw (WELCOMEDM rollover)", selection="Draw", book="PointsBet", rec_price="+240", eff_price="+240", fair_pct="31.0", ev_pct="5.41",
         stake="10.00", promo="rollover", source="chat (Find pb bets) / pb/sun/out.txt", notes=""),
]
for ev, sel, sp, st, fair_am in [("Utrecht @ Twente", "Utrecht", "Soccer", "2026-10-18 14:00", 686), ("Arizona Cardinals @ Los Angeles Rams", "Arizona Cardinals", "NFL", "2026-10-18 16:05", 648),
                                  ("Lazio @ Juventus", "Lazio", "Soccer", "2026-10-18 14:45", 551), ("Arsenal @ Nottingham Forest", "Nottingham Forest", "Soccer", "2026-10-18 11:30", 516),
                                  ("Gil Vicente @ Braga", "Gil Vicente", "Soccer", "2026-10-19 15:15", 564)]:
    CHAT.append(dict(rec_date="2026-10-18", rec_time_et="09:25", sport=sp, event=ev, game_start_et=st, market="Moneyline" + (" 3-way" if sp == "Soccer" else ""),
                     selection=sel, book="Caesars", rec_price=f"+{fair_am}", eff_price=f"+{fair_am}", fair_pct=f"{100 * 100 / (fair_am + 100):.2f}", ev_pct="",
                     stake="5.00 (bonus)", promo="bonus bet", source="chat (Caesars bonus bets)",
                     notes="price shown is Pinnacle fair (no Caesars feed); Caesars price TBC"))

SPORT_HINT = [(r"\(NFL\)|NFL|Eagles|Seahawks|Commanders|Titans|Colts|Jets|Patriots|Cowboys|Packers|Steelers|Buccaneers|Panthers @ Phil|Texans|Ravens|Bills @ Rams", "NFL"),
              (r"NCAAF|college|Tulane|State @|@ .*State|Hawai|Buffalo @|Toledo|Rutgers|Maryland|Auburn|Georgia|Kent State|South Florida|Florida State|Miami \(FL\)|Old Dominion|UAB|Texas State|BYU|Hoosiers|Missouri State|FIU|Middle Tennessee|Sam Houston|Kennesaw", "NCAAF"),
              (r"\(NBA\)|Pelicans|Bulls|Suns|Hornets|Pistons|Knicks|Grizzlies|Pacers", "NBA"),
              (r"\(NHL\)|Senators|Rangers|Canucks|Sabres|Islanders|Stars @|NHL", "NHL"), (r"\(MLB\)|Brewers|Dodgers", "MLB"),
              (r"Valkyries|Aces", "WNBA"), (r"Soccer|NWSL|La Liga|Serie|Liga|Napoli|Brazil", "Soccer")]
def sport_of(text):
    for rx, s in SPORT_HINT:
        if re.search(rx, text): return s
    return ""

def backfill():
    rows = []
    for b in csv.DictReader(open(BETS)):
        if not b["fair_pct"].strip(): continue          # unpriced bets (his own SGPs, screenshots) are not my recommendations
        if b["bet_id"] == "43fe2d05": continue          # Alaves ML: Shawn's substitute for the recommended Celta-Alaves draw
        d = P.parse_date(b); bp = am(b["boosted_price"]); pr = am(b["price"]); note = []
        promo = promo_of(b["event"] + " " + b["market"] + " " + b["pick"] + " " + b["stake"])
        if pr is None and b["result"] == "won" and fnum(b["pnl"]) and fnum(b["stake"]):
            dd = 1 + fnum(b["pnl"]) / fnum(b["stake"]); pr = round((dd - 1) * 100) if dd >= 2 else round(-100 / (dd - 1)); note.append("price derived from payout")
        if "unconfirmed" in b["price"] and pr is not None: note.append("price approx (unconfirmed in tracker)")
        if bp is None and pr is not None and "x2" in b["boosted_price"]:
            dd = 1 + 2 * (dec(pr) - 1); bp = round((dd - 1) * 100) if dd >= 2 else round(-100 / (dd - 1))
        prs = f"{pr:+d}" if pr is not None else ""
        rows_r = add(rows, {"rec_date": b["date"], "sport": "", "event": re.sub(r"\s*\((?:NFL|NBA|NHL|MLB|NCAAF|Soccer[^)]*)\)", "", b["event"]),
             "game_start_et": d.strftime("%Y-%m-%d %H:%M") if d else b["date"], "market": b["market"], "selection": b["pick"], "book": b["book"],
             "rec_price": prs, "eff_price": f"{bp:+d}" if bp and promo in ("profit boost", "live boost") else prs,
             "fair_pct": b["fair_pct"], "ev_pct": b["ev_pct"], "stake": b["stake"], "promo": promo, "placed": "yes", "bet_ids": b["bet_id"],
             "source": "bets.csv (priced pick he placed)", "notes": "; ".join(note)}, quiet=True)
    for r in CHAT: add(rows, r, quiet=True)
    for r in scan_tops(): add(rows, r, quiet=True)
    link_placed(rows)
    for r in rows: r["rec_id"] = r["rec_id"] or rid(r["game_start_et"][:10], r["selection"], r["event"])
    for r in rows:
        if not r["sport"]: find(r)
        if not r["sport"]: r["sport"] = sport_of(r["event"] + " " + r["market"] + " " + r["selection"])
    merged = {}
    for b in csv.DictReader(open(BETS)): merged[b["bet_id"]] = b
    for r in rows:
        ids = [x for x in r["bet_ids"].split(";") if x]
        if len(ids) > 1:
            r["notes"] = "; ".join(filter(None, [r["notes"], "merged (one rec per selection per day): " + " + ".join(f'{merged[i]["book"]} {merged[i]["market"]}' for i in ids if i in merged)]))
    # merges that 'one rec per selection per day' produced
    return rows

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["add", "grade", "stats", "backfill"])
    for a in ("sport", "event", "start", "market", "selection", "book", "price", "eff-price", "fair", "ev", "stake", "promo", "note", "json", "rec-date", "rec-time"):
        ap.add_argument("--" + a, default="")
    ap.add_argument("--friend", action="store_true"); ap.add_argument("--placed", action="store_true")
    a = ap.parse_args()
    _lk = lock() if a.cmd != "stats" else __import__("contextlib").nullcontext()
    _lk.__enter__()
    if a.cmd == "backfill":
        rows = grade(backfill()); save(rows); print(f"{len(rows)} recs written"); print_stats(stats(rows))
    elif a.cmd == "add":
        rows = load(); now = now_et()
        add(rows, {"rec_date": a.rec_date or now.strftime("%Y-%m-%d"), "rec_time_et": a.rec_time or now.strftime("%H:%M"), "sport": a.sport,
                   "event": a.event, "game_start_et": a.start, "market": a.market, "selection": a.selection, "book": a.book,
                   "rec_price": a.price, "eff_price": a.eff_price or a.price, "fair_pct": a.fair, "ev_pct": a.ev, "stake": a.stake,
                   "promo": a.promo or "cash", "friend": "yes" if a.friend else "no", "placed": "yes" if a.placed else "no",
                   "source": "rec.py add", "notes": a.note})
        link_placed(rows); save(rows)
    elif a.cmd == "grade":
        rows = load(); link_placed(rows); grade(rows); save(rows)
    else:
        rows = load(); st = stats(rows); print_stats(st)
        if a.json: json.dump(dash_payload(rows), open(a.json, "w"), indent=1)
