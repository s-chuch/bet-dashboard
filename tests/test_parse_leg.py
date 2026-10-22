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
    ("Celtics ML", "Moneyline", {"type": "ml"}), ("Raptors +4.5", "Spread", {"type": "spread", "line": 4.5}),
]
fails = 0
for t, mk, want in CASES:
    got = build.parse_leg(t, mk)
    bad = {k: got.get(k) for k, v in want.items() if got.get(k) != v}
    if bad: fails += 1; print("FAIL", t, "->", got)
print(f"{len(CASES) - fails}/{len(CASES)} passed"); sys.exit(1 if fails else 0)
