#!/usr/bin/env python3
"""Send a bet from the bot box to Supabase (replaces `ledger.py log` + CSV commit once an account is cut over).

  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... OWNER_EMAIL=you@example.com \
    python3 scripts/box_add.py date=2026-10-23 book=FanDuel event="A @ B" start_et="" market=Moneyline pick="A ML" \
        price=+120 [boosted_price=+150] stake=2.00 to_win=2.40 [result=won] [--force]
  python3 scripts/box_add.py --json bets.json          # a JSON array of such objects (max 30)

Same keys as ledger.py log. The row goes into the `requests` queue; the process-requests Action applies it with add_bets.py
(same validation, duplicate guard and ledger rules), usually within 5 minutes. --wait polls until it is done or failed.
Prints the request id. Exit 0 = queued (or applied with --wait), 1 = failed, 2 = bad input. Service key from env only.
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supa

def die(m, c=2): print("REFUSED: " + m, flush=True); sys.exit(c)

def main(a):
    force = "--force" in a
    if "--json" in a:
        bets = json.load(open(a[a.index("--json") + 1]))
    else:
        kv = dict(x.split("=", 1) for x in a if "=" in x and not x.startswith("--"))
        if not kv: die("no key=value fields given")
        bets = [kv]
    if not isinstance(bets, list) or not 1 <= len(bets) <= 30: die("send 1 to 30 bets")
    if force:
        for b in bets: b["force"] = "1"
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "OWNER_EMAIL"):
        if not os.environ.get(k): die(f"{k} is not set")
    email = os.environ["OWNER_EMAIL"].lower()
    uid = next((u["id"] for u in supa.api("GET", "/auth/v1/admin/users?per_page=200")["users"] if u.get("email", "").lower() == email), None)
    if not uid: die(f"no account for {email}")
    row = supa.api("POST", "/rest/v1/requests", [{"user_id": uid, "kind": "add_bets", "payload": {"bets": json.dumps(bets)}}], {"Prefer": "return=representation"})[0]
    print(f"queued request {row['id']} ({len(bets)} bet(s))", flush=True)
    if "--wait" not in a: return 0
    for _ in range(90):
        time.sleep(10)
        r = supa.api("GET", f"/rest/v1/requests?id=eq.{row['id']}&select=status,message")[0]
        if r["status"] in ("done", "failed"):
            print(f"{r['status']}: {r['message']}"); return 0 if r["status"] == "done" else 1
    print("still pending after 15 min; check the process-requests Action"); return 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
