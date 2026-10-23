#!/usr/bin/env python3
"""export -> user_ops -> sync_back round trip against an in-memory fake of the Supabase REST API (no network)."""
import os, sys, json, tempfile, subprocess, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); S = os.path.join(os.path.dirname(HERE), "scripts"); sys.path.insert(0, S)
import supa, migrate_to_supabase as M

bets, ledger, recs, _ = M.load()
TABLES = {"bets": [dict(b, user_id="u1") for b in bets],
          "ledger": [dict(l, id=i + 1, user_id="u1") for i, l in enumerate(ledger)],
          "recommendations": [dict(r, user_id="u1") for r in recs], "skips": []}
POSTS = []
supa.fetch_all = lambda table, uid, order: TABLES[table]
supa.api = lambda method, path, body=None, extra=None: POSTS.append((method, path, body)) or None

ok = True
def check(c, msg):
    global ok; print(("PASS " if c else "FAIL ") + msg); ok = ok and c

with tempfile.TemporaryDirectory() as root:
    before = supa.export("u1", root)
    check(len(before["bets"]) == len(bets) and before["ledger_n"] == len(ledger), "export row counts")
    day = datetime.date.today().isoformat()
    ops = [{"id": 1, "kind": "add_bets", "payload": {"bets": [{"date": day, "book": "FanDuel", "event": "Alpha @ Beta", "start_et": "", "market": "Moneyline",
            "pick": "Alpha ML", "price": "+150", "boosted_price": "", "stake": "2.00", "to_win": "3.00"}]}},
           {"id": 2, "kind": "add_bets", "payload": {"bets": [{"date": day, "book": "FanDuel", "event": "Alpha @ Beta", "start_et": "", "market": "Moneyline",
            "pick": "Alpha ML", "price": "+150", "boosted_price": "", "stake": "2.00", "to_win": "3.00"}]}},
           {"id": 3, "kind": "set_balance", "payload": {"book": "Caesars", "amount": "100.00", "note": "t"}}]
    json.dump(ops, open(os.path.join(root, "ops.json"), "w"))
    env = dict(os.environ, BETS_ROOT=root, BETS_LOCK=os.path.join(root, "lock"))
    # run only the ops (no settle/build pass): call apply() directly
    code = subprocess.run([sys.executable, "-c", "import sys,json;sys.path.insert(0,%r);import user_ops;o=json.load(open(%r));print(json.dumps([user_ops.apply(x) for x in o]))" % (S, os.path.join(root, "ops.json"))],
                          env=env, capture_output=True, text=True)
    res = json.loads(code.stdout.strip().splitlines()[-1])
    check(res[0][0] and res[1][0] and res[2][0], f"ops ok {res}")
    w = supa.sync_back("u1", root, before)
    check(w["bets"] == 1, f"one new bet written {w}")
    check(w["ledger"] == 2, "stake + anchor ledger rows appended (duplicate bet added nothing)")
    nb = next(p[2] for p in POSTS if "/rest/v1/bets" in p[1])[0]
    check(nb["pick"] == "Alpha ML" and nb["stake_text"] == "2.00" and nb["user_id"] == "u1" and nb["result"] == "open", "bet row fields")
sys.exit(0 if ok else 1)
