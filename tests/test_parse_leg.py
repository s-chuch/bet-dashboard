#!/usr/bin/env python3
"""Leg-format tests for scripts/build.parse_leg (no network).  python3 tests/test_parse_leg.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import build
CASES = [
    ("Kawhi Leonard 40+ pts+reb+ast", "", {"type": "prop", "stat": "pra", "min": 40}),
    ("Luka 8+ PRA", "", {"stat": "pra"}), ("Jokic 30+ points + rebounds", "", {"stat": "pr"}),
    ("Tatum 25+ pts+ast", "", {"stat": "pa"}), ("Gobert 15+ reb+ast", "", {"stat": "ra"}), ("Wemby 4+ stl+blk", "", {"stat": "stocks"}),
    ("Under 3.5 Total Goals", "", {"type": "total", "side": "under", "line": 3.5}),
    ("Under 10.5 Total Corners", "", {"type": "unknown"}),
    ("Yes Both Teams To Score", "", {"type": "btts", "yes": True}), ("BTTS - No", "", {"type": "btts", "yes": False}),
    ("Tammy Abraham AGS (SGP)", "", {"type": "prop", "stat": "goal", "player": "Tammy Abraham"}),
    ("Tijuana", "Match Result (bonus bet $2.50)", {"type": "ml", "team": "Tijuana"}),
    ("OKC Thunder to win NBA Cup", "Futures", {"type": "unknown"}),
    ("Philadelphia 76ers", "Moneyline (NBA No Sweat bonus bet $1.00)", {"type": "ml", "team": "Philadelphia 76ers"}), ("San Francisco 49ers", "Moneyline", {"type": "ml"}),
    ("Gabby Williams 2+ Threes Made", "", {"type": "prop", "stat": "threes", "min": 2}), ("Angel Reese 10+ Rebounds Recorded", "", {"stat": "reb"}),
    ("Caitlin Clark 5+ 3-Pointers Made", "", {"stat": "threes"}), ("Chandler Simpson 1+ Total Bases", "", {"stat": "tb"}), ("Yandy Diaz 2+ Total Bases", "", {"stat": "tb"}), ("Luka Doncic 8+ Total Rebounds", "", {"type": "prop"}), ("A'ja Wilson 25+ Points Scored", "", {"stat": "pts"}),
    ("Celtics ML", "Moneyline", {"type": "ml"}), ("Raptors +4.5", "Spread", {"type": "spread", "line": 4.5}),
]
fails = 0
for t, mk, want in CASES:
    got = build.parse_leg(t, mk)
    bad = {k: got.get(k) for k, v in want.items() if got.get(k) != v}
    if bad: fails += 1; print("FAIL", t, "->", got)
PM = [("Gabby Williams", "Grant Williams", False), ("Gabby Williams", "Gabby Williams", True), ("Gabby Williams", "Gabrielle Williams", True),
      ("J. Carter", "Jalen Carter", True), ("Matt Smith", "Matthew Smith", True), ("Jimmy Butler", "James Butler", True), ("Kawhi Leonard", "Kawhi Leonard", True),
      ("Casemiro", "Casemiro", True), ("Allan", "Allan Saint-Maximin", True), ("Wemby", "Victor Wembanyama", False), ("Tatum", "Jayson Tatum", True)]
pm_fail = [x for x in PM if bool(build.player_match(x[0], x[1])) != x[2]]
for x in pm_fail: print("FAIL player_match", x)
fails += len(pm_fail)
print(f"{len(CASES) + len(PM) - fails}/{len(CASES) + len(PM)} passed"); sys.exit(1 if fails else 0)
