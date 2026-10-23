#!/usr/bin/env python3
"""Build every user's data/stats/log/archive JSON from Supabase and store it in `snapshots` (phase 2).

  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/publish_snapshots.py [--user EMAIL] [--no-network] [--dry]

For each user: export bets/ledger/recommendations to a temp dir in the CSV layout the existing generators read,
run them with BETS_ROOT pointing there, upload the four JSON payloads. Service key comes from the environment only.
"""
import datetime, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from supa import api, export
KINDS = {"data": "data.json", "stats": "stats.json", "log": "log.json", "archive": "archive.json"}

def build_for(uid, label, args):
    with tempfile.TemporaryDirectory() as root:
        ex = export(uid, root); n = (sum(1 for b in ex["bets"].values() if not b["archived"]), sum(1 for b in ex["bets"].values() if b["archived"]), ex["ledger_n"])
        env = dict(os.environ, BETS_ROOT=root, BETS_LOCK=os.path.join(root, "lock"))
        env.pop("SUPABASE_SERVICE_KEY", None)  # build scripts never need it
        subprocess.run([sys.executable, "-c", "import sys;sys.path.insert(0,%r);import ledger;ledger.write_balances(ledger.load_ledger())" % HERE], env=env, check=True)
        subprocess.run([sys.executable, os.path.join(HERE, "build.py")] + (["--static"] if "--no-network" in args else []), env=env, check=True)
        out = {}
        for kind, fn in KINDS.items():
            p = os.path.join(root, fn)
            if os.path.exists(p):
                with open(p) as f: out[kind] = json.load(f)
        print(f"{label}: live {n[0]} archived {n[1]} ledger {n[2]} -> {sorted(out)}")
        if "--dry" in args: return out
        api("POST", "/rest/v1/snapshots?on_conflict=user_id,kind",
            [{"user_id": uid, "kind": k, "payload": v, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()} for k, v in out.items()],
            {"Prefer": "resolution=merge-duplicates"})
        return out

def main(args):
    want = args[args.index("--user") + 1].lower() if "--user" in args else None
    users = api("GET", "/auth/v1/admin/users?per_page=200")["users"]
    ids = {u["id"]: u.get("email", u["id"]) for u in users}
    for p in api("GET", "/rest/v1/profiles?select=user_id"):
        uid = p["user_id"]
        if want and ids.get(uid, "").lower() != want: continue
        build_for(uid, ids.get(uid, uid), args)

if __name__ == "__main__": main(sys.argv[1:])
