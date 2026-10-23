"""Supabase helpers shared by the server-side scripts (publish_snapshots, process_requests). Service key from env only."""
import csv, json, os, re, sys, urllib.request, urllib.error, collections, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
BET_COLS = "date,book,event,start_et,market,pick,price,boosted_price,stake,to_win,fair_pct,ev_pct,result,pnl,bet_id,settled_at,settled_by".split(",")
LED_COLS = "ts_et,book,bet_id,event_type,amount,note".split(",")
REC_COLS = "rec_id,rec_date,rec_time_et,sport,event,game_start_et,market,selection,book,rec_price,eff_price,fair_pct,ev_pct,stake,promo,friend,placed,bet_ids,result,final_score,source,notes".split(",")
SKIP_COLS = ["date_et", "ts_et", "key", "book", "reason"]
BONUS = re.compile(r"bonus|free bet|no sweat token", re.I)

def api(method, path, body=None, extra=None):
    base, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"]
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}; h.update(extra or {})
    req = urllib.request.Request(base + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            t = r.read().decode(); return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}")

def fetch_all(table, uid, order):
    out, n = [], 0
    while True:
        part = api("GET", f"/rest/v1/{table}?user_id=eq.{uid}&select=*&order={order}&limit=1000&offset={n}")
        out += part; n += 1000
        if len(part) < 1000: return out

def val(v): return "" if v is None else (repr(v) if isinstance(v, float) else str(v))
def write_csv(path, cols, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, cols); w.writeheader()
        for r in rows: w.writerow({c: val(r.get(c)) for c in cols})
def read_csv(path):
    if not os.path.exists(path): return []
    with open(path, newline="") as f: return [{k: (v or "") for k, v in r.items()} for r in csv.DictReader(f)]
def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def bet_from_row(r, archived):
    return {"bet_id": r["bet_id"], "date": r["date"], "book": r["book"], "event": r["event"], "start_et": r["start_et"] or None,
            "market": r["market"] or None, "pick": r["pick"], "price": r["price"] or None, "boosted_price": r["boosted_price"] or None,
            "stake_text": r["stake"], "is_bonus": bool(BONUS.search(r["stake"] + " " + r["market"])), "to_win": num(r["to_win"]),
            "fair_pct": num(r["fair_pct"]), "ev_pct": num(r["ev_pct"]), "result": r["result"] or "open", "pnl": num(r["pnl"]),
            "settled_at": r["settled_at"] or None, "settled_by": r["settled_by"] or None, "archived": archived}

def export(uid, root):
    """Write the user's Supabase rows as the CSV layout the existing scripts read. Returns a snapshot of what was exported."""
    bets = fetch_all("bets", uid, "date.asc,bet_id.asc")
    rows = [dict(b, stake=b["stake_text"]) for b in bets]
    write_csv(os.path.join(root, "data", "bets.csv"), BET_COLS, [r for r in rows if not r["archived"]])
    months = collections.defaultdict(list)
    for r in rows:
        if r["archived"]: months[r["date"][:7]].append(r)
    for m, rs in months.items(): write_csv(os.path.join(root, "data", "archive", f"bets-{m}.csv"), BET_COLS, rs)
    led = fetch_all("ledger", uid, "id.asc")
    write_csv(os.path.join(root, "data", "ledger.csv"), LED_COLS, led)
    recs = [dict(r["row"]) for r in fetch_all("recommendations", uid, "rec_id.asc")]
    write_csv(os.path.join(root, "data", "recommendations.csv"), REC_COLS, recs)
    skips = fetch_all("skips", uid, "day.asc")
    write_csv(os.path.join(root, "data", "finder_skips.csv"), SKIP_COLS,
              [{"date_et": s["day"], "ts_et": s["day"] + " 00:00", "key": s["rec_key"], "book": "", "reason": s["reason"]} for s in skips])
    return {"bets": {b["bet_id"]: bet_from_row(dict(b, stake=b["stake_text"]), b["archived"]) for b in bets},
            "ledger_n": len(led), "recs": {r["rec_id"]: r for r in recs}, "skips": {s["rec_key"] for s in skips}}

def current_bets(root):
    import glob
    out = {}
    for r in read_csv(os.path.join(root, "data", "bets.csv")):
        if r["bet_id"]: out[r["bet_id"]] = bet_from_row(r, False)
    for p in sorted(glob.glob(os.path.join(root, "data", "archive", "bets-*.csv"))):
        for r in read_csv(p):
            if r["bet_id"] and r["bet_id"] not in out: out[r["bet_id"]] = bet_from_row(r, True)
    return out

def post(table, uid, rows, upsert=True):
    for i in range(0, len(rows), 200):
        api("POST", f"/rest/v1/{table}", [dict(d, user_id=uid) for d in rows[i:i + 200]],
            {"Prefer": "resolution=merge-duplicates"} if upsert else None)

def sync_back(uid, root, before):
    """Push what the scripts changed in the temp dir back to Supabase: changed/new bets, ledger rows appended, recs, skips."""
    now = current_bets(root)
    changed = [b for k, b in now.items() if before["bets"].get(k) != b]
    post("bets", uid, changed)
    led = read_csv(os.path.join(root, "data", "ledger.csv"))
    new = led[before["ledger_n"]:]
    post("ledger", uid, [{"ts_et": e["ts_et"], "book": e["book"], "bet_id": e["bet_id"] or None, "event_type": e["event_type"],
                          "amount": num(e["amount"]) or 0, "note": e["note"] or None} for e in new], upsert=False)
    recs = [r for r in read_csv(os.path.join(root, "data", "recommendations.csv")) if r["rec_id"] and before["recs"].get(r["rec_id"]) != r]
    post("recommendations", uid, [{"rec_id": r["rec_id"], "row": r} for r in recs])
    sk = [s for s in read_csv(os.path.join(root, "data", "finder_skips.csv")) if s["key"] not in before["skips"]]
    post("skips", uid, [{"rec_key": s["key"], "reason": s["reason"], "day": s["date_et"]} for s in sk])
    return {"bets": len(changed), "ledger": len(new), "recs": len(recs), "skips": len(sk)}
