#!/usr/bin/env python3
"""Backfill data/clv.csv for rule 1 (see RULES.md) and list the bets that still have no close.

  python3 scripts/clv_backfill.py                 # dry run: print what would change + the missing-close reminder list
  python3 scripts/clv_backfill.py --apply         # write data/clv.csv (takes the repo lock)
  python3 scripts/clv_backfill.py --espn          # also try ESPN's final DraftKings line as a PROXY close (network)
  python3 scripts/clv_backfill.py --json out.json # also write the missing-close list as JSON

Steps (all idempotent, never overwrite a value that is already there):
  1. every bet in bets.csv + archive gets a clv.csv row with open_price_unboosted / open_price_boosted copied from the
     bet's own price / boosted_price (only clean american prices; 'unconfirmed (~+120)' stays blank).
  2. rows that already have a Pinnacle close (close_fair_pct) get the new close columns derived from it.
  3. --espn: a straight ML/spread/total bet with no close whose game is final gets the no-vig of ESPN's final DraftKings
     line as close_source=espn_dk_final.  That is a soft-book proxy, not Pinnacle: it is kept out of clv_pct and the
     headline CLV, and the Pinnacle feed cannot serve closes for games that already started, so the rest stay missing.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import clv as C
from common import all_bets, lock, now_et

def step_open_prices(m, rows):
    n = 0
    for r in rows:
        u, b = C.open_prices(r)
        if not (u or b): continue
        c = m.setdefault(r["bet_id"], {"bet_id": r["bet_id"]})
        if u and not c.get("open_price_unboosted"): c["open_price_unboosted"] = u; n += 1
        if b and not c.get("open_price_boosted"): c["open_price_boosted"] = b; n += 1
    return n

def step_derive_close(m, byid):
    n = 0
    for k, c in m.items():
        if c.get("close_fair_pct") and not c.get("close_price_unboosted") and k in byid and C.straight(byid[k]):
            try: fair = float(c["close_fair_pct"]) / 100
            except ValueError: continue
            c.update(C.close_fields(byid[k], fair, "pinnacle")); n += 1
    return n

# ---------------- ESPN final-line proxy ----------------
def _novig(odds, key):
    imp = {k: C.implied(v) for k, v in odds.items() if v is not None}
    return imp[key] / sum(imp.values()) if key in imp else None

def espn_fair(r, summary, snap):
    """no-vig probability of the bet's side from ESPN's (DraftKings) final line in a summary payload, or None."""
    k = C.straight(r)
    if not k or not summary: return None
    pc = summary.get("pickcenter") or []
    pc = next((p for p in pc if (p.get("provider") or {}).get("name") == "DraftKings"), pc[0] if pc else None)
    if not pc: return None
    kind, side, line = k; home, away = pc.get("homeTeamOdds") or {}, pc.get("awayTeamOdds") or {}
    teams = snap["teams"]; hn = next(t for t in teams if t["home"])["name"]; an = next(t for t in teams if not t["home"])["name"]
    if kind == "tot":
        if pc.get("overUnder") != line: return None
        return _novig({"over": pc.get("overOdds"), "under": pc.get("underOdds")}, side)
    import re
    s = "draw" if re.fullmatch(r"(?i)draw|tie", side or "") else ("home" if C.sim(side, hn) >= C.sim(side, an) else "away")
    if kind == "ml":
        ml = {"home": home.get("moneyLine"), "away": away.get("moneyLine")}
        if (pc.get("drawOdds") or {}).get("moneyLine") is not None: ml["draw"] = pc["drawOdds"]["moneyLine"]
        if s == "draw" and "draw" not in ml: return None
        return _novig(ml, s)
    if s == "draw" or pc.get("spread") is None: return None       # spread
    hl = float(pc["spread"])
    if (home.get("favorite") and hl > 0) or (away.get("favorite") and hl < 0): return None   # sign disagrees with the favourite flag: do not trust
    if (hl if s == "home" else -hl) != line: return None
    return _novig({"home": home.get("spreadOdds"), "away": away.get("spreadOdds")}, s)

def step_espn(m, rows, find=None, get=None, now=None, limit=400):
    import build as P
    now = now or now_et(); n = tried = 0
    find = find or (lambda r: P.find_game(C.teams_of(r["event"]), P.DEFAULT_PATHS + ["soccer/all"], C.parse_start(r)))
    get = get or (lambda g: P.fetch(f'{P.ESPN}{g["path"]}/summary?event={g["id"]}'))
    for r in rows:
        c = m.get(r["bet_id"]) or {}
        if not C.straight(r) or c.get("close_price_unboosted") or c.get("clv_pct"): continue
        st = C.parse_start(r)
        if not st or st > now or tried >= limit: continue
        tried += 1
        g = find(r)
        if not g or not g["snapshot"].get("completed"): continue
        fair = espn_fair(r, get(g), g["snapshot"])
        if not fair: continue
        c = m.setdefault(r["bet_id"], {"bet_id": r["bet_id"]}); c.update(C.close_fields(r, fair, "espn_dk_final"))
        c["note"] = (c.get("note") or "") or "proxy close: no-vig ESPN final DraftKings line, not Pinnacle"; n += 1
    return n

def main(argv):
    apply, espn = "--apply" in argv, "--espn" in argv
    out = argv[argv.index("--json") + 1] if "--json" in argv else None
    def run():
        rows = all_bets(); byid = {r["bet_id"]: r for r in rows}; m = C.load()
        a = step_open_prices(m, rows); b = step_derive_close(m, byid); e = step_espn(m, rows) if espn else 0
        print(f"open prices filled: {a}; Pinnacle closes expanded to the new columns: {b}; ESPN proxy closes: {e}{'' if espn else ' (--espn not set)'}")
        if apply: C.save(m); print("written:", C.CLV)
        else: print("dry run: nothing written (add --apply)")
        miss = C.missing_closes(rows)
        print(f"\nstraight bets still without a close: {len(miss)}")
        for x in miss[:60]: print(f"  {x['bet_id']} {x['date']} {x['book']:<10} {x['pick']:<34} | {x['why']}")
        if len(miss) > 60: print(f"  ... {len(miss) - 60} more (use --json)")
        if out: json.dump(miss, open(out, "w"), indent=1)
    if apply: 
        with lock(): run()
    else: run()

if __name__ == "__main__":
    main(sys.argv[1:])
