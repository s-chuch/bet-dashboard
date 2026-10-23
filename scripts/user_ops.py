#!/usr/bin/env python3
"""Run one user's queued requests, then one settle/build pass, inside a BETS_ROOT temp dir (called by process_requests.py).

  BETS_ROOT=<dir with data/*.csv> python3 scripts/user_ops.py <ops.json> <out.json> [--settle]

ops.json: [{"id": 7, "kind": "add_bets|manual_settle|set_balance", "payload": {...}}]. Each op runs the same code the CSV
workflows run (add_bets.py, manual_settle.py, set_balance.py), so validation and ledger rules are unchanged.
out.json: {"results": [{"id", "ok", "message"}], "settled": n}.
"""
import sys, os, io, json, contextlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import common
assert os.environ.get("BETS_ROOT"), "BETS_ROOT must point at the per-user export"
common.SKIPS_ROOT = os.path.join(os.environ["BETS_ROOT"], "data", "finder_skips.csv")

def run_main(fn, env):
    """Call a script's main() with env vars set, capture stdout, return (exit_code, last output line)."""
    old = {k: os.environ.get(k) for k in env}; os.environ.update(env)
    buf = io.StringIO(); code = 0
    try:
        with contextlib.redirect_stdout(buf): fn()
    except SystemExit as e: code = e.code if isinstance(e.code, int) else 1
    finally:
        for k, v in old.items():
            if v is None: os.environ.pop(k, None)
            else: os.environ[k] = v
    lines = [l for l in buf.getvalue().splitlines() if l.strip()]
    msg = next((l for l in reversed(lines) if l.startswith(("summary:", "manual settle OK", "set balance OK", "REFUSED", "::error::"))), lines[-1] if lines else "")
    return code, msg.replace("::error::", "")

def apply(op):
    kind, p = op["kind"], op.get("payload") or {}
    if kind == "add_bets":
        import add_bets
        add_bets.SKIPS = common.SKIPS_ROOT
        bets = p.get("bets")
        code, msg = run_main(add_bets.main, {"BETS_JSON": bets if isinstance(bets, str) else json.dumps(bets)})
        return code == 0, msg
    if kind == "manual_settle":
        import manual_settle
        code, msg = run_main(manual_settle.main, {"BET_ID": str(p.get("bet_id", "")), "RESULT": str(p.get("result", "")), "PROFIT": str(p.get("profit", "") or "")})
        return code in (0, 3), msg
    if kind == "set_balance":
        import set_balance, add_bets
        set_balance.BOOKS = tuple(add_bets.BOOKS)      # any known sportsbook, not only the owner's seven
        code, msg = run_main(set_balance.main, {"BOOK": str(p.get("book", "")), "AMOUNT": str(p.get("amount", "")), "NOTE": str(p.get("note", "") or "")})
        return code == 0, msg
    return False, f"unknown request kind {kind}"

def main():
    ops = json.load(open(sys.argv[1])); out = {"results": [], "settled": 0}
    for op in ops:
        try: ok, msg = apply(op)
        except Exception as e: ok, msg = False, f"{type(e).__name__}: {e}"[:300]
        out["results"].append({"id": op["id"], "ok": bool(ok), "message": msg[:300]})
    if "--settle" in sys.argv or ops:
        import ledger as LG, autorun
        if not ops and "--settle" in sys.argv: pass
        with common.lock(): code = autorun.run(False, fast=False)
        out["autorun_code"] = code
    json.dump(out, open(sys.argv[2], "w"))

if __name__ == "__main__": main()
