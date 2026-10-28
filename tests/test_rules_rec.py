"""Rules 1-3 (RULES.md): CLV open/close columns, boost rule, rec linking at log time, data-quirk fixes."""
import os, sys, csv, json, shutil, subprocess, tempfile, unittest, warnings
warnings.simplefilter("ignore", ResourceWarning)
SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SRC, "scripts"))
import rules as BR, rec as RC, clv as C, clv_backfill as BF

def bet(**k):
    b = {"bet_id": "b1", "date": "2026-10-27", "book": "DraftKings", "event": "Brooklyn Nets @ Boston Celtics", "start_et": "Tue Oct 27, 7:30 PM ET",
         "market": "Moneyline", "pick": "Brooklyn Nets ML", "price": "+425", "boosted_price": "", "stake": "0.30", "to_win": "1.27",
         "fair_pct": "", "ev_pct": "", "result": "open"}
    b.update(k); return b
def rec(**k):
    r = {c: "" for c in RC.COLS}
    r.update({"rec_id": "r1", "rec_date": "2026-10-27", "event": "Brooklyn Nets @ Boston Celtics", "game_start_et": "2026-10-27 19:30", "market": "cash",
              "selection": "Brooklyn Nets to win", "book": "bet365", "rec_price": "+425", "eff_price": "+425", "fair_pct": "19.54", "ev_pct": "2.58",
              "friend": "no", "placed": "no", "result": "pending"})
    r.update(k); return r

class Boost(unittest.TestCase):
    def test_preferred(self):
        self.assertEqual(BR.boost_check(1, 150)[0], "preferred"); self.assertEqual(BR.boost_check(2, 299)[0], "preferred")
        self.assertEqual(BR.boost_check(2, 100)[0], "preferred")
    def test_flagged_needs_2pct(self):
        self.assertEqual(BR.boost_check(1, -150, 3.0)[0], "flagged_ok"); self.assertEqual(BR.boost_check(1, -150, 1.9)[0], "flagged_low_ev")
        self.assertEqual(BR.boost_check(1, -150, None)[0], "flagged_no_ev"); self.assertEqual(BR.boost_check(2, 300, 2.0)[0], "flagged_ok")
        self.assertEqual(BR.boost_check(3, 110, 1.0, "DraftKings", "NBA")[0], "flagged_low_ev")
    def test_required_3leg_never_flagged(self):
        self.assertEqual(BR.boost_check(3, 110, None, "bet365")[0], "required_3leg")
        self.assertEqual(BR.boost_check(3, 110, None, "FanDuel", "NBA")[0], "required_3leg"); self.assertEqual(BR.boost_check(3, 110, None, "FanDuel", "NHL")[0], "required_3leg")
        self.assertEqual(BR.boost_check(3, 110, None, "FanDuel", "NFL")[0], "flagged_no_ev")
    def test_legs(self):
        self.assertEqual(BR.legs_of("SGP 3-leg (30% profit boost)", "A + B + C"), 3); self.assertEqual(BR.legs_of("Parlay 2-leg", "A + B"), 2)
        self.assertEqual(BR.legs_of("Moneyline (50% profit boost)", "Detroit Pistons ML"), 1)
    def test_bet_row(self):
        b = bet(market="Moneyline (50% profit boost)", price="+114", boosted_price="+171", ev_pct="5.0")
        self.assertEqual(BR.boost_check_bet(b)[0], "preferred"); self.assertIsNone(BR.boost_check_bet(bet()))
        b = bet(book="DraftKings", market="SGP 3-leg (30% profit boost)", pick="A + B + C", price="+110", boosted_price="+143", ev_pct="")
        self.assertEqual(BR.boost_check_bet(b)[0], "flagged_no_ev")

class Linking(unittest.TestCase):
    def test_v_does_not_link_other_games(self):   # the a0031feb bug: only the 'v' in 'X v Y' was shared
        a = rec(event="Cesena v Avellino (Serie B)", selection="Draw", market="3-Way Draw", game_start_et="2026-10-18 11:15", book="PointsBet")
        b = rec(event="Cienciano v UTC Cajamarca (Peru Liga 1)", selection="Draw", market="3-Way Draw", game_start_et="2026-10-18 19:30", book="PointsBet")
        self.assertFalse(RC.same_rec(a, b))
    def test_book_aware(self):
        a, b = rec(book="bet365"), rec(book="DraftKings")
        self.assertTrue(RC.same_rec(a, b)); self.assertFalse(RC.same_rec_book(a, b)); self.assertTrue(RC.same_rec_book(a, rec(book="BET365")))
    def test_link_bet_same_book(self):
        rows = [rec(book="DraftKings")]
        st, r = RC.link_bet(rows, bet()); self.assertEqual(st, "linked"); self.assertEqual(r["bet_ids"], "b1"); self.assertEqual(r["placed"], "yes")
    def test_link_bet_fills_fair_and_ev(self):
        rows = [rec(book="DraftKings")]; b = bet(); RC.link_bet(rows, b)
        self.assertEqual(b["fair_pct"], "19.54"); self.assertAlmostEqual(float(b["ev_pct"]), 2.58, 1)   # 0.1954 * 5.25 - 1
    def test_link_bet_other_book_not_linked(self):
        rows = [rec(book="bet365")]; st, r = RC.link_bet(rows, bet(), create=False)
        self.assertEqual(st, "none"); self.assertEqual(rows[0]["bet_ids"], "")
    def test_link_bet_creates_rec_when_fair_given(self):
        rows = []; b = bet(fair_pct="19.54"); st, r = RC.link_bet(rows, b)
        self.assertEqual(st, "created"); self.assertEqual(len(rows), 1); self.assertEqual(rows[0]["bet_ids"], "b1"); self.assertEqual(rows[0]["book"], "DraftKings")
        self.assertEqual(rows[0]["fair_pct"], "19.54"); self.assertEqual(b["ev_pct"], rows[0]["ev_pct"]); self.assertNotEqual(b["ev_pct"], "")
    def test_no_rec_no_fair_is_none(self):
        rows = []; st, r = RC.link_bet(rows, bet()); self.assertEqual((st, rows), ("none", []))
    def test_boosted_ev_uses_boosted_price(self):
        b = bet(market="Moneyline (50% profit boost)", price="+114", boosted_price="+171", fair_pct="49.77"); RC.complete_bet(b)
        self.assertAlmostEqual(float(b["ev_pct"]), (0.4977 * 2.71 - 1) * 100, 1)
    def test_unconfirmed_price_gets_no_ev(self):
        b = bet(price="unconfirmed (~+120)", fair_pct="40"); RC.complete_bet(b); self.assertEqual(b["ev_pct"], "")
    def test_add_by_book_keeps_both(self):
        rows = [rec(book="bet365")]; RC.add(rows, rec(rec_id="", book="DraftKings"), quiet=True, by_book=True); self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["rec_id"] for r in rows}), 2); RC.add(rows, rec(rec_id="", book="DraftKings"), quiet=True, by_book=True); self.assertEqual(len(rows), 2)

class Clv(unittest.TestCase):
    def setUp(self):
        self.old = C.CLV; self.d = tempfile.mkdtemp(); C.CLV = os.path.join(self.d, "clv.csv")
    def tearDown(self): C.CLV = self.old; shutil.rmtree(self.d)
    def test_open_prices_recorded(self):
        C.record_placed("b1", "2026-10-27 18:00", bet(price="+114", boosted_price="+171")); r = C.load()["b1"]
        self.assertEqual((r["placed_at"], r["open_price_unboosted"], r["open_price_boosted"]), ("2026-10-27 18:00", "+114", "+171"))
        C.record_placed("b1", "2026-10-27 19:00", bet(price="+200")); r = C.load()["b1"]    # never overwritten
        self.assertEqual((r["placed_at"], r["open_price_unboosted"]), ("2026-10-27 18:00", "+114"))
    def test_unclean_prices_stay_blank(self):
        self.assertEqual(C.open_prices(bet(price="unconfirmed (~+120)", boosted_price="~+155")), ("", ""))
        self.assertEqual(C.open_prices(bet(price="810", boosted_price="boosted x2 profit")), ("", ""))
    def test_close_fields_boosted_and_unboosted_apart(self):
        b = bet(market="Moneyline (100% profit boost)", price="+134", boosted_price="+268"); f = C.close_fields(b, 0.415)
        self.assertEqual(f["close_price_unboosted"], "+141"); self.assertEqual(f["close_price_boosted"], "+282")
        self.assertAlmostEqual(float(f["clv_unboosted_pct"]), (0.415 * 2.34 - 1) * 100, 1); self.assertAlmostEqual(float(f["clv_boosted_pct"]), (0.415 * 3.68 - 1) * 100, 1)
        self.assertEqual(f["close_source"], "pinnacle")
    def test_unboosted_bet_has_no_boosted_close(self):
        f = C.close_fields(bet(price="+190"), 0.35); self.assertEqual((f["close_price_boosted"], f["clv_boosted_pct"]), ("", ""))
    def test_missing_closes_and_summary(self):
        rows = [bet(bet_id="a", result="lost"), bet(bet_id="b", result="lost"), bet(bet_id="c", market="SGP 2-leg", pick="A + B", result="lost")]
        m = {"a": {"bet_id": "a", "placed_at": "x", "close_price_unboosted": "+400", "clv_pct": "3.0", "close_source": "pinnacle"}}; C.save(m)
        self.assertEqual([x["bet_id"] for x in C.missing_closes(rows)], ["b"])
        cov = C.summary(rows)["coverage"]; self.assertEqual((cov["straight"], cov["straight_with_close"]), (2, 1))
    def test_proxy_not_in_headline(self):
        rows = [bet(bet_id="a", result="lost")]
        C.save({"a": {"bet_id": "a", "close_price_unboosted": "+400", "clv_unboosted_pct": "3.0", "close_source": "espn_dk_final"}})
        s = C.summary(rows); self.assertEqual(s["n"], 0); self.assertEqual(s["coverage"]["proxy_closes"], 1)

class Espn(unittest.TestCase):
    SNAP = {"teams": [{"name": "Brooklyn Nets", "home": False}, {"name": "Boston Celtics", "home": True}]}
    def pc(self, **k):
        d = {"provider": {"name": "DraftKings"}, "overUnder": 223.5, "overOdds": -112.0, "underOdds": -108.0, "spread": -13.5,
             "homeTeamOdds": {"favorite": True, "moneyLine": -750, "spreadOdds": -105.0}, "awayTeamOdds": {"favorite": False, "moneyLine": 525, "spreadOdds": -115.0}}
        d.update(k); return {"pickcenter": [d]}
    def test_ml(self):
        f = BF.espn_fair(bet(), self.pc(), self.SNAP); i, j = C.implied(525), C.implied(-750); self.assertAlmostEqual(f, i / (i + j))
    def test_spread_total_need_same_line(self):
        self.assertIsNotNone(BF.espn_fair(bet(market="Spread", pick="Brooklyn Nets +13.5"), self.pc(), self.SNAP))
        self.assertIsNone(BF.espn_fair(bet(market="Spread", pick="Brooklyn Nets +12.5"), self.pc(), self.SNAP))
        self.assertIsNotNone(BF.espn_fair(bet(market="Total", pick="Over 223.5"), self.pc(), self.SNAP)); self.assertIsNone(BF.espn_fair(bet(market="Total", pick="Over 220.5"), self.pc(), self.SNAP))
    def test_bad_sign_rejected(self):
        self.assertIsNone(BF.espn_fair(bet(market="Spread", pick="Brooklyn Nets -13.5"), self.pc(spread=13.5), self.SNAP))

def copy_repo():
    d = tempfile.mkdtemp(); shutil.copytree(SRC, d + "/r", ignore=shutil.ignore_patterns(".git")); return d, d + "/r"
def run(r, *a, env=None):
    return subprocess.run([sys.executable] + list(a), cwd=r, capture_output=True, text=True, env=dict(os.environ, **(env or {})))

class Flow(unittest.TestCase):
    def test_ledger_log_links_and_warns(self):
        d, r = copy_repo()
        try:
            base = ["scripts/ledger.py", "log", "date=" + __import__("datetime").date.today().isoformat(), "book=DraftKings", "event=Test A @ Test B", "start_et=Fri Dec 11 07:00 PM ET",
                    "market=Moneyline", "pick=Test A ML", "price=+150", "stake=1.00", "to_win=1.50"]
            p = run(r, *base); self.assertIn("WARNING: no rec linked", p.stdout + p.stderr); self.assertIn("WARNING: no fair % / EV recorded", p.stdout)
            p = run(r, *(base[:2] + base[2:3] + ["book=FanDuel"] + base[4:] + ["fair_pct=45"]))
            self.assertIn("rec created", p.stdout); self.assertNotIn("WARNING: no rec linked", p.stdout)
            bets = list(csv.DictReader(open(r + "/data/bets.csv"))); b = [x for x in bets if x["book"] == "FanDuel" and x["pick"] == "Test A ML"][-1]
            self.assertEqual(b["fair_pct"], "45"); self.assertEqual(b["ev_pct"], "12.5")              # 0.45 * 2.5 - 1
            recs = list(csv.DictReader(open(r + "/data/recommendations.csv"))); self.assertIn(b["bet_id"], [i for x in recs for i in x["bet_ids"].split(";")])
            c = {x["bet_id"]: x for x in csv.DictReader(open(r + "/data/clv.csv"))}[b["bet_id"]]
            self.assertEqual(c["open_price_unboosted"], "+150"); self.assertEqual(c["open_price_boosted"], "")
            # same selection at another book is a NEW rec (not linked across books)
            n = len(recs); p = run(r, *(base[:3] + ["book=Caesars"] + base[4:] + ["fair_pct=45", "stake=2.00"]))
            self.assertIn("rec created", p.stdout); self.assertEqual(len(list(csv.DictReader(open(r + "/data/recommendations.csv")))), n + 1)
        finally: shutil.rmtree(d)
    def test_boost_flag_printed_for_flagged_boost(self):
        d, r = copy_repo()
        try:
            p = run(r, "scripts/ledger.py", "log", "date=" + __import__("datetime").date.today().isoformat(), "book=DraftKings", "event=Test A @ Test B", "start_et=Fri Dec 11 07:00 PM ET",
                    "market=SGP 3-leg", "pick=X 1+ + Y 1+ + Z 1+", "price=+110", "boosted_price=+143", "stake=1.00", "to_win=1.43", "fair_pct=44")
            self.assertIn("rec created", p.stdout); self.assertIn("boost rule flag", p.stdout.lower())
        finally: shutil.rmtree(d)
    def test_fix_data_quirks(self):
        d, r = copy_repo()
        try:
            def audit():
                sys.path.insert(0, r + "/scripts"); return None
            before = run(r, "scripts/audit.py").stdout
            p = run(r, "scripts/fix_data_quirks.py", "--apply"); self.assertEqual(p.returncode, 0, p.stderr)
            after = run(r, "scripts/audit.py").stdout
            self.assertIn("multi_rec    0", after); self.assertIn("cross_book   0", after)
            p2 = run(r, "scripts/fix_data_quirks.py", "--apply"); self.assertIn("0 link change(s), 0 start_et fill(s)", p2.stdout)   # idempotent
            ids = [x["bet_id"] for x in csv.DictReader(open(r + "/data/archive/bets-2026-10.csv"))]; self.assertEqual(len(ids), len(set(ids)))
        finally: shutil.rmtree(d)
    def test_ev_scan_check_boost(self):
        p = run(SRC, "scripts/ev_scan.py", "--check-boost", "--legs", "3", "--price", "110", "--ev", "1", "--book", "DraftKings"); self.assertIn("flagged_low_ev", p.stdout)
        p = run(SRC, "scripts/ev_scan.py", "--check-boost", "--legs", "3", "--price", "110", "--book", "bet365"); self.assertIn("required_3leg", p.stdout)
    def test_audit_runs(self):
        p = run(SRC, "scripts/audit.py"); self.assertEqual(p.returncode, 0, p.stderr); self.assertIn("no_rec", p.stdout)

if __name__ == "__main__": unittest.main()
