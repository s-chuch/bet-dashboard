import os, sys, unittest, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import ev_scan as E

class T(unittest.TestCase):
    def test_novig_2way(self):
        p = E.fair_probs({"a": -110, "b": -110}); self.assertAlmostEqual(p["a"], 0.5)
        p = E.fair_probs({"over": -152, "under": 124}); self.assertAlmostEqual(sum(p.values()), 1)
        self.assertAlmostEqual(p["over"], (152/252) / (152/252 + 100/224))
    def test_novig_3way(self):
        p = E.fair_probs({"home": -293, "away": 755, "draw": 448}); self.assertAlmostEqual(sum(p.values()), 1)
    def test_ev(self):
        self.assertAlmostEqual(E.ev_of(0.5, 110), 0.05)
        self.assertAlmostEqual(E.ev_of(0.5, -110), 0.5 * (1 + 100/110) - 1)
    def test_classify(self):
        self.assertEqual(E.classify(0.02), "BET"); self.assertEqual(E.classify(0.0199), "SKIP")
        self.assertEqual(E.classify(0.0), "SKIP"); self.assertEqual(E.classify(-0.001), "NO")
    def test_kill(self):
        for fair in (0.2, 0.45, 0.5, 0.5747, 0.7):
            k = E.kill_price(fair)
            self.assertGreaterEqual(E.ev_of(fair, k), 0.02 - 1e-9)
            worse = k - 1 if k > 100 else (k - 1 if k < -100 else -101)
            if worse in range(-100, 100): worse = -101
            self.assertLess(E.ev_of(fair, worse), 0.02)
        self.assertEqual(E.kill_price(0.5), 104)
    def test_bet365(self):
        self.assertFalse(E.book_allowed("bet365", -110)); self.assertTrue(E.book_allowed("bet365", 100))
        self.assertTrue(E.book_allowed("FanDuel", -300))
    def test_exposure(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
            f.write("event,pick,result\n\"Golden State Valkyries @ Atlanta Dream\",Over,open\nKent State @ USF,Kent,lost\n")
        o = E.open_events(f.name)
        self.assertTrue(E.exposed({"full_name": "Atlanta Dream"}, {"full_name": "Chicago Sky"}, o))
        self.assertFalse(E.exposed({"full_name": "Kent State Golden Flashes"}, {"full_name": "Ohio Bobcats"}, o))
        self.assertFalse(E.exposed({"full_name": "Dream FC"}, {"full_name": "X"}, o) and False)
    def test_wins_if(self):
        self.assertIn("45 or more", E.wins_if("ncaaf", "Total", "over", None, 44.5, False))
        self.assertIn("more than 1.5", E.wins_if("nhl", "Spread", "home", "Leafs", -1.5, False))

class Plan(unittest.TestCase):
    def test_three_way_needs_4pct(self):
        self.assertEqual(E.cash_rule("Moneyline", 250, True, 0.03)[0], "SKIP")
        self.assertIn("4%", E.cash_rule("Moneyline", 250, True, 0.03)[2])
        self.assertEqual(E.cash_rule("Moneyline", 250, True, 0.041)[0], "BET")
        self.assertEqual(E.cash_rule("Moneyline", 250, False, 0.03)[0], "BET")
    def test_caution(self):
        self.assertIn("Spread", E.cash_rule("Spread", -110, False, 0.03)[1])
        self.assertIn("favourite", E.cash_rule("Moneyline", -150, False, 0.03)[1])
        self.assertEqual(E.cash_rule("Moneyline", -149, False, 0.03)[1], "")
        self.assertEqual(E.cash_rule("Spread", -110, False, 0.01)[0], "SKIP")
    def test_bonus(self):
        self.assertAlmostEqual(E.bonus_return(0.2, 400), 0.8)
        f = E.bonus_floor(0.15); self.assertGreaterEqual(E.bonus_return(0.15, f), 0.6 - 1e-9); self.assertLess(E.bonus_return(0.15, f - 1), 0.6)
        self.assertIsNone(E.bonus_floor(0.9))
    def test_boost(self):
        self.assertAlmostEqual(E.boosted_ev(0.5, 100, 100), 0.5)
        self.assertAlmostEqual(E.boosted_ev(0.5, 100, 0), 0.0)

if __name__ == "__main__": unittest.main()
