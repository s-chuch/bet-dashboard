#!/usr/bin/env python3
"""scripts/statsgen.py: money parsing, odds buckets, chronological streaks, cash-only totals, archive bonus flag (no network).
python3 tests/test_statsgen.py"""
import os, sys, datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import statsgen as S

fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    if not ok: fails += 1
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  got {got!r} want {want!r}"))

def bet(i, result, pnl, stake="10", date="2026-10-15", start="", price="+150", boosted="", market="Moneyline", book="DraftKings"):
    return {"bet_id": i, "date": date, "start_et": start, "book": book, "event": "A @ B", "market": market, "pick": "A", "price": price,
            "boosted_price": boosted, "stake": stake, "to_win": "15", "result": result, "pnl": str(pnl), "settled_at": "", "settled_by": ""}

# num(): signs
for v, want in [("-$5.00", -5.0), ("$-5.00", -5.0), ("−$5.00", -5.0), ("− 5", -5.0), ("–5.00", -5.0), ("-5.00", -5.0),
                ("+$5.00", 5.0), ("5.00 (bonus)", 5.0), ("1,234.50", 1234.5), ("", 0.0), ("abc", 0.0), (None, 0.0)]:
    check(f"num({v!r})", S.num(v), want)

# odds buckets, including bets with no usable price
for r, want in [(bet("a", "won", 1, price="-110"), "Favourites (<+100)"), (bet("b", "won", 1, price="+150"), "+100 to +299"),
                (bet("c", "won", 1, price="+450"), "+300 to +599"), (bet("d", "won", 1, price="+900"), "+600+"),
                (bet("e", "won", 1, price="+150", boosted="+400"), "+300 to +599"),
                (bet("f", "lost", -1, price="TBC"), "Price unknown"), (bet("g", "lost", -1, price="unconfirmed"), "Price unknown"),
                (bet("h", "lost", -1, price=""), "Price unknown")]:
    check(f"odds_bucket {r['price']!r}/{r['boosted_price']!r}", S.odds_bucket(r), want)
rows = [bet("1", "won", 15, price="+150"), bet("2", "lost", -10, price="TBC"), bet("3", "lost", -5, price="-120")]
by = S.group(rows, S.odds_bucket, "bucket", ["Favourites (<+100)", "+100 to +299", "Price unknown"])
check("odds table keeps every bet", sum(b["bets"] for b in by), 3)
check("odds table keeps every dollar", round(sum(b["pnl"] for b in by), 2), 0.0)
check("Price unknown sorts last", by[-1]["bucket"], "Price unknown")

# chrono_key: text order of start_et is wrong, game-start order is right
k = lambda start, date="2026-10-15", i="x": S.chrono_key(bet(i, "won", 1, date=date, start=start))
check("12:30 PM before 07:00 PM", k("Sat Oct 17 12:30 PM ET") < k("Sat Oct 17 07:00 PM ET"), True)
check("10:00 AM before 12:30 PM", k("Sat Oct 17 10:00 AM ET") < k("Sat Oct 17 12:30 PM ET"), True)
check("Mon Oct 26 after Sat Oct 17", k("Mon Oct 26, 9:30 PM ET", "2026-10-25") > k("Sat Oct 17 07:00 PM ET"), True)
check("comma and unpadded hour parse", k("Mon Oct 26, 9:30 PM ET", "2026-10-25")[0], "2026-10-26T21:30:00")
check("ISO date and time", k("2026-10-03 13:09", "2026-10-03")[0], "2026-10-03T13:09:00")
check("date-only start", k("2026-10-03", "2026-10-03")[0], "2026-10-03T00:00:00")
check("blank start goes to end of bet date", k("", "2026-10-03")[0], "2026-10-03T23:59:00")
check("December bet on January game rolls the year", k("Fri Jan 02 07:00 PM ET", "2026-12-30")[0], "2027-01-02T19:00:00")
check("junk start does not crash", k("EPL 2026/27 season end")[0], "2026-10-15T23:59:00")

# streaks follow game start, not alphabetical start_et ("Fri" < "Sat" < "Thu"), and bet_id breaks no ties it should not
seq = [bet("a", "lost", -10, start="Thu Oct 15 07:00 PM ET"), bet("b", "won", 15, start="Fri Oct 16 07:00 PM ET"),
       bet("c", "won", 15, start="Sat Oct 17 12:30 PM ET"), bet("d", "won", 15, start="Sat Oct 17 07:00 PM ET")]
t = S.build_stats(seq, [])
check("best win streak by game start", t["streak"]["best_win"], 3)
check("current streak by game start", t["streak"]["current"], {"type": "won", "n": 3})
check("first date", t["totals"]["first_date"], "2026-10-15")

# cash-only totals: bonus bets risk no cash, so their winnings are reported apart
mix = [bet("c1", "won", 15, stake="10"), bet("c2", "lost", -10, stake="10"), bet("c3", "lost", -10, stake="10"),
       bet("b1", "won", 20, stake="5.00 (bonus)"), bet("b2", "lost", 0, stake="5", market="Moneyline (bonus bet $5.00)")]
T = S.build_stats(mix, [])["totals"]
check("bets counts all", T["bets"], 5)
check("pnl counts all", T["pnl"], 15.0)
check("staked is cash only", T["staked"], 30.0)
check("pnl_cash excludes bonus winnings", T["pnl_cash"], -5.0)
check("roi_cash", T["roi_cash"], round(-5 / 30 * 100, 2))
check("bonus_n", T["bonus_n"], 2)
check("bonus_pnl", T["bonus_pnl"], 20.0)
check("avg_win uses cash bets only", T["avg_win"], 15.0)
check("avg_loss uses cash bets only", T["avg_loss"], -10.0)
bonus_only = S.agg([bet("b1", "won", 20, stake="5 (bonus)")])
check("bonus-only group has no cash staked (page shows a dash)", bonus_only["staked"], 0.0)

# archive rows carry the bonus flag
arch = S.build_archive([bet("c1", "won", 15), bet("b1", "won", 20, stake="5.00 (bonus)")])["bets"]
check("archive flags bonus bets", {b["bet_id"]: b["bonus"] for b in arch}, {"c1": False, "b1": True})

# game-plan window uses Toronto time, not the host date
check("game_plan imports now_et", S.now_et.__module__, "common")
check("now_et is naive Toronto time", isinstance(S.now_et(), datetime.datetime) and S.now_et().tzinfo is None, True)

print(f"{'all passed' if not fails else str(fails) + ' FAILED'}"); sys.exit(1 if fails else 0)
