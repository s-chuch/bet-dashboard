#!/usr/bin/env python3
"""Server side of the multi-user app: apply queued requests, settle finished games, publish snapshots (phases 3 + 4).

  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/process_requests.py [--settle] [--user EMAIL] [--no-network]

Per user: export their rows to a temp dir -> user_ops.py (their pending requests, then autorun settle+build, ESPN finals only)
-> write changes back to bets/ledger/recommendations/skips -> mark requests done/failed -> store data/stats/log/archive snapshots.
Without --settle only users with pending requests are touched; with --settle every user flagged rules.cutover is too.
"""
import datetime, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import supa
KINDS = {"data": "data.json", "stats": "stats.json", "log": "log.json", "archive": "archive.json"}

def mark(rid, status, msg=None):
    supa.api("PATCH", f"/rest/v1/requests?id=eq.{rid}", {"status": status, "message": (msg or "")[:300] or None,
             "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat() if status in ("done", "failed") else None})

def process_user(uid, label, reqs, args):
    with tempfile.TemporaryDirectory() as root:
        before = supa.export(uid, root)
        for r in reqs: mark(r["id"], "running")
        ops, out = os.path.join(root, "ops.json"), os.path.join(root, "out.json")
        json.dump([{"id": r["id"], "kind": r["kind"], "payload": r["payload"]} for r in reqs], open(ops, "w"))
        env = dict(os.environ, BETS_ROOT=root, BETS_LOCK=os.path.join(root, "lock")); env.pop("SUPABASE_SERVICE_KEY", None)
        cmd = [sys.executable, os.path.join(HERE, "user_ops.py"), ops, out] + (["--settle"] if "--settle" in args else [])
        p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=900)
        res = json.load(open(out)) if os.path.exists(out) else {"results": [{"id": r["id"], "ok": False, "message": "worker crashed: " + p.stderr[-200:]} for r in reqs]}
        print(f"{label}: ops {len(reqs)}, autorun_code {res.get('autorun_code')}")
        if p.returncode != 0 or not os.path.exists(out):
            for r in res["results"]: mark(r["id"], "failed", r["message"])
            print(p.stdout[-800:], p.stderr[-800:]); return
        written = supa.sync_back(uid, root, before)   # data first, then tell the page it is done
        for r in res["results"]: mark(r["id"], "done" if r["ok"] else "failed", r["message"])
        snaps = []
        for kind, fn in KINDS.items():
            path = os.path.join(root, fn)
            if os.path.exists(path):
                snaps.append({"user_id": uid, "kind": kind, "payload": json.load(open(path)), "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        if snaps: supa.api("POST", "/rest/v1/snapshots?on_conflict=user_id,kind", snaps, {"Prefer": "resolution=merge-duplicates"})
        print(f"{label}: wrote {written}, snapshots {[s['kind'] for s in snaps]}")

def main(args):
    want = args[args.index("--user") + 1].lower() if "--user" in args else None
    ids = {u["id"]: u.get("email", u["id"]) for u in supa.api("GET", "/auth/v1/admin/users?per_page=200")["users"]}
    pending = supa.api("GET", "/rest/v1/requests?status=in.(pending,running)&order=id.asc&limit=200") or []
    by = {}
    for r in pending: by.setdefault(r["user_id"], []).append(r)
    if "--settle" in args:
        for p in supa.api("GET", "/rest/v1/profiles?select=user_id,rules") or []:
            if (p.get("rules") or {}).get("cutover"): by.setdefault(p["user_id"], [])
    for uid, reqs in by.items():
        if want and ids.get(uid, "").lower() != want: continue
        try: process_user(uid, ids.get(uid, uid), reqs, args)
        except Exception as e:
            print(f"{ids.get(uid, uid)}: FAILED {e}")
            for r in reqs: mark(r["id"], "failed", f"server error: {e}")
    if not by: print("nothing to do")

if __name__ == "__main__": main(sys.argv[1:])
