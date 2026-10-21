#!/usr/bin/env python3
"""Duplicate-check + validation tests for scripts/add_bets.py. Runs against a throwaway copy of scripts/ and data/ (never the real repo).
   python3 tests/test_add_bets.py"""
import os, sys, json, shutil, subprocess, tempfile, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="addbets-")
shutil.copytree(os.path.join(ROOT, "scripts"), os.path.join(tmp, "scripts"), ignore=shutil.ignore_patterns("__pycache__"))
shutil.copytree(os.path.join(ROOT, "data"), os.path.join(tmp, "data"))
env = dict(os.environ, BETS_LOCK=os.path.join(tmp, "lock"), TZ="America/Toronto")
today = datetime.datetime.now().strftime("%Y-%m-%d")
BASE = {"date": today, "book": "Caesars", "event": "Zeta City @ Alpha United", "start_et": "Fri Oct 30 07:00 PM ET", "market": "SGP 3-leg", "pick": "Alpha ML + Rex Ford 20+ pts + Tom Hale 5+ reb", "price": "+300", "boosted_price": "", "stake": "0.50", "to_win": "1.50"}
fails = []

def run(rows):
    r = subprocess.run([sys.executable, "scripts/add_bets.py"], cwd=tmp, env=dict(env, BETS_JSON=json.dumps(rows)), capture_output=True, text=True)
    out = r.stdout + r.stderr
    return r.returncode, sum(l.startswith("added:") for l in out.splitlines()), sum("skipped duplicate" in l for l in out.splitlines()), out

def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + detail))
    if not ok: fails.append(name)

def v(**kw): d = dict(BASE); d.update(kw); return d

rc, a, d, o = run([v()]);                                               check("first bet is added", (rc, a, d) == (0, 1, 0), o)
rc, a, d, o = run([v()]);                                               check("exact repeat is skipped", (a, d) == (0, 1), o)
rc, a, d, o = run([v(event="Zeta City at Alpha United", pick="Alpha Utd ML + R. Ford 20+ pts + T. Hale 5+ rebounds")]); check("reworded repeat (OCR / book wording) is skipped", (a, d) == (0, 1), o)
rc, a, d, o = run([v(pick="Alpha ML + Rex Ford 25+ pts + Tom Hale 5+ reb")]);   check("different line number is a new bet", (a, d) == (1, 0), o)
rc, a, d, o = run([v(stake="1.00")]);                                   check("different stake is a new bet", (a, d) == (1, 0), o)
rc, a, d, o = run([v(book="FanDuel")]);                                 check("different book is a new bet", (a, d) == (1, 0), o)
rc, a, d, o = run([v(pick="Alpha ML + Max Gray 20+ pts + Ian Cole 5+ reb")]);   check("different players, same numbers, is a new bet", (a, d) == (1, 0), o)
far = (datetime.date.today() - datetime.timedelta(days=9)).isoformat()
rc, a, d, o = run([v(date=far, event="Zeta City @ Beta Town")]);          check("same legs in a different game 9 days earlier is a new bet", (a, d) == (1, 0), o)
rc, a, d, o = run([v(event="Omega @ Sigma", pick="Over 5.5", price="+110", to_win="0.55"), v(event="Omega @ Sigma", pick="Over 5.5", price="+112", to_win="0.56")])
check("two screenshots of the same new bet in one upload add only one", (a, d) == (1, 1), o)
rc, a, d, o = run([v(force="1")]);                                      check("force=1 adds an intentional second identical bet", (a, d) == (1, 0), o)
rc, a, d, o = run([v(force="yes")]);                                    check("bad force flag is refused", rc == 2 and a == 0, o)
rc, a, d, o = run([v(stake="nan")]);                                    check("stake=nan refused", rc == 2, o)
rc, a, d, o = run([v(stake="1e9")]);                                    check("stake=1e9 refused", rc == 2, o)
rc, a, d, o = run([v(result="won")]);                                   check("unknown field (result) refused", rc == 2, o)
rc, a, d, o = run([v(pick="=HYPERLINK(1)")]);                           check("formula-looking pick refused", rc == 2, o)
rc, a, d, o = run([v(pick="+cmd|calc")]);                               check("pick starting with + refused", rc == 2, o)
rc, a, d, o = run([v(event="-2+3")]);                                   check("event starting with - refused", rc == 2, o)
rc, a, d, o = run([v(price="+00", pick="Zed ML")]);                      check("odds +00 refused", rc == 2, o)
rc, a, d, o = run([v(to_win="0", pick="Zed ML")]);                       check("to_win 0 refused", rc == 2, o)
rc, a, d, o = run([v(pick="Brand New Leg 3+ pts", price="-110")]);       check("negative odds with leading minus accepted", (rc, a) == (0, 1), o)
rc, a, d, o = run([v(stake="15.00 (bonus)", market="Moneyline (bonus bet $15)", pick="Panthers ML", event="Pitt Panthers @ Miami Hurricanes", price="+1000", to_win="150")]); check("bonus bet is added with a (bonus) stake", (rc, a) == (0, 1), o)
rc, a, d, o = run([v(stake="15.00 (bonus)", pick="Panthers ML 2")]);   check("bonus stake without 'bonus bet' in market refused", rc == 2, o)
led = open(os.path.join(tmp, "data/ledger.csv")).read()
check("bonus bet did not deduct cash", "-15" not in led.split("Panthers")[-1] and ",-15.0" not in led)
rows = open(os.path.join(tmp, "data/bets.csv"), newline="").read().count("\r\n")
shutil.rmtree(tmp, ignore_errors=True)
print("FAILED: " + ", ".join(fails) if fails else "all passed"); sys.exit(1 if fails else 0)
