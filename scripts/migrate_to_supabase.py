#!/usr/bin/env python3
"""One-time import of the owner's data/*.csv into Supabase (phase 1).

  SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=... OWNER_EMAIL=you@example.com \
    python3 scripts/migrate_to_supabase.py [--apply]

Dry run by default: prints row counts and balance totals so they can be compared with data.json.
The service key is read from the environment only; never commit it or put it in the frontend.
"""
import csv, glob, json, os, re, sys, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

BONUS = re.compile(r"bonus|free bet|no sweat token", re.I)

def rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def load():
    bets = [(r, False) for r in rows(common.BETS)]
    for p in sorted(glob.glob(os.path.join(common.ARCHIVE_DIR, "bets-*.csv"))):
        bets += [(r, True) for r in rows(p)]
    out = []
    for r, arch in bets:
        out.append({"bet_id": r["bet_id"], "date": r["date"], "book": r["book"], "event": r["event"],
                    "start_et": r["start_et"] or None, "market": r["market"] or None, "pick": r["pick"],
                    "price": r["price"] or None, "boosted_price": r["boosted_price"] or None,
                    "stake_text": r["stake"], "is_bonus": bool(BONUS.search(r["stake"] + " " + r["market"])),
                    "to_win": num(r["to_win"]), "fair_pct": num(r["fair_pct"]), "ev_pct": num(r["ev_pct"]),
                    "result": r["result"] or "open", "pnl": num(r["pnl"]), "settled_at": r["settled_at"] or None,
                    "settled_by": r["settled_by"] or None, "archived": arch})
    ledger = [{"ts_et": r["ts_et"], "book": r["book"], "bet_id": r["bet_id"] or None,
               "event_type": r["event_type"], "amount": num(r["amount"]) or 0, "note": r["note"] or None}
              for r in rows(common.LEDGER)]
    recs = [{"rec_id": r["rec_id"], "row": r} for r in rows(common.RECS) if r.get("friend", "").strip().lower() not in ("yes", "y", "true", "1")]
    books = sorted({b["book"] for b in out} | {l["book"] for l in ledger})
    return out, ledger, recs, [{"book": b} for b in books]

def call(base, key, method, path, body=None, extra=None):
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    h.update(extra or {})
    req = urllib.request.Request(base + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}")

def main():
    apply = "--apply" in sys.argv
    bets, ledger, recs, books = load()
    bal = {}
    for l in ledger:  # same replay as ledger.balances(): anchor resets, later events add
        if l["event_type"] == "anchor": bal[l["book"]] = l["amount"]
        elif l["book"] in bal: bal[l["book"]] += l["amount"]
    bal = {k: round(v, 2) for k, v in bal.items()}
    print(f"bets {len(bets)} (archived {sum(b['archived'] for b in bets)}), ledger {len(ledger)}, "
          f"recs {len(recs)} (friend rows dropped), books {len(books)}")
    print("ledger balances:", json.dumps(bal), "total", round(sum(bal.values()), 2))
    print("pnl total:", round(sum(b["pnl"] or 0 for b in bets), 2))
    if not apply: print("dry run; pass --apply to write"); return
    base, key, email = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"], os.environ["OWNER_EMAIL"]
    users = call(base, key, "GET", "/auth/v1/admin/users?per_page=200")["users"]
    uid = next((u["id"] for u in users if u.get("email", "").lower() == email.lower()), None)
    if not uid: sys.exit(f"no auth user for {email}; invite/sign in once first")
    call(base, key, "POST", "/rest/v1/profiles", [{"user_id": uid, "display_name": "Shawn",
         "slip_owner_names": ["Shawn", "Chu Cheong", "charles123", "s-chuch"]}],
         {"Prefer": "resolution=merge-duplicates"})
    for table, data in (("books", books), ("bets", bets), ("recommendations", recs)):
        for i in range(0, len(data), 200):
            call(base, key, "POST", f"/rest/v1/{table}", [dict(d, user_id=uid) for d in data[i:i+200]],
                 {"Prefer": "resolution=merge-duplicates"})
    have = call(base, key, "GET", f"/rest/v1/ledger?user_id=eq.{uid}&select=id&limit=1")
    if have: print("ledger already has rows; skipping ledger insert (append-only, would duplicate)")
    else:
        for i in range(0, len(ledger), 200):
            call(base, key, "POST", "/rest/v1/ledger", [dict(d, user_id=uid) for d in ledger[i:i+200]])
    print("done; compare balances view with the totals above")

if __name__ == "__main__": main()
