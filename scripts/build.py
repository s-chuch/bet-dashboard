#!/usr/bin/env python3
"""Build data.json for the live bet dashboard (no git here; autorun.py / the box wrapper commit + push).

  python3 scripts/build.py        # rebuild data.json (+ stats/archive/log json) from data/*.csv
  python3 scripts/build.py --static  # only stats.json / archive.json / log.json (no network)

Reads data/bets.csv (open bets) and data/balances.csv, matches each bet/leg to an ESPN game (stored as
sport path + date + event id so the browser can refresh it). data.json is only rewritten when its
content (minus live-volatile fields like scores/clock) changed, so unchanged runs produce no commit.
"""
import csv, json, re, sys, os, subprocess, hashlib, datetime, unicodedata, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import BETS, BAL, REPO, PIN_CACHE, AUTO, CI, now_et, all_bets
ESPN = "https://site.api.espn.com/apis/site/v2/sports/"

TAGS = {"NCAAF": ["football/college-football"], "NFL": ["football/nfl"], "NBA": ["basketball/nba"],
        "NHL": ["hockey/nhl"], "MLB": ["baseball/mlb"], "WNBA": ["basketball/wnba"],
        "NCAAB": ["basketball/mens-college-basketball"], "SOCCER": ["soccer/all"]}
DEFAULT_PATHS = ["football/nfl", "football/college-football", "hockey/nhl", "baseball/mlb", "basketball/nba", "basketball/wnba"]
SPORT_LABEL = {"football/nfl": "NFL", "football/college-football": "NCAAF", "hockey/nhl": "NHL",
               "baseball/mlb": "MLB", "basketball/nba": "NBA", "basketball/wnba": "WNBA",
               "basketball/mens-college-basketball": "NCAAB"}

PROB_PATHS = {"football/nfl", "football/college-football", "baseball/mlb", "basketball/nba",
              "basketball/wnba", "basketball/mens-college-basketball"}

_cache = {}
def fetch(url):
    if url not in _cache:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r: _cache[url] = json.load(r)
        except Exception as e:
            print("fetch fail", url, e, file=sys.stderr); _cache[url] = {}
    return _cache[url]

def sb_url(path, date, groups=None):
    u = f"{ESPN}{path}/scoreboard?dates={date}"
    if path == "soccer/all": u += "&limit=500"
    if groups: u += f"&groups={groups}"
    return u

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]", " ", s).split()

def team_match(q, comp):
    """q: name from the bet; comp: ESPN competitor dict."""
    t = comp.get("team", {})
    qn = norm(q)
    if not qn: return False
    fields = [t.get(k, "") for k in ("displayName", "shortDisplayName", "name", "location", "abbreviation", "nickname")]
    for f in fields:
        fn = norm(f or "")
        if fn and fn == qn: return True
    disp = norm(t.get("displayName", ""))
    if len(qn) >= 1 and all(w in disp for w in qn) and (len(qn) > 1 or len(qn[0]) > 3): return True
    # prefix match for short forms like "Man City" -> "Manchester City", "Man Utd" -> "Manchester United"
    alias = {"utd": "united", "spurs": "tottenham"}
    qa = [alias.get(w, w) for w in qn]
    return len(qa) > 1 and all(any(d.startswith(w) for d in disp) for w in qa)

TEAM_ALIASES = {r"chicago red stars": "Chicago Stars", r"^man utd$": "Manchester United", r"^man city$": "Manchester City",
                r"^wolves$": "Wolverhampton", r"^spurs$": "Tottenham", r"^alaves$": "Alavés"}
def team_alias(n):
    """Book name -> the name ESPN uses (renames / short forms)."""
    for k, v in TEAM_ALIASES.items():
        if re.search(k, n, re.I): return v
    return n

def parse_date(row):
    s = row["start_et"].strip(); year = int(row["date"][:4])
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?", s)
    if m:
        d = datetime.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4] or 0), int(m[5] or 0))
    else:
        m = re.search(r"([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2}) ?([AP]M)", s)
        if not m: return None
        h = int(m[3]) % 12 + (12 if m[5] == "PM" else 0)
        d = datetime.datetime.strptime(f"{m[1]} {m[2]} {year}", "%b %d %Y").replace(hour=h, minute=int(m[4]))
    return d

def clean_team(name):
    women = bool(re.search(r"\bW$", name.strip()))
    name = re.sub(r"\s+(ML|W)$", "", name.strip()); name = re.sub(r"\s+(ML|W)$", "", name)
    return name.strip(), women

# player-prop leg grammar: (regex on the stat words, canonical stat). The client grades these from the ESPN summary.
PROP_STATS = [
    (r"(?:anytime\s+)?(?:TD|touchdown)s?(?:\s+scorer)?|ATD", "td"),
    (r"pass(?:ing)?\s*(?:yds|yards|yd)", "passYds"),
    (r"pass(?:ing)?\s*(?:TDs?|touchdowns?)", "passTD"),
    (r"rush(?:ing)?\s*(?:\+|and|&)\s*rec(?:eiving)?\s*(?:yds|yards)", "rushRecYds"),
    (r"rush(?:ing)?\s*(?:yds|yards|yd)", "rushYds"),
    (r"rush(?:ing)?\s*(?:TDs?|touchdowns?)", "rushTD"),
    (r"rec(?:eiving)?\s*(?:yds|yards|yd)", "recYds"),
    (r"rec(?:eiving)?\s*(?:TDs?|touchdowns?)", "recTD"),
    (r"receptions?|rec|catches", "receptions"),
    (r"pts|points?", "pts"),
    (r"goals?", "goals"),
    (r"assists?|ast", "assists"),
    (r"SOG|shots on goal", "sog"),
    (r"shots on target|SOT", "sot"),
    (r"shots?", "shots"),
    (r"rebounds?|reb", "reb"),
    (r"threes|3PM|3-pointers?|three pointers?", "threes"),
    (r"total bases|TB", "tb"),
    (r"hits\s*\+\s*runs\s*\+\s*RBIs?|H\+R\+RBI", "hrr"),
    (r"hits?", "hits"),
    (r"doubles?", "doubles"),
    (r"triples?", "triples"),
    (r"singles?", "singles"),
    (r"home runs?|HRs?", "hr"),
    (r"RBIs?", "rbi"),
    (r"runs scored|runs", "runs"),
    (r"stolen bases?|SB", "sb"),
    (r"walks?|BB", "walks"),
    (r"strikeouts?|Ks?", "k"),
    (r"saves?", "saves"),
]

def _prop_stat(words):
    w = words.strip()
    for rx, st in PROP_STATS:
        if re.fullmatch(rx, w, re.I): return st
    return None

def parse_leg(text, market):
    t = text.strip()
    # team totals: "Over 6.5", "Under 56.5", "U56.5", "O 4.5 runs"
    m = re.match(r"^(Over|Under|O|U)\s*([\d.]+)(?:\s+(?:runs|goals|points|pts|total))?$", t, re.I)
    if m:
        side = "over" if m[1].lower().startswith("o") else "under"
        return {"type": "total", "side": side, "line": float(m[2]), "text": t}
    # game total for a named game in a multi-game parlay: "Ravens @ Browns Under 40.5"
    m = re.match(r"^(.+?)\s+(?:@|vs\.?|v)\s+(.+?)\s+(Over|Under|O|U)\s*([\d.]+)(?:\s+(?:runs|goals|points|pts|total))?$", t, re.I)
    if m:
        return {"type": "total", "side": "over" if m[3].lower().startswith("o") else "under", "line": float(m[4]),
                "game": [m[1].strip(), m[2].strip()], "text": t}
    # team totals: "Valkyries O78.5 team pts", "Dream Over 75.5 team points", "Rangers team total over 3.5",
    # "NYY TT U4.5 runs", "Valkyries 79+ team pts"
    if re.search(r"\bteam\b|\bTT\b", t, re.I):
        u = r"(pts|points?|goals?|runs?)"
        s = re.sub(r"\s+", " ", re.sub(r"\bteam\s+totals?\b|\bteam\b|\bTT\b", " ", t, flags=re.I)).strip()
        m = re.match(r"^(.+?)\s+(Over|Under|O|U)\s*(\d+(?:\.\d+)?)\s*" + u + r"?$", s, re.I)
        if m:
            team, women = clean_team(m[1])
            return {"type": "teamtotal", "team": team, "side": "over" if m[2].lower().startswith("o") else "under",
                    "line": float(m[3]), "unit": (m[4] or "").lower() or None, "women": women, "text": t}
        m = re.match(r"^(.+?)\s+(\d+)\+\s*" + u + r"?$", s, re.I)
        if m:
            team, women = clean_team(m[1])
            return {"type": "teamtotal", "team": team, "side": "over", "line": int(m[2]) - 0.5,
                    "unit": (m[3] or "").lower() or None, "women": women, "text": t}
    # soccer: anytime goalscorer / score or assist
    m = re.match(r"^(.+?)\s+(?:AGS|anytime goal\s*scorer|anytime goal|to score)$", t, re.I)
    if m: return {"type": "prop", "player": m[1].strip(), "stat": "goal", "op": "min", "min": 1, "text": t}
    m = re.match(r"^(.+?)\s+(?:to\s+)?(?:score or assist|goal or assist|G\+A)$", t, re.I)
    if m: return {"type": "prop", "player": m[1].strip(), "stat": "goalOrAssist", "op": "min", "min": 1, "text": t}
    # "J. Carter TD", "Kelce anytime TD"
    m = re.match(r"^(.+?)\s+(?:anytime\s+)?(?:TD|touchdown)(?:\s+scorer)?$|^(.+?)\s+ATD$", t, re.I)
    if m: return {"type": "prop", "player": (m[1] or m[2]).strip(), "stat": "td", "op": "min", "min": 1, "text": t}
    # "M. Stokes 220+ pass yds", "Makar 1+ pts", "player 2+"
    m = re.match(r"^(.+?)\s+(\d+)\+\s*(.*)$", t)
    if m:
        player, n, words = m[1].strip(), int(m[2]), m[3]
        st = _prop_stat(words) if words else None
        out = {"type": "prop", "player": player, "stat": st, "op": "min", "min": n, "text": t}
        if words and not st: out["stat_raw"] = words
        if re.fullmatch(r"(any\s*)?player|anyone", player, re.I): out["player"] = None
        return out
    # "Yandy Diaz U0.5 doubles", "C. Simpson O1.5", "Caminero Under 1.5 total bases"
    m = re.match(r"^(.+?)\s+(Over|Under|O|U)\s*(\d+(?:\.\d+)?)\s*(.*)$", t, re.I)
    if m:
        side = "over" if m[2].lower().startswith("o") else "under"
        st = _prop_stat(m[4]) if m[4] else None
        out = {"type": "prop", "player": m[1].strip(), "stat": st, "op": side, "line": float(m[3]), "text": t}
        if m[4] and not st: out["stat_raw"] = m[4]
        return out
    m = re.match(r"^(.+?)\s+([+-]\d+(?:\.\d+)?)$", t)
    if m:
        team, women = clean_team(m[1])
        return {"type": "spread", "team": team, "line": float(m[2]), "women": women, "text": t}
    if re.search(r"\bML\b|moneyline", t + " " + market, re.I):
        team, women = clean_team(t)
        return {"type": "ml", "team": team, "women": women, "text": t}
    # single-bet player props worded as "Josh Hoover 2+ passing TDs" already handled above
    return {"type": "unknown", "text": t}

# ---------- player props: resolve "J. Carter" to a roster player on one of the two teams ----------
SUFFIX = {"jr", "sr", "ii", "iii", "iv", "v"}
def name_parts(s):
    """'J. Carter' -> ('j', 'carter'); 'Yandy Diaz' -> ('y', 'diaz'); 'Makar' -> (None, 'makar'); 'C.J. Stroud' -> ('c', 'stroud')."""
    w = [x for x in norm(s or "") if x not in SUFFIX]
    if not w: return None, None
    return (w[0][0] if len(w) > 1 else None), w[-1]

def player_match(bet_name, full_name):
    fi, last = name_parts(bet_name)
    if not last: return False
    w = [x for x in norm(full_name or "") if x not in SUFFIX]
    if not w: return False
    if w[-1] != last and last not in w[1:]: return False
    return fi is None or w[0][0] == fi

def team_roster(path, team_id):
    if not team_id: return []
    d = fetch(f"{ESPN}{path}/teams/{team_id}/roster")
    out = []
    for x in d.get("athletes", []) or []:
        for a in (x.get("items") if isinstance(x, dict) and "items" in x else [x]):
            if isinstance(a, dict) and (a.get("displayName") or a.get("fullName")):
                out.append({"id": a.get("id"), "name": a.get("displayName") or a.get("fullName")})
    return out

def resolve_props(bet):
    m = bet.get("match")
    if not m: return
    props = [L for L in bet["legs"] if L["type"] == "prop" and L.get("player")]
    if not props: return
    for L in props:
        hits = []
        for t in m["snapshot"]["teams"]:
            for a in team_roster(m["path"], t.get("id")):
                if player_match(L["player"], a["name"]): hits.append((t, a))
        teams = {t["abbr"] for t, _ in hits}
        if len(teams) == 1:
            L["pteam"] = hits[0][0]["abbr"]
            if len(hits) == 1: L["pname"], L["pid"] = hits[0][1]["name"], hits[0][1]["id"]
            else: L["pcands"] = [a["name"] for _, a in hits]

def candidate_paths(event, market):
    tag = re.search(r"\(([^)]*)\)", event)
    if tag:
        tu = tag[1].upper()
        for k, v in TAGS.items():
            if k in tu: return v
    if re.search(r"soccer", event + market, re.I): return TAGS["SOCCER"]
    return DEFAULT_PATHS

def find_game(names, paths, date, women=False):
    """Return best ESPN match for a list of team names."""
    days = [date + datetime.timedelta(days=k) for k in (0, 1, -1)] if date else []
    best = None
    for path in paths:
        groups_opts = [None, "81"] if path == "football/college-football" else [None]
        for d in days:
            ds = d.strftime("%Y%m%d")
            for g in groups_opts:
                for ev in fetch(sb_url(path, ds, g)).get("events", []):
                    comps = ev["competitions"][0]["competitors"]
                    hits = sum(any(team_match(n, c) for c in comps) for n in names)
                    if hits < len(names): continue
                    score = hits * 10 - abs((d - date).days) * 3
                    if path.startswith("soccer"):
                        is_w = "women" in (ev.get("season", {}).get("slug", "") + ev.get("name", "")).lower()
                        score += 2 if is_w == women else -5
                    if not best or score > best[0]:
                        best = (score, path, ds, g, ev)
                if best and best[2] == ds: break
            if best: break
        if best and best[0] >= len(names) * 10 - 1: break
    if not best: return None
    _, path, ds, g, ev = best
    if path == "soccer/all":  # resolve to a specific league so the browser fetch stays small
        summ = fetch(f"{ESPN}soccer/all/summary?event={ev['id']}")
        slug = summ.get("header", {}).get("league", {}).get("slug")
        if slug: path = "soccer/" + slug
    out = {"path": path, "date": ds, "groups": g, "id": ev["id"], "snapshot": snapshot(ev)}
    if path in PROB_PATHS and not ev["status"]["type"]["completed"]:
        sp, lg = path.split("/")
        pr = fetch(f"https://sports.core.api.espn.com/v2/sports/{sp}/leagues/{lg}/events/{ev['id']}/competitions/{ev['id']}/predictor")
        gp = lambda side: next((x.get("value") for x in pr.get(side, {}).get("statistics", []) if x.get("name") == "gameProjection"), None)
        if gp("homeTeam") is not None and gp("awayTeam") is not None:
            out["pregame"] = {"home": round(gp("homeTeam"), 1), "away": round(gp("awayTeam"), 1)}
    return out

def snapshot(ev):
    c = ev["competitions"][0]; st = ev["status"]
    return {"date": ev.get("date"), "period": st.get("period"), "clock": st.get("clock"), "state": st["type"]["state"], "completed": st["type"]["completed"], "detail": st["type"]["shortDetail"],
            "teams": [{"id": x["team"].get("id"), "name": x["team"].get("displayName"), "abbr": x["team"].get("abbreviation"),
                       "short": x["team"].get("shortDisplayName"), "nick": x["team"].get("name"), "location": x["team"].get("location"),
                       "home": x.get("homeAway") == "home", "score": x.get("score")} for x in c["competitors"]]}

def num(s):
    m = re.search(r"-?\d+(?:\.\d+)?", s or ""); return float(m[0]) if m else None

def _snap_comp(t):
    return {"team": {"displayName": t.get("name"), "abbreviation": t.get("abbr"), "shortDisplayName": t.get("short"),
                     "name": t.get("nick"), "location": t.get("location")}}

def team_totals_from_props(bet):
    """A 'prop' leg whose 'player' is actually one of the game's teams ("Dream O75.5 pts") is a team total."""
    m = bet.get("match")
    if not m: return
    teams = m["snapshot"]["teams"]
    for i, L in enumerate(bet["legs"]):
        if L.get("type") != "prop" or not L.get("player") or L.get("pteam"): continue
        if L.get("stat") not in (None, "pts", "goals", "runs"): continue
        if not any(team_match(L["player"], _snap_comp(t)) for t in teams): continue
        side = L.get("op"); line = L.get("line")
        if side == "min": side, line = "over", L["min"] - 0.5
        if side not in ("over", "under") or line is None: continue
        bet["legs"][i] = {"type": "teamtotal", "team": L["player"], "side": side, "line": line, "unit": None, "women": False, "text": L["text"]}
    for L in bet["legs"]:
        if L.get("type") == "teamtotal":
            L["team_ok"] = any(team_match(L["team"], _snap_comp(t)) for t in teams)

def build_bet(row):
    ev_raw = row["event"]; market = row["market"]; pick = row["pick"]
    ev_clean = re.sub(r"\s*\([^)]*\)", "", ev_raw).strip()
    date = parse_date(row)
    paths = candidate_paths(ev_raw, market)
    is_multi = bool(re.search(r"parlay|sgp|leg", market + " " + pick, re.I))
    leg_texts = [x for x in re.split(r"\s+\+\s+", pick) if x]
    same_game = bool(re.search(r"\s@\s|\svs\.?\s|\sv\s", ev_clean, re.I))
    if is_multi and len(leg_texts) < 2:
        leg_texts = [x for x in re.split(r"\s+\+\s+", ev_clean) if x]; same_game = False
    legs = [parse_leg(t, market) for t in leg_texts]
    bet = {"bet_id": row.get("bet_id", ""), "date": row["date"], "book": row["book"], "event": ev_clean, "market": market, "pick": pick,
           "start": row["start_et"], "price": row["price"], "boosted_price": row["boosted_price"],
           "stake": num(row["stake"]), "stake_note": "unconfirmed" if "unconfirmed" in row["stake"] else "",
           "to_win": num(row["to_win"]), "ev_pct": row["ev_pct"], "multi": is_multi, "legs": legs, "match": None,
           "sport": None}
    if same_game:
        teams = [t.strip() for t in re.split(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+", ev_clean, flags=re.I)]
        women_g = any(re.search(r"\s+(Women|W)$", t) for t in teams) or bool(re.search(r"NWSL|WNBA|\bWomen\b", ev_raw + " " + market))
        teams = [team_alias(re.sub(r"\s+(Women|W)$", "", t)) for t in teams]
        bet["match"] = find_game(teams, paths, date, women_g)
        if not bet["match"] and paths != TAGS["SOCCER"]:  # untagged soccer games (e.g. "Man City vs Ipswich Town")
            bet["match"] = find_game(teams, TAGS["SOCCER"], date, women_g)
        if bet["match"]:
            for L in legs:
                if L.get("team"):  # resolve abbreviations like "SEA" against the matched game
                    if re.search(r"\s+(Women|W)$", L["team"]): L["women"] = True
                    L["team"] = team_alias(re.sub(r"\s+(Women|W)$", "", L["team"]))
                    L["team_ok"] = any(team_match(L["team"], {"team": {"displayName": t["name"], "abbreviation": t["abbr"]}})
                                       for t in bet["match"]["snapshot"]["teams"])
    else:
        for L in legs:
            if L.get("team"): L["match"] = find_game([L["team"]], paths, date, L.get("women", False))
            elif L.get("game"): L["match"] = find_game(L["game"], paths, date)
    m = bet["match"] or next((L.get("match") for L in legs if L.get("match")), None)
    if m: bet["sport"] = "Soccer" if m["path"].startswith("soccer") else SPORT_LABEL.get(m["path"], m["path"])
    elif "soccer" in (ev_raw + market).lower(): bet["sport"] = "Soccer"
    try: resolve_props(bet)
    except Exception as e: print("prop resolve fail", bet["pick"], e, file=sys.stderr)
    team_totals_from_props(bet)
    return bet

# ---------- pregame Pinnacle inputs for the client-side estimate ----------
PIN_SID = {"football/nfl": (15, "NFL"), "football/college-football": (15, "NCAA"), "hockey/nhl": (19, "NHL"),
           "baseball/mlb": (3, "MLB"), "basketball/nba": (4, "NBA")}
_pin = {}
def pin_games(sid):
    if CI or os.environ.get("NO_PINNACLE"): return []   # Actions: use data/pregame_cache.json only
    if sid not in _pin:
        try:
            sys.path.insert(0, "/workspace/sportsbets")   # box-only scanner modules
            from ev_strict import pinnacle_sport
            from ev_finder import pinnacle_key
            _pin[sid] = pinnacle_sport(sid, pinnacle_key())
        except Exception as e:
            print("pinnacle fetch failed", sid, e, file=sys.stderr); _pin[sid] = []
    return _pin[sid]

def implied(a): return -a / (-a + 100) if a < 0 else 100 / (a + 100)
def nv(a, b):  # no-vig fair of side a
    x, y = implied(a), implied(b); return x / (x + y)

def names_match(pin_name, espn_team):
    return team_match(pin_name, {"team": {"displayName": espn_team["name"], "abbreviation": espn_team["abbr"],
                                          "shortDisplayName": espn_team.get("short"), "location": espn_team.get("location"),
                                          "name": espn_team.get("nick")}}) or team_match(espn_team.get("location") or "", {"team": {"displayName": pin_name}})

def pin_inputs_live(m):
    sid, lg = PIN_SID.get(m["path"], (None, None))
    if not sid: return None
    tm = m["snapshot"]["teams"]; H = next(t for t in tm if t["home"]); A = next(t for t in tm if not t["home"])
    for g in pin_games(sid):
        if not g["league"].startswith(lg): continue
        if not (names_match(g["home"], H) and names_match(g["away"], A)): continue
        mk = g["markets"]; out = {"src": "Pinnacle no-vig", "pulled": now_et().strftime("%Y-%m-%d %H:%M ET")}
        ml = mk.get("ml", {}).get("prices", {})
        if "home" in ml and "away" in ml: out["ml_home"] = round(nv(ml["home"], ml["away"]), 4)
        def main_line(kind, a, b):
            c = [(k[1], v["prices"]) for k, v in mk.items() if isinstance(k, tuple) and k[0] == kind and a in v["prices"] and b in v["prices"]]
            nonalt = [(k[1], v["prices"]) for k, v in mk.items() if isinstance(k, tuple) and k[0] == kind and not v.get("alt") and a in v["prices"] and b in v["prices"]]
            c = nonalt or c
            return min(c, key=lambda x: abs(nv(x[1][a], x[1][b]) - 0.5)) if c else None
        sp = main_line("sp", "home", "away")
        if sp: out["spread_home_line"] = sp[0]; out["spread_home_fair"] = round(nv(sp[1]["home"], sp[1]["away"]), 4)
        tot = main_line("tot", "over", "under")
        if tot: out["total_line"] = tot[0]; out["total_over_fair"] = round(nv(tot[1]["over"], tot[1]["under"]), 4)
        return out
    return None

def pin_inputs_from_scans(m):
    """Fallback for games that already started: latest saved ev_strict scan that has this game (main lines)."""
    import glob
    tm = m["snapshot"]["teams"]; H = next(t for t in tm if t["home"]); A = next(t for t in tm if not t["home"])
    files = []
    for f in ([] if CI else glob.glob("/tmp/*.json") + glob.glob("/workspace/sportsbets/*.json")):
        try:
            d = json.load(open(f))
            if isinstance(d, dict) and "rows" in d and "pulled" in d: files.append((datetime.datetime.strptime(d["pulled"], "%Y-%m-%d %I:%M:%S %p ET"), d))
        except Exception: pass
    start = datetime.datetime.fromisoformat(m["snapshot"]["date"].replace("Z", "+00:00")).astimezone().replace(tzinfo=None) if m["snapshot"].get("date") else None
    for pulled, d in sorted(files, key=lambda x: x[0], reverse=True):
        if start and pulled > start: continue
        out, cand = {}, {"sp": [], "tot": []}
        for r in d["rows"]:
            ev = r.get("event", "")
            if " @ " not in ev or r.get("pin_line_type", "main") != "main": continue
            a, h = ev.split(" @ ", 1)
            if not (names_match(h, H) and names_match(a, A)): continue
            pp = {k: int(v) for k, v in re.findall(r"(home|away|over|under) ([+-]\d+)", r.get("pin_prices", ""))}
            if r["market"] == "Moneyline" and "home" in pp and "away" in pp: out["ml_home"] = round(nv(pp["home"], pp["away"]), 4)
            elif r["market"] == "Spread" and "home" in pp and "away" in pp:
                mm = re.search(r"([+-]\d+(?:\.\d+)?)$", r["selection"])
                if not mm: continue
                line = float(mm[1]); is_home = names_match(r["selection"][:mm.start()].strip(), H)
                cand["sp"].append((line if is_home else -line, nv(pp["home"], pp["away"])))
            elif r["market"] == "Total" and "over" in pp and "under" in pp:
                mm = re.search(r"(\d+(?:\.\d+)?)$", r["selection"])
                if mm: cand["tot"].append((float(mm[1]), nv(pp["over"], pp["under"])))
        if cand["sp"]:
            l, f = min(cand["sp"], key=lambda x: abs(x[1] - 0.5)); out["spread_home_line"] = l; out["spread_home_fair"] = round(f, 4)
        if cand["tot"]:
            l, f = min(cand["tot"], key=lambda x: abs(x[1] - 0.5)); out["total_line"] = l; out["total_over_fair"] = round(f, 4)
        if out:
            out.update(src="Pinnacle no-vig (saved scan)", pulled=pulled.strftime("%Y-%m-%d %H:%M ET")); return out
    return None

# ---------- Polymarket + Action Network ids (client polls live prices with these) ----------
PM_TAGS = {"football/nfl": ["nfl"], "football/college-football": ["cfb"], "hockey/nhl": ["nhl"], "baseball/mlb": ["mlb"],
           "basketball/nba": ["nba"]}
AN_LG = {"football/nfl": "nfl", "football/college-football": "ncaaf", "hockey/nhl": "nhl", "baseball/mlb": "mlb", "basketball/nba": "nba"}
PM_SLUG = re.compile(r"^[a-z]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$")
_pm_tag = {}
def pm_tag_events(tag):
    if tag not in _pm_tag:
        out = []
        for off in range(0, 600, 100):
            d = fetch(f"https://gamma-api.polymarket.com/events?tag_slug={tag}&active=true&closed=false&limit=100&offset={off}")
            if not isinstance(d, list) or not d: break
            out += [e for e in d if e.get("startTime")]
        _pm_tag[tag] = out
    return _pm_tag[tag]

def pm_markets(ev):
    def L(x):
        try: return json.loads(x) if isinstance(x, str) else (x or [])
        except Exception: return []
    out = {"slug": ev["slug"], "title": ev.get("title"), "spreads": [], "totals": []}
    for mk in ev.get("markets", []):
        t = mk.get("sportsMarketType"); toks = L(mk.get("clobTokenIds")); outs = L(mk.get("outcomes"))
        if len(toks) != 2 or len(outs) != 2: continue
        if t == "moneyline" and "ml" not in out: out["ml"] = {"outcomes": outs, "tokens": toks}
        elif t == "spreads" and mk.get("line") is not None: out["spreads"].append({"line": float(mk["line"]), "outcomes": outs, "tokens": toks})
        elif t == "totals" and mk.get("line") is not None: out["totals"].append({"line": float(mk["line"]), "outcomes": outs, "tokens": toks})
    return out if "ml" in out else None

def pm_find(m):
    tm = m["snapshot"]["teams"]; H = next(t for t in tm if t["home"]); A = next(t for t in tm if not t["home"])
    start = datetime.datetime.fromisoformat(m["snapshot"]["date"].replace("Z", "+00:00"))
    cands = []
    for tag in PM_TAGS.get(m["path"], []): cands += pm_tag_events(tag)
    for q in {f"{A.get('location') or ''} {H.get('location') or ''}", f"{A.get('nick') or ''} {H.get('nick') or ''}"}:
        d = fetch("https://gamma-api.polymarket.com/public-search?" + urllib.parse.urlencode({"q": q.strip(), "limit_per_type": 15, "events_status": "all"}))
        cands += [e for e in (d.get("events") or []) if e.get("startTime")]
    for e in cands:
        if not PM_SLUG.match(e.get("slug", "")): continue
        try: st = datetime.datetime.fromisoformat(e["startTime"].replace("Z", "+00:00"))
        except Exception: continue
        if abs((st - start).total_seconds()) > 4 * 3600: continue
        parts = re.split(r"\s+vs\.?\s+", e.get("title", ""))
        if len(parts) != 2: continue
        if not ((names_match(parts[0], A) and names_match(parts[1], H)) or (names_match(parts[0], H) and names_match(parts[1], A))): continue
        full = fetch(f"https://gamma-api.polymarket.com/events?slug={e['slug']}")
        ev = full[0] if isinstance(full, list) and full else e
        return pm_markets(ev)
    return None

def an_find(m):
    lg = AN_LG.get(m["path"])
    if not lg: return None
    tm = m["snapshot"]["teams"]; H = next(t for t in tm if t["home"]); A = next(t for t in tm if not t["home"])
    d = fetch(f"https://api.actionnetwork.com/web/v2/scoreboard/{lg}?bookIds=15,68,69,79,123&periods=event&date={m['date']}")
    for g in d.get("games", []):
        teams = {t["id"]: t for t in g.get("teams", [])}
        ah, aa = teams.get(g.get("home_team_id"), {}), teams.get(g.get("away_team_id"), {})
        if names_match(ah.get("full_name", ""), H) and names_match(aa.get("full_name", ""), A):
            return {"id": g["id"], "home_team_id": g["home_team_id"], "away_team_id": g["away_team_id"]}
    return None

def attach_live_ids(bets):
    ms = {}
    for b in bets:
        for m in [b["match"]] + [L.get("match") for L in b["legs"]]:
            if m and m["path"] in AN_LG and not m["snapshot"]["completed"]: ms[m["id"]] = m
    def work(m):
        try: m["pm"] = pm_find(m)
        except Exception as e: print("pm fail", m["id"], e, file=sys.stderr)
        try: m["an"] = an_find(m)
        except Exception as e: print("an fail", m["id"], e, file=sys.stderr)
    with ThreadPoolExecutor(6) as ex: list(ex.map(work, ms.values()))
    # every reference to the same game gets the same ids
    for b in bets:
        for m in [b["match"]] + [L.get("match") for L in b["legs"]]:
            if m and m["id"] in ms: m["pm"], m["an"] = ms[m["id"]].get("pm"), ms[m["id"]].get("an")

def attach_pregame(bets):
    cache = json.load(open(PIN_CACHE)) if os.path.exists(PIN_CACHE) else {}
    ms = [b["match"] for b in bets if b["match"]] + [L["match"] for b in bets for L in b["legs"] if L.get("match")]
    for m in ms:
        if m["path"] not in PIN_SID: continue
        if m["snapshot"]["state"] == "pre":
            got = pin_inputs_live(m)
            if got: cache[m["id"]] = got
        if m["id"] not in cache:
            got = pin_inputs_from_scans(m)
            if got: cache[m["id"]] = got
        if m["id"] in cache: m["pin"] = cache[m["id"]]
    json.dump(cache, open(PIN_CACHE, "w"), indent=1)

def all_final(b):
    """True when every game this bet depends on is final (ESPN completed). Unmatched legs / futures -> False."""
    ms = [b["match"]] if b["match"] else [L.get("match") for L in b["legs"]]
    return bool(ms) and all(m and m["snapshot"].get("completed") for m in ms)

VOLATILE = {"period", "clock", "state", "detail", "score", "pulled", "pregame"}
def _stable(x):
    """data.json minus live-volatile fields (the browser refreshes those itself) -> hash for change detection."""
    if isinstance(x, dict): return {k: _stable(v) for k, v in x.items() if k not in VOLATILE}
    if isinstance(x, list): return [_stable(v) for v in x]
    return x

def build_static(verbose=True):
    """stats.json / archive.json / log.json (no network)."""
    import statsgen; return statsgen.build_static(verbose)

def build(verbose=True):
    """Rebuild data.json. Returns True if it changed."""
    try:
        import importlib; R = importlib.import_module("rec"); recs = R.dash_payload(R.load())
    except Exception as e:
        print("REC PAYLOAD FAILED:", e); recs = None
    rows = all_bets()   # live bets.csv + archive (full history for totals)
    open_rows = [r for r in rows if r["result"].strip().lower() == "open"]
    with ThreadPoolExecutor(8) as ex: bets = list(ex.map(build_bet, open_rows))
    attach_pregame(bets)
    attach_live_ids(bets)
    bal = list(csv.DictReader(open(BAL)))
    balances = [{"book": b["book"], "balance": float(b["balance_cad"]) if b["balance_cad"] else None,
                 "updated": b["updated_et"]} for b in bal]
    balances.sort(key=lambda b: -(b["balance"] or 0))
    total = round(sum(b["balance"] or 0 for b in balances), 2)
    recent_cut = (now_et().date() - datetime.timedelta(days=5)).isoformat()
    settled = [{"date": r["date"], "book": r["book"], "event": re.sub(r"\s*\([^)]*\)", "", r["event"]),
                "pick": r["pick"], "result": r["result"], "pnl": num(r["pnl"]), "stake": num(r["stake"]),
                "auto": "auto" in (r.get("settled_by") or "")}
               for r in rows if r["result"].strip().lower() not in ("open", "") and r["date"] >= recent_cut]
    pnl_total = round(sum(num(r["pnl"]) or 0 for r in rows if r["result"].strip().lower() not in ("open", "")), 2)
    auto = json.load(open(AUTO)) if os.path.exists(AUTO) else {}
    data = {"balances": balances, "total": total, "open": bets, "settled_recent": settled[::-1],
            "pnl_total": pnl_total, "open_stake": round(sum(b["stake"] or 0 for b in bets if not all_final(b)), 2),
            "recs": recs,
            "auto": {"needs_review": auto.get("needs_review", []), "last_settled": auto.get("last_settled", []),
                     "last_change_at": auto.get("last_change_at")},
            "open_live_n": sum(1 for b in bets if not all_final(b)),
            "open_stake_by_book": {bk: round(sum(b["stake"] or 0 for b in bets if b["book"] == bk and not all_final(b)), 2) for bk in sorted({b["book"] for b in bets}, key=str.lower)}}
    h = hashlib.sha1(json.dumps(_stable(data), sort_keys=True).encode()).hexdigest()
    out = os.path.join(REPO, "data.json")
    try: old = json.load(open(out))
    except Exception: old = {}
    changed = old.get("hash") != h
    if changed:
        data["hash"] = h
        data["generated_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        json.dump(data, open(out, "w"), indent=1)
    try: build_static(verbose)
    except Exception as e: print("STATIC FILES FAILED:", e)
    if verbose:
        unmatched = []
        for b in bets:
            if b["match"] is None and not any(L.get("match") for L in b["legs"]): unmatched.append(b["pick"])
            elif b["multi"] and b["match"] is None:
                unmatched += [f'{b["event"]}: leg "{L["text"]}"' for L in b["legs"] if not L.get("match")]
        print(f"build: {len(bets)} open bets, total ${total:.2f}, data.json {'CHANGED' if changed else 'unchanged'}; unmatched: {unmatched or 'none'}")
    return changed

if __name__ == "__main__":
    from common import lock
    with lock(): build_static() if "--static" in sys.argv else build()
