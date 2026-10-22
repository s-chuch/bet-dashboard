import os, sys, tempfile, unittest, datetime as dt
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import clv as C

G = {"home": "Houston Texans", "away": "New York Giants", "start": "2026-10-25T17:00:00Z",
     "markets": {"ml": {"prices": {"home": -200, "away": 170}, "alt": False},
                 ("sp", -3.5): {"prices": {"home": -110, "away": -110}, "alt": False},
                 ("tot", 44.5): {"prices": {"over": -105, "under": -115}, "alt": False}}}
def row(**k):
    r = {"bet_id": "t1", "date": "2026-10-22", "book": "FanDuel", "event": "New York Giants @ Houston Texans", "start_et": "Sun Oct 25 01:00 PM ET",
         "market": "Moneyline", "pick": "New York Giants", "price": "+190", "boosted_price": "", "stake": "1.00", "result": "open"}
    r.update(k); return r

class T(unittest.TestCase):
    def test_straight(self):
        self.assertEqual(C.straight(row())[0], "ml")
        self.assertEqual(C.straight(row(market="Spread", pick="Houston Texans -3.5")), ("sp", "Houston Texans", -3.5))
        self.assertEqual(C.straight(row(market="Total", pick="Over 44.5")), ("tot", "over", 44.5))
        self.assertIsNone(C.straight(row(market="SGP", pick="A + B")))
        self.assertIsNone(C.straight(row(market="Moneyline LIVE")))
        self.assertIsNone(C.straight(row(price="unconfirmed (~+120)")))
    def test_close(self):
        f, _ = C.close_fair(row(), G)
        x, y = C.implied(170), C.implied(-200); self.assertAlmostEqual(f, x / (x + y))
        self.assertAlmostEqual(C.close_fair(row(market="Spread", pick="New York Giants +3.5"), G)[0], 0.5)
        self.assertIsNone(C.close_fair(row(market="Spread", pick="New York Giants +4.5"), G)[0])
        self.assertGreater(C.clv_pct(f, 190), 0)          # took +190, close fair ~+180: beat the close
    def test_find_and_capture(self):
        su = dt.datetime(2026, 10, 25, 17, 0, tzinfo=dt.timezone.utc)
        self.assertIs(C.find_game(row(), su, [G]), G)
    def test_record_placed(self):
        old = C.CLV
        with tempfile.TemporaryDirectory() as d:
            C.CLV = os.path.join(d, "clv.csv")
            try:
                C.record_placed("abc", "2026-10-22 18:00"); C.record_placed("abc", "2026-10-22 19:00")
                self.assertEqual(C.load()["abc"]["placed_at"], "2026-10-22 18:00")
            finally: C.CLV = old

if __name__ == "__main__": unittest.main()
