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
fails = 0; total = 0
def check(name, got, want):
    global fails, total
    total += 1
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

# ---- boxscore fixtures: A (didNotPlay before empty-stats skip), B (ATTD guard via type.text), C (first/last TD for a DNP player)
def ath(i, name, stats=None, dnp=False):
    a = {"athlete": {"id": i, "displayName": name}, "stats": stats or []}
    if dnp: a["didNotPlay"] = True
    return a
BOX = {"boxscore": {"players": [{"team": {"abbreviation": "DAL"}, "statistics": [
    {"name": "rushing", "keys": ["carries", "rushingYards", "rushingTouchdowns"], "athletes": [
        ath("1", "Javonte Williams", ["10", "50", "1"]), ath("2", "Hurt Back", dnp=True), ath("3", "Zero Td", ["5", "20", "0"]),
        ath("5", "Mystery Scorer", ["4", "9", "0"])]}]}]}}
S2 = dict(SUMMARY, **BOX)
S2["scoringPlays"] = SUMMARY["scoringPlays"] + [{"type": {"abbreviation": "TD", "text": "Passing Touchdown"}, "text": "Mystery Scorer returns a fumble for a Touchdown"}]
g2 = [({"path": "football/nfl", "id": "2", "snapshot": {"teams": []}}, S2, {})]
def grade(text, games=g2):
    try: return settle.grade_leg(settle.parse_leg(text, ""), games, "DraftKings", {})
    except settle.Review as e: return "review"
pl = {p["name"]: p for p in settle.players_of(S2, g2[0][0])}
check("A dnp played flag", (pl["Hurt Back"]["played"], pl["Javonte Williams"]["played"]), (False, True))
check("A dnp prop void", grade("Hurt Back ATTD"), "void")
check("A played prop lost", grade("Zero Td ATTD"), "lost")
check("A played prop won", grade("Javonte Williams ATTD"), "won")
# B: Zero Td has 0 TD stats but ESPN scoringPlays (type.text 'Touchdown') names him -> review, not lost
S3 = dict(S2, scoringPlays=SUMMARY["scoringPlays"] + [{"type": {"abbreviation": "TD", "text": "Rushing Touchdown"}, "text": "Zero Td 1 Yd Rush (Kick)"}])
g3 = [(g2[0][0], S3, {})]
check("B attd named in TD play -> review", grade("Zero Td ATTD", g3), "review")
check("B unreadable scorer by last name -> review", grade("Mystery Scorer ATTD"), "review")
check("B type None safe", settle._td_plays({"scoringPlays": [{"type": None, "text": None}]}), [])
# C: first TD for a player who did not play -> void; played but not first -> lost; unknown -> review
check("C first TD dnp void", grade("Hurt Back First TD Scorer"), "void")
check("C first TD played lost", grade("Zero Td First TD Scorer"), "lost")
check("C first TD unknown review", grade("Nobody Known First TD Scorer"), "review")
check("C non-football review", grade("Zero Td First TD Scorer", [({"path": "hockey/nhl", "id": "3", "snapshot": {"teams": []}}, S2, {})]), "review")
print(f"{total - fails}/{total} passed"); sys.exit(1 if fails else 0)
