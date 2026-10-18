#!/usr/bin/env python3
"""Append-only sportsbook ledger -> balances.csv.

Balance(book) = latest anchor amount + sum(stake/return/adjust events after that anchor).
Every bet event is keyed (bet_id, event_type); writing the same key twice is a no-op.

  python3 ledger.py show
  python3 ledger.py sync                         # safe to run any number of times
  python3 ledger.py place <bet_id>               # deduct stake (no-op if already applied)
  python3 ledger.py settle <bet_id> won|lost|push|void|cashout [--cashout X] [--pnl X]
  python3 ledger.py anchor BOOK AMT "note"       # app balance from Shawn; resets that book
  python3 ledger.py adjust BOOK AMT "note"       # manual +/- correction (deposit, withdrawal, bonus)
  python3 ledger.py log date=.. book=.. event=.. start_et=.. market=.. pick=.. price=.. stake=.. to_win=.. [..] [--force]
                                                 # append a bet row (duplicate guard) + deduct stake
  python3 ledger.py dupes                        # duplicate audit of bets.csv
"""
import csv, sys, os, re, hashlib, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import LEDGER, BAL, BETS, lock, now_et
LCOLS = ["ts_et", "book", "bet_id", "event_type", "amount", "note"]
BASE = ["date", "book", "event", "start_et", "market", "pick", "price", "boosted_price", "stake", "to_win",
        "fair_pct", "ev_pct", "result", "pnl"]
SETTLED = {"won", "lost", "push", "void", "cashout"}

def now(): return now_et().strftime("%Y-%m-%d %H:%M")
def num(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "")); return float(m[0]) if m else 0.0

# ---------- bets.csv ----------
def load_bets():
    with open(BETS, newline="") as f:
        rd = csv.DictReader(f); rows = list(rd); cols = list(rd.fieldnames)
    for c in ("bet_id", "settled_at"):
        if c not in cols: cols.append(c)
    for r in rows:
        for c in cols: r.setdefault(c, "")
        for k in list(r):
            if r[k] is None: r[k] = ""
    return rows, cols

def save_bets(rows, cols):
    tmp = BETS + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, cols, extrasaction="ignore"); w.writeheader(); w.writerows(rows)
    os.replace(tmp, BETS)

def make_id(r):
    key = "|".join(r.get(k, "").strip().lower() for k in ("date", "book", "event", "pick", "stake", "price"))
    return hashlib.sha1(key.encode()).hexdigest()[:8]

def assign_ids(rows):
    used = {r["bet_id"] for r in rows if r["bet_id"]}; n = 0
    for r in rows:
        if r["bet_id"]: continue
        base = make_id(r); bid = base; k = 2
        while bid in used: bid = f"{base}-{k}"; k += 1
        r["bet_id"] = bid; used.add(bid); n += 1
    return n

def is_bonus(r):
    return "bonus" in r["stake"].lower() or bool(re.search(r"bonus bet|free bet|no sweat token", r["market"], re.I))

def dup_key(r):
    ev = re.sub(r"[^a-z0-9]", "", re.sub(r"\([^)]*\)", "", r["event"].lower()))
    pk = re.sub(r"[^a-z0-9]", "", r["pick"].lower())
    return (r["book"].strip().lower(), ev, pk, f"{num(r['stake']):.2f}")

# ---------- ledger ----------
def load_ledger():
    if not os.path.exists(LEDGER): return []
    with open(LEDGER, newline="") as f: return list(csv.DictReader(f))

def append(ev):
    new = not os.path.exists(LEDGER)
    with open(LEDGER, "a", newline="") as f:
        w = csv.DictWriter(f, LCOLS)
        if new: w.writeheader()
        w.writerow({k: ev.get(k, "") for k in LCOLS})

def has(led, bet_id, etype): return any(e["bet_id"] == bet_id and e["event_type"] == etype for e in led)

def apply_event(led, book, bet_id, etype, amount, note):
    """Idempotent on (bet_id, event_type). Returns True if written."""
    if bet_id and has(led, bet_id, etype): return False
    ev = dict(ts_et=now(), book=book, bet_id=bet_id, event_type=etype, amount=f"{amount:.2f}", note=note)
    append(ev); led.append(ev); return True

def balances(led):
    out = {}
    for e in led:  # file order == time order (append-only)
        b = out.setdefault(e["book"], {"bal": None, "ts": "", "note": ""})
        if e["event_type"] == "anchor":
            b.update(bal=float(e["amount"]), ts=e["ts_et"], note=e["note"])
        elif b["bal"] is not None:
            a = float(e["amount"])
            b["bal"] += a
            if a: b.update(ts=e["ts_et"], note=f"{e['event_type']} {a:+.2f} ({e['bet_id'] or e['note']})")
    return out

def write_balances(led):
    order = []
    if os.path.exists(BAL):
        with open(BAL) as f: order = [r["book"] for r in csv.DictReader(f)]
    bal = balances(led)
    books = order + [b for b in bal if b not in order]
    with open(BAL, "w", newline="") as f:
        w = csv.DictWriter(f, ["book", "balance_cad", "updated_et", "note"]); w.writeheader()
        for b in books:
            if b in bal and bal[b]["bal"] is not None:
                w.writerow(dict(book=b, balance_cad=f"{bal[b]['bal']:.2f}", updated_et=bal[b]["ts"], note=bal[b]["note"]))
    return bal

# ---------- operations ----------
def place(rows, led, r):
    if is_bonus(r):
        return apply_event(led, r["book"], r["bet_id"], "stake", 0.0, "bonus bet token, no cash deducted")
    return apply_event(led, r["book"], r["bet_id"], "stake", -num(r["stake"]), "stake")

def settle_amount(r, result, cashout=None):
    stake, profit, bonus = num(r["stake"]), num(r["to_win"]), is_bonus(r)
    if result == "won": return (profit if bonus else stake + profit), (profit)
    if result in ("push", "void"): return (0.0 if bonus else stake), 0.0
    if result == "cashout": return float(cashout), float(cashout) - (0 if bonus else stake)
    return 0.0, (0.0 if bonus else -stake)  # lost

def settle(rows, led, r, result, cashout=None, pnl=None, force_result=False):
    """force_result=True: row already carries its result (sync path)."""
    if r["settled_at"] or has(led, r["bet_id"], "return") or has(led, r["bet_id"], "settled"):
        print(f"already settled: {r['bet_id']} {r['book']} {r['pick'][:50]}"); return False
    if not force_result and r["result"].strip().lower() not in ("open", ""):
        print(f"already settled: {r['bet_id']} result={r['result']}"); return False
    if result == "won" and num(r["to_win"]) == 0 and pnl is None:
        print(f"REFUSED {r['bet_id']}: won but to_win unknown; pass --pnl X"); return False
    if result == "cashout" and cashout is None:
        print(f"REFUSED {r['bet_id']}: cashout needs --cashout X"); return False
    place(rows, led, r)  # make sure the stake is on the ledger first (no-op if already)
    ret, p = settle_amount(r, result, cashout)
    if pnl is not None:
        p = float(pnl)
        if result == "won": ret = p if is_bonus(r) else num(r["stake"]) + p
    if ret: apply_event(led, r["book"], r["bet_id"], "return", ret, result)
    else: apply_event(led, r["book"], r["bet_id"], "settled", 0.0, f"{result}, no return")
    if not force_result or not r["pnl"]:
        r["pnl"] = f"{p:.2f}"
    r["result"] = result; r["settled_at"] = now()
    return True

def sync(quiet=False):
    rows, cols = load_bets(); led = load_ledger()
    n_ids = assign_ids(rows); n_st = n_se = 0
    for r in rows:
        if r["settled_at"] == "pre-ledger": continue
        res = r["result"].strip().lower()
        if not has(led, r["bet_id"], "stake"): n_st += place(rows, led, r)
        if res in SETTLED and not r["settled_at"]:
            cash = num(r["pnl"]) + num(r["stake"]) if res == "cashout" else None
            pnl = num(r["pnl"]) if (res == "won" and r["pnl"].strip()) else None
            n_se += settle(rows, led, r, res, cashout=cash, pnl=pnl, force_result=True)
    seen = {}
    for r in rows:
        k = dup_key(r)
        if k in seen: print(f"WARNING possible duplicate: {seen[k]} and {r['bet_id']} ({r['book']} {r['pick'][:40]})")
        else: seen[k] = r["bet_id"]
    save_bets(rows, cols); bal = write_balances(led)
    if not quiet or n_ids or n_st or n_se:
        print(f"sync: {n_ids} new ids, {n_st} stake events, {n_se} settlements")
    return bal

def show():
    bal = balances(load_ledger()); tot = 0
    for b, v in bal.items():
        if v["bal"] is None: continue
        tot += v["bal"]; print(f"{b:<12} ${v['bal']:>9.2f}  {v['ts']}  {v['note']}")
    print(f"{'TOTAL':<12} ${tot:>9.2f}")

def find(rows, bid):
    m = [r for r in rows if r["bet_id"] == bid]
    if not m: sys.exit(f"no bet_id {bid}")
    return m[0]

def main(a):
    if not a or a[0] == "show": show(); return
    cmd = a[0]
    if cmd == "sync": sync(); show(); return
    if cmd in ("anchor", "adjust"):
        book, amt, note = a[1], float(a[2]), " ".join(a[3:])
        led = load_ledger()
        canon = next((e["book"] for e in led if e["book"].lower() == book.lower()), book)
        apply_event(led, canon, "", cmd, amt, note); write_balances(led); show(); return
    if cmd == "dupes":
        rows, _ = load_bets(); seen = {}
        for i, r in enumerate(rows, 2):
            seen.setdefault(dup_key(r), []).append(i)
        d = [v for v in seen.values() if len(v) > 1]
        print("duplicate rows (book+event+pick+stake):", d or "none"); return
    rows, cols = load_bets(); led = load_ledger(); assign_ids(rows)
    if cmd == "place":
        r = find(rows, a[1]); print("applied" if place(rows, led, r) else "already applied (no-op)")
    elif cmd == "settle":
        r = find(rows, a[1]); res = a[2].lower()
        if res not in SETTLED: sys.exit("result must be won|lost|push|void|cashout")
        opt = lambda k: float(a[a.index(k) + 1]) if k in a else None
        if settle(rows, led, r, res, cashout=opt("--cashout"), pnl=opt("--pnl")):
            print(f"settled {r['bet_id']} {res} pnl {r['pnl']}")
    elif cmd == "log":
        kv = dict(x.split("=", 1) for x in a[1:] if "=" in x)
        r = {c: "" for c in cols}; r.update(kv); r.setdefault("result", "open"); r["result"] = r["result"] or "open"
        k = dup_key(r); clash = [x for x in rows if dup_key(x) == k]
        if clash and "--force" not in a:
            print(f"REJECTED duplicate: matches {clash[0]['bet_id']} ({clash[0]['book']} | {clash[0]['event']} | "
                  f"{clash[0]['pick']} | ${clash[0]['stake']}). Re-run with --force if it really is a second bet."); sys.exit(2)
        rows.append(r); assign_ids(rows); place(rows, led, r); print(f"logged {r['bet_id']}")
    else: sys.exit(__doc__)
    save_bets(rows, cols); write_balances(led); show()

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] in ("show", "dupes"): main(a)
    else:
        with lock(): main(a)
