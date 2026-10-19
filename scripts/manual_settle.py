#!/usr/bin/env python3
"""Manually settle ONE open bet (run by .github/workflows/manual-settle.yml; safe to run by hand).

Inputs come from the environment only (never from the command line or a shell string):
  BET_ID  8 hex chars, optionally with a -N suffix for duplicate ids (as make_id/assign_ids produce)
  RESULT  won | lost | void
  PROFIT  optional, CAD, only used for a win whose to_win is 0/unknown

Looks in data/bets.csv only (archived or already settled bets are refused), settles through
ledger.settle (which refuses double settles), marks settled_by=manual, saves bets + balances.
Exit 0 = settled, 3 = already settled with the SAME result (a repeat request: nothing to do, not an error),
2 = bad input, 1 = refused / not found / already settled with a DIFFERENT result.
"""
import sys, os, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import lock, archive_rows
import ledger as LG

ID_RE = re.compile(r"[0-9a-f]{8}(-[0-9]{1,3})?")
PROFIT_RE = re.compile(r"[0-9]+(\.[0-9]{1,2})?")

def die(msg, code=1):
    print(f"::error::manual settle refused: {msg}" if os.environ.get("GITHUB_ACTIONS") else f"REFUSED: {msg}", flush=True)
    sys.exit(code)

def already(bid, result, existing):
    """Repeat request for a bet that is already settled. Same result -> quiet no-op (exit 3); different -> refuse loudly."""
    if (existing or "").strip().lower() == result:
        print((f"::notice::" if os.environ.get("GITHUB_ACTIONS") else "") + f"{bid} is already settled as {result}; nothing to do", flush=True)
        sys.exit(3)
    die(f"{bid} is already settled (result={existing}), not {result}")

def main():
    bid = os.environ.get("BET_ID", ""); result = os.environ.get("RESULT", ""); profit = os.environ.get("PROFIT", "")
    if not ID_RE.fullmatch(bid): die("bad bet_id format", 2)
    if result not in ("won", "lost", "void"): die("result must be won, lost or void", 2)
    if profit and not PROFIT_RE.fullmatch(profit): die("profit must be a positive number with up to 2 decimals", 2)
    with lock():
        rows, cols = LG.load_bets(); led = LG.load_ledger()
        m = [r for r in rows if r["bet_id"] == bid]
        if not m:
            for a in archive_rows():
                if a.get("bet_id") == bid: already(bid, result, a.get("result"))
            die(f"no open bet with id {bid}")
        r = m[0]
        if r["result"].strip().lower() not in ("open", "") or r["settled_at"]:
            already(bid, result, r["result"])
        pnl = None
        if result == "won" and LG.num(r["to_win"]) == 0:
            if not profit or float(profit) <= 0: die(f"{bid}: to_win unknown, a profit amount is required for a win")
            pnl = float(profit)
        if "settled_by" not in cols: cols.append("settled_by")
        for x in rows: x.setdefault("settled_by", "")
        if not LG.settle(rows, led, r, result, pnl=pnl): die(f"{bid}: ledger refused the settle")
        r["settled_by"] = "manual"
        LG.save_bets(rows, cols); LG.write_balances(led)
        print(f"manual settle OK: {bid} {r['book']} | {r['pick'][:60]} -> {result}, pnl {LG.num(r['pnl']):+.2f}")

if __name__ == "__main__":
    main()
