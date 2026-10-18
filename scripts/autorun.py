#!/usr/bin/env python3
"""One unattended tracker pass (GitHub Actions runs this every 5 min; safe to run by hand).

  python3 scripts/autorun.py                 # settle + balances + picks grading + rebuild data.json
  python3 scripts/autorun.py --dry-run       # show what it WOULD settle / send to review; writes nothing
  python3 scripts/autorun.py --regrade DATE  # dry check: re-grade bets already settled on DATE (YYYY-MM-DD,
                                             #   by settled_at) and compare with the recorded result

Steps: ledger sync -> auto-settle every open bet whose games are ALL final and whose legs all grade
unambiguously (settle.py) through ledger.settle (idempotent, refuses double settles) -> rec.py grade ->
archive old settled bets (archive.py) -> build data.json + stats/archive/log json (only rewritten when content changed). Ambiguous bets go to data/autorun.json
needs_review (shown on the dashboard) and are never settled automatically.
Exit code 1 if a step raised (the dashboard turns red).
"""
import sys, os, json, csv, traceback
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import lock, AUTO, now_et, all_bets
import ledger as LG, settle as S

def log(*a): print(f"[{now_et():%Y-%m-%d %H:%M:%S} ET]", *a, flush=True)

def regrade(day):
    rows, _ = LG.load_bets(); agree = dis = rev = 0
    for r in rows:
        if not (r.get("settled_at") or "").startswith(day): continue
        if r["result"] not in LG.SETTLED: continue
        g = S.grade_row({**r, "result": "open", "settled_at": ""})
        if g["status"] == "settle":
            ok = g["result"] == r["result"]; agree += ok; dis += not ok
            log(("AGREE   " if ok else "DISAGREE"), r["bet_id"], r["book"], r["pick"][:70], "| manual", r["result"], "| auto", g["result"], g.get("final", ""))
        else:
            rev += 1; log(f"{g['status'].upper():8}", r["bet_id"], r["book"], r["pick"][:70], "| manual", r["result"], "|", g["reason"])
    log(f"regrade {day}: {agree} agree, {dis} disagree, {rev} not auto-gradable (would go to review/wait)")
    return dis

def run(dry=False):
    errors = []
    rows, cols = LG.load_bets(); led = LG.load_ledger()
    if not dry:
        LG.sync(quiet=True); rows, cols = LG.load_bets(); led = LG.load_ledger()
    if "settled_by" not in cols: cols.append("settled_by")
    for r in rows: r.setdefault("settled_by", "")
    open_rows = [r for r in rows if r["result"].strip().lower() in ("open", "")]
    review, settled = [], []
    for r in open_rows:
        try: g = S.grade_row(r)
        except Exception as e:
            errors.append(f"{r['bet_id']}: {e}"); continue
        if g["status"] == "review":
            review.append({"bet_id": r["bet_id"], "book": r["book"], "event": r["event"], "pick": r["pick"], "stake": r["stake"],
                           "reason": g["reason"], "legs": g["legs"]})
            log("REVIEW", r["bet_id"], r["book"], r["pick"][:60], "|", g["reason"])
        elif g["status"] == "settle":
            if dry:
                stake = LG.num(r["stake"]); p = LG.settle_amount(r, g["result"])[1]
                log("WOULD SETTLE", r["bet_id"], r["book"], r["pick"][:60], "->", g["result"], f"pnl {p:+.2f}", g.get("final", ""))
                settled.append({"bet_id": r["bet_id"], "result": g["result"], "pnl": round(p, 2)})
            elif LG.settle(rows, led, r, g["result"]):
                r["settled_by"] = "auto"
                log("SETTLED", r["bet_id"], r["book"], r["pick"][:60], "->", g["result"], "pnl", r["pnl"], g.get("final", ""))
                settled.append({"bet_id": r["bet_id"], "book": r["book"], "pick": r["pick"], "result": g["result"],
                                "pnl": LG.num(r["pnl"]), "final": g.get("final", ""), "at": r["settled_at"]})
        else:
            log("wait  ", r["bet_id"], r["book"], r["pick"][:60], "|", g["reason"])
    if dry:
        log(f"DRY RUN: would settle {len(settled)} (P&L {sum(x['pnl'] for x in settled):+.2f}), review {len(review)}"); return 0
    LG.save_bets(rows, cols); LG.write_balances(led)
    try:
        import rec as R
        rr = R.load(); R.link_placed(rr); R.grade(rr, verbose=False); R.save(rr)
    except Exception as e:
        errors.append(f"rec grade: {e}"); traceback.print_exc()
    try:
        import archive as A
        moved = A.archive()
        if moved: log(f"archived {len(moved)} old settled bets")
    except Exception as e:
        errors.append(f"archive: {e}"); traceback.print_exc()
    old = json.load(open(AUTO)) if os.path.exists(AUTO) else {}
    last = (settled + old.get("last_settled", []))[:25]
    new = {"needs_review": review, "last_settled": last, "errors": errors}
    if {k: old.get(k) for k in new} != new:
        new["last_change_at"] = now_et().strftime("%Y-%m-%d %H:%M ET")
        json.dump(new, open(AUTO, "w"), indent=1)
    try:
        import build as B; B.build()
    except Exception as e:
        errors.append(f"build: {e}"); traceback.print_exc()
    pnl = round(sum(LG.num(r["pnl"]) for r in all_bets() if r["result"] in LG.SETTLED), 2)
    log(f"done: settled {len(settled)} (P&L {sum(x['pnl'] for x in settled):+.2f}), needs_review {len(review)}, "
        f"tracker P&L {pnl:+.2f}, errors {len(errors)}")
    for e in errors: log("ERROR", e)
    return 1 if errors else 0

if __name__ == "__main__":
    a = sys.argv[1:]
    if "--regrade" in a: sys.exit(1 if regrade(a[a.index("--regrade") + 1]) else 0)
    dry = "--dry-run" in a
    if dry: sys.exit(run(True))
    with lock(): sys.exit(run(False))
