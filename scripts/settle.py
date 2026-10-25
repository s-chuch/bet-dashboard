#!/usr/bin/env python3
"""Deterministic auto-grader for open bets (used by autorun.py).

grade_row(row) -> dict(status=..., result=..., reason=..., legs=[...])
  status "settle"  : every game final, every leg matched + graded unambiguously -> result won|lost|push|void
  status "waiting" : some game not final yet (or a future)                     -> nothing to do
  status "review"  : final but something is ambiguous                          -> needs_review (never auto-settled)

Book void rules (player who doesn't play):
  bet365 soccer player props: void if the player doesn't START.
  FanDuel / DraftKings / Caesars / theScore / others: void only if he never plays; a parlay is then repriced
     (we can't know the repriced odds, so a voided leg in a winning parlay -> review).
  PointsBet / Hard Rock: a voided leg voids the whole SGP.
Postponed / canceled / suspended single-game bets (all legs in one game) auto-void once the game is still not
  completed 48h after its scheduled start (postponed_void); before that they sit in review with the auto-void time.
  Multi-game parlays with such a game always go to review.
Anything not explicitly decidable goes to review.
"""
import re, sys, os, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import build as P

ALIASES = {r"chicago red stars": "Chicago Stars", r"^man utd$": "Manchester United", r"^man city$": "Manchester City",
           r"^wolves$": "Wolverhampton", r"^spurs$": "Tottenham", r"^alaves$": "Alavés"}
def alias(n):
    for k, v in ALIASES.items():
        if re.search(k, n, re.I): return v
    return n

WHOLE_VOID = {"pointsbet", "hard rock", "hardrock", "hard rock bet"}
ESPN = P.ESPN

class Review(Exception): pass

def fnum(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "")); return float(m[0]) if m else None

# ---------------------------------------------------------------- leg parsing (extends build.parse_leg)
def parse_leg(t, market):
    t = re.sub(r"\s*\([^)]*\)", "", t).strip()
    # "Penguins @ Golden Knights Over 6.5"  -> game total for a named game (multi-game parlays)
    m = re.match(r"^(.+?)\s+(?:@|vs\.?|v)\s+(.+?)\s+(Over|Under|O|U)\s*([\d.]+)(?:\s+\w+)?$", t, re.I)
    if m:
        return {"type": "total", "side": "over" if m[3].lower().startswith("o") else "under", "line": float(m[4]),
                "game": [m[1].strip(), m[2].strip()], "text": t}
    # "Over 2.5 total doubles" -> game-level stat total
    m = re.match(r"^(Over|Under|O|U)\s*([\d.]+)\s+(?:total\s+)?(doubles|home runs|hrs|hits)$", t, re.I)
    if m:
        st = {"doubles": "doubles", "home runs": "hr", "hrs": "hr", "hits": "hits"}[m[3].lower()]
        return {"type": "gamestat", "stat": st, "side": "over" if m[1].lower().startswith("o") else "under", "line": float(m[2]), "text": t}
    m = re.match(r"^(.+?)\s+(?:ATTD|anytime TD scorer|anytime touchdown scorer)$", t, re.I)
    if m: return {"type": "prop", "player": m[1].strip(), "stat": "td", "op": "min", "min": 1, "text": t}
    m = re.match(r"^(.+?)\s+to hit an? (?:HR|home run)$", t, re.I)
    if m: return {"type": "prop", "player": m[1].strip(), "stat": "hr", "op": "min", "min": 1, "text": t}
    m = re.match(r"^(.+?)\s+(\d+)\+\s*(K|Ks|strikeouts)$", t, re.I)
    if m: return {"type": "prop", "player": m[1].strip(), "stat": "k", "op": "min", "min": int(m[2]), "text": t}
    if re.fullmatch(r"draw|tie|the draw", t, re.I): return {"type": "draw", "text": t}
    L = P.parse_leg(t, market)
    if L["type"] == "unknown" and not re.search(r"\d", t) and re.search(r"moneyline|3-way|ml\b", market, re.I):
        team, women = P.clean_team(re.sub(r"\s+Women$", " W", t))
        L = {"type": "ml", "team": team, "women": women, "text": t}
    # 'prop' with no stat (e.g. "Caminero U1.5") is unknown; 'pts' etc. fine
    return L

# ---------------------------------------------------------------- games
def game_status(m):
    s = P.fetch(f"{ESPN}{m['path']}/summary?event={m['id']}")
    st = (s.get("header", {}).get("competitions") or [{}])[0].get("status", {}).get("type", {})
    return s, st

def is_final(st):
    return bool(st.get("completed")) and st.get("state") == "post" and not re.search(r"POSTPONED|CANCEL|SUSPEND|FORFEIT|ABANDON", st.get("name", ""))

def soccer(m): return m["path"].startswith("soccer")

def scores(s, m):
    comp = s["header"]["competitions"][0]["competitors"]
    out = []
    for c in comp:
        t = c["team"]
        out.append({"name": t.get("displayName"), "abbr": t.get("abbreviation"), "short": t.get("shortDisplayName"),
                    "nick": t.get("name"), "location": t.get("location"), "home": c.get("homeAway") == "home",
                    "score": float(c.get("score") or 0), "id": t.get("id")})
    return out

def which_team(name, teams):
    name = alias(re.sub(r"\s+(Women|W)$", "", name.strip()))
    hits = [i for i, t in enumerate(teams) if P.team_match(name, P._snap_comp(t))]
    if len(hits) != 1:
        w = set(P.norm(name)) - {"ml", "fc", "the", "w", "women"}
        hits2 = [i for i, t in enumerate(teams) if w and w <= set(P.norm(" ".join(filter(None, [t["name"], t["location"], t["nick"], t["abbr"]]))))]
        if len(hits2) == 1: return hits2[0]
        raise Review(f'team "{name}" not matched to exactly one side ({len(hits)} hits)')
    return hits[0]

# ---------------------------------------------------------------- player stats from the ESPN summary
def _num(v):
    try: return float(str(v).split("/")[0].split("-")[0])
    except Exception: return None

def players_of(s, m):
    """[{name, id, team, starter, played, stats{...}}] for one game."""
    out = {}
    def P_(aid, name, team):
        return out.setdefault(aid or name, {"name": name, "id": aid, "team": team, "stats": {}, "cats": set(), "played": True, "starter": None})
    if soccer(m):
        for r in s.get("rosters", []):
            tm = r.get("team", {}).get("abbreviation")
            for p in r.get("roster", []):
                a = p.get("athlete", {}); q = P_(a.get("id"), a.get("displayName"), tm)
                q["starter"] = bool(p.get("starter")); q["played"] = bool(p.get("starter") or p.get("subbedIn"))
                q["stats"] = {x["name"]: x.get("value") for x in p.get("stats", [])}
        return list(out.values())
    for t in s.get("boxscore", {}).get("players", []):
        tm = t.get("team", {}).get("abbreviation")
        for c in t.get("statistics", []):
            keys = c.get("keys") or []; cat = c.get("name") or ("batting" if "atBats" in keys else "pitching" if "earnedRuns" in keys else "")
            for a in c.get("athletes", []):
                ath = a.get("athlete", {}); q = P_(ath.get("id"), ath.get("displayName"), tm)
                if not a.get("stats"): continue
                q["cats"].add(cat)
                if a.get("didNotPlay"): q["played"] = False
                for k, v in zip(keys, a["stats"]):
                    q["stats"][f"{cat}.{k}"] = v
                    if "-" in k and "-" in str(v):   # "hits-atBats" style
                        for kk, vv in zip(k.split("-"), str(v).split("-")): q["stats"].setdefault(f"{cat}.{kk}", vv)
                    if "/" in k and "/" in str(v):
                        for kk, vv in zip(k.split("/"), str(v).split("/")): q["stats"].setdefault(f"{cat}.{kk}", vv)
    return list(out.values())

def mlb_hit_types(s):
    """batter athlete id -> {'single','double','triple','home-run'} counts from the play-by-play."""
    out = {}
    for p in s.get("plays", []):
        ty = (p.get("type") or {}).get("type")
        if ty not in ("single", "double", "triple", "home-run"): continue
        b = next((x["athlete"]["id"] for x in p.get("participants", []) if x.get("type") == "batter"), None)
        if b: out.setdefault(b, {}).setdefault(ty, 0); out[b][ty] += 1
    return out

def stat_value(stat, pl, s, m):
    g = lambda k: _num(pl["stats"].get(k))
    sp = m["path"]
    if soccer(m):
        S = pl["stats"]; v = lambda k: S.get(k)
        cards = None if v("yellowCards") is None and v("redCards") is None else (v("yellowCards") or 0) + (v("redCards") or 0)
        # same stats as home.js: fouls committed/drawn, cards (yellow+red), offsides; ESPN has no per-player tackles (-> missing -> review)
        mp = {"goal": v("totalGoals"), "goals": v("totalGoals"), "assists": v("goalAssists"), "sot": v("shotsOnTarget"),
              "sog": v("shotsOnTarget"), "shots": v("totalShots"), "foulsC": v("foulsCommitted"), "foulsD": v("foulsSuffered"),
              "offsides": v("offsides"), "cards": cards, "saves": v("saves")}
        if stat == "goalOrAssist":
            return None if v("totalGoals") is None or v("goalAssists") is None else (v("totalGoals") + v("goalAssists") > 0) * 1.0
        return mp.get(stat)
    if sp.startswith("football"):
        f = lambda k: g(k) or 0.0
        if stat == "td":
            return sum(f(k) for k in ("rushing.rushingTouchdowns", "receiving.receivingTouchdowns", "kickReturns.kickReturnTouchdowns",
                                       "puntReturns.puntReturnTouchdowns", "interceptions.interceptionTouchdowns"))
        mp = {"passYds": "passing.passingYards", "passTD": "passing.passingTouchdowns", "rushYds": "rushing.rushingYards",
              "rushTD": "rushing.rushingTouchdowns", "recYds": "receiving.receivingYards", "recTD": "receiving.receivingTouchdowns",
              "receptions": "receiving.receptions"}
        if stat == "rushRecYds": return f("rushing.rushingYards") + f("receiving.receivingYards")
        return f(mp[stat]) if stat in mp else None
    if sp.startswith("hockey"):
        cat = next((c for c in pl["cats"] if c in ("forwards", "defenses", "skaters")), None)
        if stat == "saves": return g("goalies.saves")
        if not cat: return None
        G, A, S_ = g(f"{cat}.goals"), g(f"{cat}.assists"), g(f"{cat}.shotsTotal")
        return {"goal": G, "goals": G, "assists": A, "pts": None if G is None or A is None else G + A, "sog": S_, "shots": S_}.get(stat)
    if sp.startswith("baseball"):
        bat = "batting" if "batting" in pl["cats"] else None
        pit = "pitching" if "pitching" in pl["cats"] else None
        if stat == "k" and pit: return g("pitching.strikeouts")
        if not bat: return None
        H, R, RBI, HR = g("batting.hits"), g("batting.runs"), g("batting.RBIs"), g("batting.homeRuns")
        if stat in ("hits", "hr", "rbi", "runs", "walks", "k", "hrr"):
            return {"hits": H, "hr": HR, "rbi": RBI, "runs": R, "walks": g("batting.walks"), "k": g("batting.strikeouts"),
                    "hrr": None if None in (H, R, RBI) else H + R + RBI}[stat]
        if stat in ("tb", "doubles", "triples", "singles"):
            ht = mlb_hit_types(s).get(pl["id"], {})
            n1, n2, n3, n4 = (ht.get(k, 0) for k in ("single", "double", "triple", "home-run"))
            if H is None or n1 + n2 + n3 + n4 != H or n4 != HR: raise Review(f"{pl['name']}: play-by-play hits don't reconcile with box score")
            return {"tb": n1 + 2 * n2 + 3 * n3 + 4 * n4, "doubles": n2, "triples": n3, "singles": n1}[stat]
        return None
    if sp.startswith("basketball"):
        mp = {"pts": "points", "reb": "rebounds", "assists": "assists", "threes": "threePointFieldGoalsMade"}
        if stat not in mp: return None
        for k, v in pl["stats"].items():
            if k.endswith("." + mp[stat]): return _num(v)
        return None
    return None

def _soccer_squad_dnp(name, games):
    """True when `name` matches exactly one player on one of the game's two teams' season rosters but nobody in the
    final matchday squad (starters + bench), so he did not play. Anything unclear (several matches, no roster,
    roster fetch failure, non-soccer, matchday squad missing) -> False -> the caller sends it to review."""
    try:
        for m, s, st in games:
            if not soccer(m): continue
            squad = players_of(s, m)
            if len(squad) < 14: continue                      # no real matchday squad published
            hits = set()
            for t in m["snapshot"]["teams"]:
                for a in P.team_roster(m["path"], t["id"]):
                    if P.player_match(name, a["name"]): hits.add(a["id"] or a["name"])
            if len(hits) == 1: return True
    except Exception:
        return False
    return False

def cmp(val, L):
    if L["op"] == "min": return "won" if val >= L["min"] else "lost"
    if val == L["line"]: return "push"
    return "won" if (val > L["line"]) == (L["op"] == "over") else "lost"

# ---------------------------------------------------------------- grading
def grade_leg(L, games, book, ctx):
    """games: list of (match, summary, status). Returns won|lost|push|void."""
    t = L["type"]
    if t == "unknown" or (t == "prop" and not L.get("stat")):
        raise Review(f'leg "{L["text"]}": market/stat not recognised')
    if t == "prop":
        cands = []
        for m, s, st in games:
            for pl in players_of(s, m):
                if P.player_match(L["player"], pl["name"]): cands.append((m, s, pl))
        if len(cands) == 0 and _soccer_squad_dnp(L["player"], games):
            return "void"   # on the team's season roster but not in the matchday squad: never played
        if len(cands) == 0:
            raise Review(f'leg "{L["text"]}": player "{L["player"]}" not in any box score (DNP void, or name mismatch?)')
        if len({c[2]["id"] or c[2]["name"] for c in cands}) > 1:
            bw = [w for w in P.norm(L["player"]) if w not in P.SUFFIX]
            if len(bw) > 1 and len(bw[0]) > 1:   # full first name given: keep exact first+last matches
                ex = [c for c in cands if [w for w in P.norm(c[2]["name"]) if w not in P.SUFFIX][:1] == bw[:1]]
                if len({c[2]["id"] or c[2]["name"] for c in ex}) == 1: cands = ex
        if len({c[2]["id"] or c[2]["name"] for c in cands}) > 1:
            raise Review(f'leg "{L["text"]}": "{L["player"]}" matches several players ({", ".join(c[2]["name"] for c in cands[:4])})')
        m, s, pl = cands[0]
        if soccer(m):
            if not pl["played"]: return "void"
            if book.lower() == "bet365" and pl["starter"] is False: return "void"
        elif not pl["played"]:
            return "void"
        val = stat_value(L["stat"], pl, s, m)
        if val is None: raise Review(f'leg "{L["text"]}": stat {L["stat"]} missing for {pl["name"]}')
        if L["stat"] == "td" and val == 0:
            nm = P.name_parts(pl["name"])[1]
            if any(nm in P.norm(p.get("text", "")) and "touchdown" in p.get("text", "").lower() for p in s.get("scoringPlays", [])):
                raise Review(f'leg "{L["text"]}": {pl["name"]} named in a TD scoring play but no rush/rec/return TD')
        return cmp(val, L)
    # team / game legs: pick the game
    if L.get("game"):
        gs = [g for g in games if all(any(P.team_match(n, P._snap_comp(x)) for x in scores(g[1], g[0])) for n in L["game"])]
    elif L.get("team"):
        gs = [g for g in games if any(P.team_match(alias(L["team"]), P._snap_comp(x)) for x in scores(g[1], g[0]))]
        if len(gs) != 1 and len(games) == 1: gs = games
    else:
        gs = games if len(games) == 1 else []
    if len(gs) != 1: raise Review(f'leg "{L["text"]}": can\'t tell which game it belongs to')
    m, s, st = gs[0]; teams = scores(s, m)
    name = st.get("name", "")
    if soccer(m) and re.search(r"AET|PEN|EXTRA", name):
        raise Review(f'leg "{L["text"]}": soccer game went to extra time/penalties ({name})')
    sc = [x["score"] for x in teams]
    if t == "draw":
        if not soccer(m): raise Review(f'leg "{L["text"]}": draw on a non-soccer game')
        return "won" if sc[0] == sc[1] else "lost"
    if t == "total":
        tot = sum(sc)
        return "push" if tot == L["line"] else ("won" if (tot > L["line"]) == (L["side"] == "over") else "lost")
    if t == "gamestat":
        if not m["path"].startswith("baseball"): raise Review(f'leg "{L["text"]}": game stat only supported for MLB')
        if L["stat"] == "doubles":
            ht = mlb_hit_types(s); val = sum(v.get("double", 0) for v in ht.values())
            hits_box = sum(_num(pl["stats"].get("batting.hits")) or 0 for pl in players_of(s, m))
            if sum(sum(v.values()) for v in ht.values()) != hits_box: raise Review(f'leg "{L["text"]}": play-by-play hits don\'t reconcile')
        else: raise Review(f'leg "{L["text"]}": game stat {L["stat"]} not supported')
        return "push" if val == L["line"] else ("won" if (val > L["line"]) == (L["side"] == "over") else "lost")
    i = which_team(L["team"], teams); me, op = sc[i], sc[1 - i]
    if t == "teamtotal":
        return "push" if me == L["line"] else ("won" if (me > L["line"]) == (L["side"] == "over") else "lost")
    if t == "spread":
        d = me + L["line"] - op
        return "won" if d > 0 else "push" if d == 0 else "lost"
    if t == "ml":
        if me == op:
            if soccer(m): return "lost"   # 3-way ML: a draw loses
            raise Review(f'leg "{L["text"]}": game ended tied (ML tie rules vary)')
        return "won" if me > op else "lost"
    raise Review(f'leg "{L["text"]}": unsupported leg type {t}')

# ---------------------------------------------------------------- postponed / cancelled single-game bets
VOID_GRACE_HOURS = 48
VOIDABLE_STATUS = {"STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_SUSPENDED"}

def _single_game_bet(row, legs, ms):
    """True only when we are sure every leg belongs to the one matched game (single bet or same-game parlay)."""
    if len(ms) != 1: return False
    ev = re.sub(r"^\s*[A-Z]{2,6}\s*:\s*", "", re.sub(r"\s*\([^)]*\)", "", row["event"]))
    pieces = [p for p in re.split(r"\s+\+\s+|,\s*", ev) if p.strip()]
    if len(pieces) != 1: return False
    if not re.search(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+", pieces[0]): return False
    # a leg naming its own game (multi-game parlay syntax) must name the same game as the event
    norm = lambda x: re.sub(r"\W+", "", x).lower()
    for L in legs:
        if L.get("game") and {norm(x) for x in L["game"]} != {norm(x) for x in re.split(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+", pieces[0])}:
            return False
    return True

def _makeup_game(m, sched):
    """A postponed game is often replayed as a NEW ESPN event (doubleheader, next day). Look for another game of the same two
    teams within 7 days of the scheduled start. -> dict (found) | {} (none found) | None (could not check)."""
    try:
        ids = {t["id"] for t in m["snapshot"]["teams"]}
        if len(ids) != 2: return None
        got_any = False
        for k in range(0, 8):
            d = (sched + datetime.timedelta(days=k)).strftime("%Y%m%d")
            j = P.fetch(P.sb_url(m["path"], d))
            if j.get("events"): got_any = True
            for ev in j.get("events", []):
                if str(ev.get("id")) == str(m["id"]): continue
                comps = ev["competitions"][0]["competitors"]
                if {str(c["team"].get("id") or c.get("id")) for c in comps} == {str(i) for i in ids}:
                    stt = ev.get("status") or ev["competitions"][0]["status"]
                    return {"id": ev["id"], "when": ev.get("date", d)[:16].replace("T", " ") + "Z", "status": stt["type"].get("detail", "")}
        return {} if got_any else None
    except Exception:
        return None

def postponed_void(row, legs, ms, m, s, st):
    """Return a log reason (str) if this postponed/cancelled/suspended game's bet should be auto-voided now.
    Returns None (-> review) otherwise; raises Review with a 'will auto-void on ...' note while inside the grace period."""
    if st.get("name") not in VOIDABLE_STATUS or st.get("completed"): return None
    if not _single_game_bet(row, legs, ms): return None
    try:
        from common import ET, now_et
        raw = s["header"]["competitions"][0]["date"]
        sched = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if sched.tzinfo is None: sched = sched.replace(tzinfo=datetime.timezone.utc)
        if ET: sched = sched.astimezone(ET)
        sched = sched.replace(tzinfo=None)
    except Exception:
        return None   # no usable scheduled start -> never void
    deadline = sched + datetime.timedelta(hours=VOID_GRACE_HOURS)
    what = (st.get("description") or st.get("name")).lower()
    if now_et() < deadline:
        raise Review(f"game {m['id']} {what}; auto-void on {deadline:%a %b %d %I:%M %p} ET if not played")
    mk = _makeup_game(m, sched)
    if mk is None:
        raise Review(f"game {m['id']} {what}: could not check whether it was replayed, so it is not auto-voided")
    if mk:
        raise Review(f"game {m['id']} {what}, but the same teams play again as game {mk['id']} ({mk['when']}, {mk['status']}): "
                     f"the book may keep the bet alive on the replay, so it is not auto-voided; check the slip")
    return (f"auto-void: game {m['id']} {what} and not completed {VOID_GRACE_HOURS}h after scheduled start "
            f"({sched:%Y-%m-%d %H:%M} ET); single-game bet, stake refunded")

def candidate_games(row, legs, bet):
    """Return list of matches (ESPN) this bet depends on."""
    if bet.get("match"): return [bet["match"]]
    ms = {}
    for L in bet["legs"]:
        if L.get("match"): ms[L["match"]["id"]] = L["match"]
    ev = re.sub(r"^\s*[A-Z]{2,6}\s*:\s*", "", re.sub(r"\s*\([^)]*\)", "", row["event"]))
    date = P.parse_date(row); text = row["event"] + " " + row["market"] + " " + row["pick"]
    paths = P.candidate_paths(row["event"], row["market"])
    for k, v in P.TAGS.items():
        if re.search(rf"\b{k}\b", text): paths = v; break
    else:
        if paths == P.DEFAULT_PATHS: paths = P.DEFAULT_PATHS + P.TAGS["SOCCER"]
    pieces = [p for p in re.split(r"\s+\+\s+|,\s*", ev) if p.strip()]
    pieces += [" @ ".join(L["game"]) for L in legs if L.get("game")]
    for p in pieces:
        names = [x.strip() for x in re.split(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+|\s*/\s*", p) if x.strip()]
        if len(names) != 2 or not date: continue
        women = any(re.search(r"\s+(Women|W)$", n) for n in names) or bool(re.search(r"NWSL|WNBA|\bWomen\b", text))
        names = [alias(re.sub(r"\s+(Women|W)$", "", n)) for n in names]
        g = P.find_game(names, paths, date, women)
        if g: ms[g["id"]] = g
    return list(ms.values())

def grade_row(row):
    out = {"bet_id": row["bet_id"], "book": row["book"], "event": row["event"], "pick": row["pick"], "legs": []}
    mk = row["market"] + " " + row["event"]
    if re.search(r"futures?|outright|to win (the )?(nba|nfl|nhl|mlb|stanley|world series|super bowl|cup)|relegat", mk + " " + row["pick"], re.I):
        return {**out, "status": "waiting", "reason": "future / outright (settled by hand when decided)"}
    try:
        bet = P.build_bet(row)
        multi = bet["multi"]
        texts = [x for x in re.split(r"\s+\+\s+", row["pick"]) if x] if multi else [row["pick"]]
        if multi and len(texts) < 2:
            raise Review("parlay legs not listed in the pick text")
        if re.search(r"legs not (shown|visible)|unknown legs", row["pick"] + row["market"], re.I):
            raise Review("parlay legs unknown (not visible in the screenshot)")
        legs = [parse_leg(t, row["market"]) for t in texts]
        ms = candidate_games(row, legs, bet)
        if not ms:
            d0 = P.parse_date(row)
            if d0 and d0 + datetime.timedelta(hours=4) > __import__("common").now_et():
                return {**out, "status": "waiting", "reason": "game not on ESPN yet / not started"}
            raise Review("no ESPN game matched")
        games = []
        for m in ms:
            s, st = game_status(m)
            if not st: raise Review(f"ESPN summary unavailable for {m['path']} {m['id']}")
            if re.search(r"POSTPONED|CANCEL|SUSPEND|ABANDON|FORFEIT", st.get("name", "")):
                v = postponed_void(row, legs, ms, m, s, st)
                if v: return {**out, "status": "settle", "result": "void", "reason": v, "final": v}
                raise Review(f"game {m['id']} is {st.get('description') or st.get('name')} (book rules: usually void, confirm)")
            if not is_final(st):
                return {**out, "status": "waiting", "reason": f"game {m['id']} {st.get('shortDetail', '')}"}
            games.append((m, s, st))
        # same-game bet: the matched game must be on the bet's date
        d = P.parse_date(row)
        if d and len(games) == 1 and not multi:
            gd = datetime.datetime.fromisoformat(games[0][1]["header"]["competitions"][0]["date"].replace("Z", "+00:00"))
            from common import ET
            if ET: gd = gd.astimezone(ET)
            if abs((gd.date() - d.date()).days) > 0 and re.search(r"\d{1,2}:\d{2}", row["start_et"]):
                raise Review(f"matched game is on {gd.date()} but the bet says {d.date()}")
        res = []
        for L in legs:
            r_ = grade_leg(L, games, row["book"], out)
            res.append(r_); out["legs"].append({"leg": L["text"], "result": r_})
        if not multi: result = res[0]
        else:
            if "lost" in res:
                if "void" in res and row["book"].lower() in WHOLE_VOID:
                    raise Review(f"{row['book']} voids the whole SGP when a leg voids, but another leg lost; confirm")
                result = "lost"
            elif all(x in ("void", "push") for x in res): result = "void" if "void" in res else "push"
            elif any(x in ("void", "push") for x in res):
                if row["book"].lower() in WHOLE_VOID and "void" in res: result = "void"
                else: raise Review("a leg voided/pushed and the rest won; the book reprices the parlay, payout unknown")
            else: result = "won"
        if result == "won" and (not (fnum(row["to_win"]) or 0) > 0 or "unconfirmed" in (row["price"] + row["stake"]).lower()):
            raise Review("won, but the payout (to_win) is missing/unconfirmed")
        g0 = games[0]
        out["final"] = "; ".join(f'{t[0]["abbr"]} {int(t[0]["score"])}-{int(t[1]["score"])} {t[1]["abbr"]}'
                                  for t in [sorted(scores(g[1], g[0]), key=lambda x: x["home"]) for g in games])
        return {**out, "status": "settle", "result": result, "reason": ""}
    except Review as e:
        return {**out, "status": "review", "reason": str(e)}
    except Exception as e:
        return {**out, "status": "review", "reason": f"grader error: {type(e).__name__}: {e}"}
