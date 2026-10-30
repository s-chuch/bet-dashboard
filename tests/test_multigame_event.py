#!/usr/bin/env python3
"""Multi-game event tests for scripts/build.build_bet (no network).  python3 tests/test_multigame_event.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import build
CALLS = []
def fake_find_game(teams, paths, date, women=False):
    CALLS.append(list(teams))
    return {"id": "g" + str(len(CALLS)), "path": "hockey/nhl", "snapshot": {"teams": [{"name": t, "abbr": t[:3].upper()} for t in teams], "date": "2026-10-30T23:00Z"}}
build.find_game = fake_find_game
build.resolve_props = lambda *a, **k: None
def row(event, pick):
    return {"bet_id": "t1", "date": "2026-10-30", "book": "X", "event": event, "market": "NHL 3-leg parlay", "pick": pick, "start_et": "",
            "price": "+500", "boosted_price": "", "stake": "10", "to_win": "50", "ev_pct": "", "fair_pct": ""}
PICK = "Utah Mammoth ML + Buffalo ML + Vancouver ML"
fails = 0
def check(name, ok):
    global fails
    if not ok: fails += 1; print("FAIL", name)
for sep in (" / ", "; "):
    CALLS.clear()
    b = build.build_bet(row("NHL 3-leg parlay: Utah Mammoth @ Pittsburgh" + sep + "Buffalo @ Anaheim" + sep + "Vancouver @ San Jose", PICK))
    check("no bet match " + repr(sep), b["match"] is None)
    check("per-team lookups " + repr(sep), len(CALLS) == 3 and all(len(c) == 1 for c in CALLS))
    check("legs matched " + repr(sep), all(L.get("match") for L in b["legs"]))
CALLS.clear()
b = build.build_bet(row("Utah Mammoth @ Pittsburgh", "Utah Mammoth ML"))
check("single game bet match", b["match"] is not None and CALLS and len(CALLS[0]) == 2)
print(f"{'all' if not fails else 'some'} passed"); sys.exit(1 if fails else 0)
