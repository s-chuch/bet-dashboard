#!/usr/bin/env python3
"""Read-only reminder list for the three rules in RULES.md.  Writes nothing unless --json is given.

  python3 scripts/audit.py            # counts + the bets that still need something
  python3 scripts/audit.py --since 2026-10-20 --json out.json
Lists: no rec linked | no fair % | no EV | no start_et | straight bet with no close | a bet linked to more than one rec | rec at a different book than its bet.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import all_bets, read_csv, RECS
import clv as C

def audit(rows=None, recs=None, since=""):
    rows = [r for r in (rows or all_bets()) if (r.get("date") or "") >= since]
    recs = recs if recs is not None else read_csv(RECS)[0]
    links = {}
    for x in recs:
        for i in (x.get("bet_ids") or "").split(";"):
            if i.strip(): links.setdefault(i.strip(), []).append(x)
    blank = lambda r, k: not (r.get(k) or "").strip()
    row = lambda r, **k: {"bet_id": r["bet_id"], "date": r["date"], "book": r["book"], "pick": r["pick"][:50], **k}
    out = {
        "no_rec": [row(r) for r in rows if r["bet_id"] not in links],
        "no_fair": [row(r) for r in rows if blank(r, "fair_pct")],
        "no_ev": [row(r) for r in rows if blank(r, "ev_pct")],
        "no_start_et": [row(r) for r in rows if blank(r, "start_et")],
        "no_close": [x for x in C.missing_closes(rows)],
        "multi_rec": [row(r, recs=[x["rec_id"] for x in links[r["bet_id"]]]) for r in rows if len(links.get(r["bet_id"], [])) > 1],
        "cross_book": [row(r, rec=x["rec_id"], rec_book=x["book"]) for r in rows for x in links.get(r["bet_id"], []) if x["book"] != r["book"]],
    }
    return {"bets": len(rows), **{k: v for k, v in out.items()}}

def main(argv):
    since = argv[argv.index("--since") + 1] if "--since" in argv else ""
    a = audit(since=since)
    print(f"bets checked: {a['bets']}" + (f" (since {since})" if since else ""))
    for k in ("no_rec", "no_fair", "no_ev", "no_start_et", "no_close", "multi_rec", "cross_book"):
        print(f"  {k:<12} {len(a[k])}")
    for k in ("no_start_et", "multi_rec", "cross_book"):
        for x in a[k]: print(f"    {k}: {x['bet_id']} {x['book']} {x['pick']}" + (f" -> {x.get('recs') or x.get('rec')}" if k != "no_start_et" else ""))
    if "--json" in argv: json.dump(a, open(argv[argv.index("--json") + 1], "w"), indent=1)

if __name__ == "__main__":
    main(sys.argv[1:])
