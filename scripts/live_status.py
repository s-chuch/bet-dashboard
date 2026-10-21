#!/usr/bin/env python3
"""Backup live game status for games on open bets, from official league feeds that block browser requests -> argv[1] (JSON).

Run by the autorun live loop on the GitHub runner and force-pushed (with kalshi.json) to the `live-feed` branch; the Live page
reads it only for games past their listed start that ESPN still calls pre-game. Display only: nothing settles from this file.
Sources: NHL api-web.nhle.com/v1/score/<date>; NBA cdn.nba.com liveData scoreboard (often refuses cloud IPs; skipped then).
Output: {"t": iso, "games": {<espn id>: {"state": "pre"|"in"|"post", "away": n, "home": n, "detail": str, "src": "NHL"|"NBA"}}}
Fails soft: no file written when there is nothing to report."""
import json, os, sys, datetime, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "Mozilla/5.0 (bet-dashboard live loop)", "Accept": "application/json"}
# ESPN abbreviations that differ from the NHL's
NHL_AB = {"TB": "TBL", "NJ": "NJD", "LA": "LAK", "SJ": "SJS", "UTAH": "UTA", "WSH": "WSH"}

def get(url, **h):
    with urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **h}), timeout=8) as r: return json.load(r)

def matches():
    d = json.load(open(os.path.join(REPO, "data.json"))); out = {}
    for b in d.get("open", []):
        for m in [b.get("match")] + [L.get("match") for L in b.get("legs", [])]:
            if m and m.get("snapshot") and not m["snapshot"].get("completed"): out[m["id"]] = m
    return list(out.values())

def sides(m):
    t = m["snapshot"].get("teams") or []
    return next((x for x in t if x.get("home")), {}), next((x for x in t if not x.get("home")), {})

def nhl(ms, games):
    for day in sorted({m["date"] for m in ms}):
        try: j = get(f"https://api-web.nhle.com/v1/score/{day[:4]}-{day[4:6]}-{day[6:]}")
        except Exception as e: print("nhl", day, e, file=sys.stderr); continue
        for m in (x for x in ms if x["date"] == day):
            h, a = sides(m); ha, aa = NHL_AB.get(h.get("abbr"), h.get("abbr")), NHL_AB.get(a.get("abbr"), a.get("abbr"))
            g = next((x for x in j.get("games", []) if x["homeTeam"].get("abbrev") == ha and x["awayTeam"].get("abbrev") == aa), None)
            if not g: continue
            st = g.get("gameState", "")
            state = "in" if st in ("LIVE", "CRIT") else "post" if st in ("OFF", "FINAL") else "pre"
            pd = (g.get("periodDescriptor") or {}).get("number"); clk = (g.get("clock") or {})
            det = ("Intermission" if clk.get("inIntermission") else f"P{pd} {clk.get('timeRemaining', '')}".strip()) if state == "in" and pd else st.title()
            games[m["id"]] = {"state": state, "away": g["awayTeam"].get("score", 0), "home": g["homeTeam"].get("score", 0), "detail": det, "src": "NHL"}

def nba(ms, games):
    try: j = get("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json", Referer="https://www.nba.com/")
    except Exception as e: print("nba cdn", e, file=sys.stderr); return
    for m in ms:
        h, a = sides(m)
        g = next((x for x in j.get("scoreboard", {}).get("games", []) if x["homeTeam"].get("teamTricode") == h.get("abbr") and x["awayTeam"].get("teamTricode") == a.get("abbr")), None)
        if not g: continue
        st = g.get("gameStatus")   # 1 scheduled, 2 live, 3 final
        games[m["id"]] = {"state": {2: "in", 3: "post"}.get(st, "pre"), "away": g["awayTeam"].get("score", 0), "home": g["homeTeam"].get("score", 0), "detail": g.get("gameStatusText", "").strip(), "src": "NBA"}

def main(out):
    ms = matches(); games = {}
    nh = [m for m in ms if m["path"] == "hockey/nhl"]; nb = [m for m in ms if m["path"] == "basketball/nba"]
    if nh: nhl(nh, games)
    if nb: nba(nb, games)
    if not games: return 0
    json.dump({"t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "games": games}, open(out, "w"))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/live_status.json"))
