#!/usr/bin/env python3
"""One unattended tracker pass (GitHub Actions runs this every 5 min; safe to run by hand).

  python3 scripts/autorun.py                 # settle + balances + picks grading + rebuild data.json
  python3 scripts/autorun.py --dry-run       # show what it WOULD settle / send to review; writes nothing
  python3 scripts/autorun.py --fast          # live-loop pass: settle check only; full rebuild only if something changed
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
    rows = all_bets(); agree = dis = rev = 0
    for r in rows:
        r.setdefault("settled_at", "")
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

def run(dry=False, fast=False):
    errors = []
    rows, cols = LG.load_bets(); led = LG.load_ledger()
    if not dry:
        LG.sync(quiet=True); rows, cols = LG.load_bets(); led = LG.load_ledger()
    if "settled_by" not in cols: cols.append("settled_by")
    for r in rows: r.setdefault("settled_by", "")
    open_rows = [r for r in rows if r["result"].strip().lower() in ("open", "")]
    review, settled = [], []
    if fast:   # a bet that has not started cannot be settled, and futures wait for the owner: skip them in live passes
        import datetime as _dt
        cutoff = now_et() + _dt.timedelta(minutes=5)
        def _started(r):
            try: d = S.P.parse_date(r)
            except Exception: d = None
            return bool(d) and d <= cutoff
        open_rows = [r for r in open_rows if _started(r)]
    from concurrent.futures import ThreadPoolExecutor
    def _grade(r):
        try: return S.grade_row(r), None
        except Exception as e: return None, e
    with ThreadPoolExecutor(8) as ex: graded = list(ex.map(_grade, open_rows))   # network-bound: grade bets concurrently
    for r, (g, err) in zip(open_rows, graded):
        if err is not None:
            errors.append(f"{r['bet_id']}: {err}"); continue
        if g["status"] == "review":
            review.append({"bet_id": r["bet_id"], "book": r["book"], "event": r["event"], "pick": r["pick"], "stake": r["stake"],
                           "reason": g["reason"], "legs": g["legs"]})
            if not fast: log("REVIEW", r["bet_id"], r["book"], r["pick"][:60], "|", g["reason"])
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
            if not fast: log("wait  ", r["bet_id"], r["book"], r["pick"][:60], "|", g["reason"])
    if dry:
        log(f"DRY RUN: would settle {len(settled)} (P&L {sum(x['pnl'] for x in settled):+.2f}), review {len(review)}"); return 0
    if fast:   # live-loop pass (every ~10 s): rebuild only when a bet actually settled; review-list changes and flaky ESPN
        if not settled:   # responses are picked up by the normal pass at the start/end of each live job
            return 0
        log(f"live pass: {len(settled)} settled: full rebuild")
    LG.save_bets(rows, cols); LG.write_balances(led)
    try:
        import rec as R
        rr = R.load(); R.link_placed(rr); R.grade(rr, verbose=False); R.save(rr)
    except Exception as e:
        errors.append(f"rec grade: {e}"); traceback.print_exc()
    try:
        import clv as C
        n = C.capture(verbose=False)
        if n: log(f"clv: captured closing line for {n} bet(s)")
    except Exception as e:
        log("clv capture skipped:", e)   # network hiccup: not an autorun error (retried next pass)
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
    with lock(): sys.exit(run(False, fast="--fast" in a))
