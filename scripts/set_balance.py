#!/usr/bin/env python3
"""Set a fresh balance snapshot (anchor) for ONE book (run by .github/workflows/set-balance.yml; safe by hand).

Inputs come from the environment only (never from the command line or a shell string):
  BOOK    one of the seven books below
  AMOUNT  the app's cash balance in CAD, e.g. 123.45 (0 to 100000, up to 2 decimals)
  NOTE    optional short text, [A-Za-z0-9 .,:()#/+-], max 80 chars

Does exactly what `ledger.py anchor BOOK AMT "note"` does (it calls ledger.main), so later
stake/return/adjust events apply on top of the new anchor. Never touches bets.csv.
Exit 0 = anchored, 2 = bad input.
"""
import sys, os, re, io, contextlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import lock
import ledger as LG

BOOKS = ("PointsBet", "bet365", "FanDuel", "DraftKings", "theScore", "Caesars", "Hard Rock")
AMOUNT_RE = re.compile(r"[0-9]+(\.[0-9]{1,2})?")
NOTE_RE = re.compile(r"[A-Za-z0-9 .,:()#/+-]{0,80}")

def die(msg, code=2):
    print(f"::error::set balance refused: {msg}" if os.environ.get("GITHUB_ACTIONS") else f"REFUSED: {msg}", flush=True)
    sys.exit(code)

def main():
    book = os.environ.get("BOOK", ""); amount = os.environ.get("AMOUNT", ""); note = os.environ.get("NOTE", "")
    if book not in BOOKS: die("unknown book")
    if not AMOUNT_RE.fullmatch(amount) or float(amount) > 100000: die("amount must be 0-100000 with up to 2 decimals")
    if not NOTE_RE.fullmatch(note): die("bad note")
    amt = float(amount)
    text = f"set from Logs page: app balance {amount}" + (f" - {note}" if note.strip() else "")
    with lock():
        led = LG.load_ledger()
        old = (LG.balances(led).get(book) or {}).get("bal")
        with contextlib.redirect_stdout(io.StringIO()):   # ledger.show() is noisy
            LG.main(["anchor", book, f"{amt:.2f}", text])
        new = (LG.balances(LG.load_ledger()).get(book) or {}).get("bal")
    if old is None:
        print(f"set balance OK: {book} tracker had no balance -> {new:.2f}")
    else:
        print(f"set balance OK: {book} tracker {old:.2f} -> {new:.2f} (app minus tracker {new - old:+.2f})")

if __name__ == "__main__":
    main()
