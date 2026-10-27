#!/usr/bin/env python3
"""Offline checks for first/last TD scorer grading and odds-in-leg-text parsing.  python3 tests/test_settle_td.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import build, settle

SUMMARY = {"scoringPlays": [
    {"type": {"abbreviation": "FG", "text": "Field Goal Good"}, "text": "Brandon Aubrey 55 Yd Field Goal"},
    {"type": {"abbreviation": "TD", "text": "Rushing Touchdown"}, "text": "Saquon Barkley 8 Yd Rush (Jake Elliott Kick)"},
    {"type": {"abbreviation": "TD", "text": "Passing Touchdown"}, "text": "CeeDee Lamb 9 Yd pass from Dak Prescott (Brandon Aubrey Kick)"},
    {"type": {"abbreviation": "TD", "text": "Rushing Touchdown"}, "text": "Javonte Williams 2 Yd Rush (Brandon Aubrey Kick)"}]}
fails = 0
def check(name, got, want):
    global fails
    if got != want: fails += 1; print("FAIL", name, got, "!=", want)
check("td_scorers", settle.td_scorers(SUMMARY), ["Saquon Barkley", "CeeDee Lamb", "Javonte Williams"])
check("td_scorers none", settle.td_scorers({"scoringPlays": [SUMMARY["scoringPlays"][0]]}), [])
L = settle.parse_leg("Javonte Williams First TD Scorer", "")
check("parse first", (L["type"], L["stat"], L["player"]), ("prop", "firsttd", "Javonte Williams"))
check("parse last", settle.parse_leg("Jalen Hurts last TD scorer", "")["stat"], "lasttd")
game = [({"path": "football/nfl", "id": "1", "snapshot": {"teams": []}}, SUMMARY, {})]
check("first TD lost", settle.grade_leg(L, game, "DraftKings", {}), "lost")
check("first TD won", settle.grade_leg(settle.parse_leg("Saquon Barkley First TD Scorer", ""), game, "DraftKings", {}), "won")
check("last TD won", settle.grade_leg(settle.parse_leg("Javonte Williams Last TD Scorer", ""), game, "DraftKings", {}), "won")
p = build.parse_leg("Derrick Henry anytime TD (-218)", "")
check("odds in leg", (p["type"], p["stat"], p["player"]), ("prop", "td", "Derrick Henry"))
print(f"{9 - fails}/9 passed"); sys.exit(1 if fails else 0)
