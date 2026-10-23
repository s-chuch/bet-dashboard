#!/usr/bin/env python3
"""Build every user's data/stats/log/archive JSON from Supabase and store it in `snapshots` (phase 2).

  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/publish_snapshots.py [--user EMAIL] [--no-network] [--dry]

For each user: export bets/ledger/recommendations to a temp dir in the CSV layout the existing generators read,
run them with BETS_ROOT pointing there, upload the four JSON payloads. Service key comes from the environment only.
"""
import csv, datetime, json, os, subprocess, sys, tempfile, urllib.request, urllib.error, collections
HERE = os.path.dirname(os.path.abspath(__file__))
BET_COLS = "date,book,event,start_et,market,pick,price,boosted_price,stake,to_win,fair_pct,ev_pct,result,pnl,bet_id,settled_at,settled_by".split(",")
LED_COLS = "ts_et,book,bet_id,event_type,amount,note".split(",")
REC_COLS = "rec_id,rec_date,rec_time_et,sport,event,game_start_et,market,selection,book,rec_price,eff_price,fair_pct,ev_pct,stake,promo,friend,placed,bet_ids,result,final_score,source,notes".split(",")
KINDS = {"data": "data.json", "stats": "stats.json", "log": "log.json", "archive": "archive.json"}

def api(method, path, body=None, extra=None):
    base, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"]
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}; h.update(extra or {})
    req = urllib.request.Request(base + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            t = r.read().decode(); return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}")

def fetch_all(table, uid, order):
    out, n = [], 0
    while True:
        part = api("GET", f"/rest/v1/{table}?user_id=eq.{uid}&select=*&order={order}&limit=1000&offset={n}")
        out += part; n += 1000
        if len(part) < 1000: return out

def val(v): return "" if v is None else (str(v) if not isinstance(v, float) else repr(v))
def write(path, cols, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, cols); w.writeheader()
        for r in rows: w.writerow({c: val(r.get(c)) for c in cols})

def export(uid, root):
    bets = fetch_all("bets", uid, "date.asc,bet_id.asc")
    rows = [dict(b, stake=b["stake_text"]) for b in bets]
    live = [r for r in rows if not r["archived"]]
    write(os.path.join(root, "data", "bets.csv"), BET_COLS, live)
    by_month = collections.defaultdict(list)
    for r in rows:
        if r["archived"]: by_month[r["date"][:7]].append(r)
    for m, rs in by_month.items(): write(os.path.join(root, "data", "archive", f"bets-{m}.csv"), BET_COLS, rs)
    led = fetch_all("ledger", uid, "id.asc")
    write(os.path.join(root, "data", "ledger.csv"), LED_COLS, led)
    recs = [dict(r["row"]) for r in fetch_all("recommendations", uid, "rec_id.asc")]
    write(os.path.join(root, "data", "recommendations.csv"), REC_COLS, recs)
    return len(live), len(rows) - len(live), len(led)

def build_for(uid, label, args):
    with tempfile.TemporaryDirectory() as root:
        n = export(uid, root)
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
