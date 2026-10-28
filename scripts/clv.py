#!/usr/bin/env python3
"""Closing-line value (CLV) for straight bets.  data/clv.csv, keyed by bet_id (bets.csv itself is never touched).

  placed_at      when the bet was logged (ledger.py log / add_bets.py / uploader), ET "YYYY-MM-DD HH:MM"
  close_at       when the closing Pinnacle line was captured (last snapshot before the start), ET
  close_fair_pct Pinnacle no-vig probability of the bet's side at close
  close_price    that probability as American odds (the "fair closing price")
  clv_pct        fair_close * decimal(price taken) - 1, in %.  Positive = you beat the close.
                 Uses the book price, not a boosted price, so boosts don't inflate CLV.
Rule 1 (RULES.md): every bet records its price at placement and its close, boosted and unboosted kept apart:
  open_price_unboosted / open_price_boosted    book prices when the bet was logged (boosted blank if no boost)
  close_price_unboosted                        fair (no-vig) closing price of the bet's side, american
  close_price_boosted                          that fair close with the same boost % applied (what the boost "should" have paid)
  clv_unboosted_pct / clv_boosted_pct          fair_close * decimal(open price) - 1, for the unboosted / boosted open price
  close_source                                 pinnacle (autorun capture, <=60 min before the start) or espn_dk_final (backfill
                                               proxy: no-vig of ESPN's final DraftKings line; NOT Pinnacle, kept out of clv_pct / the headline CLV)

Only straight Moneyline / Spread / Total bets that match a Pinnacle game and line exactly are graded.
Autorun calls capture() every full pass; a bet starting within the next CAPTURE_MIN minutes gets its row
(re)written, so the last write before kickoff is the close.  python3 scripts/clv.py [--dry-run]
"""
import csv, datetime as dt, difflib, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import DATA, now_et, read_csv, all_bets

CLV = os.path.join(DATA, "clv.csv")
COLS = ["bet_id", "placed_at", "close_at", "close_fair_pct", "close_price", "clv_pct", "note",
        "open_price_unboosted", "open_price_boosted", "close_price_unboosted", "close_price_boosted",
        "clv_unboosted_pct", "clv_boosted_pct", "close_source"]
CAPTURE_MIN = 60
SIDS = [15, 19, 4, 3, 29]   # football, hockey, basketball, baseball, soccer

def load():
    return {r["bet_id"]: r for r in read_csv(CLV)[0] if r.get("bet_id")}
def save(m):
    tmp = CLV + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, COLS, extrasaction="ignore"); w.writeheader()
        for k in sorted(m, key=lambda k: (m[k].get("placed_at") or m[k].get("close_at") or "", k)):
            w.writerow({c: m[k].get(c, "") for c in COLS})
    os.replace(tmp, CLV)

def clean_price(s):
    """'+325' -> 325; anything else ('unconfirmed (~+120)', '~+155', 'boosted x2 profit', blank) -> None."""
    m = re.fullmatch(r"\s*([+-]\d{3,5})\s*", str(s or "").replace("\u2212", "-")); return int(m[1]) if m else None

def open_prices(bet):
    """(unboosted, boosted) american price at placement, from a bets.csv-style row. Blank string when not a clean price."""
    u, b = clean_price(bet.get("price")), clean_price(bet.get("boosted_price"))
    return (f"{u:+d}" if u is not None else ""), (f"{b:+d}" if b is not None else "")

def record_placed(bet_id, when=None, bet=None):
    """Called right after a bet is logged. Never overwrites an existing placed_at / open price."""
    if not bet_id: return
    m = load(); r = m.setdefault(bet_id, {"bet_id": bet_id}); ch = False
    if not r.get("placed_at"):
        r["placed_at"] = when or now_et().strftime("%Y-%m-%d %H:%M"); ch = True
    if bet:
        u, b = open_prices(bet)
        if u and not r.get("open_price_unboosted"): r["open_price_unboosted"] = u; ch = True
        if b and not r.get("open_price_boosted"): r["open_price_boosted"] = b; ch = True
    if ch: save(m)

# ---------- parsing a straight bet ----------
def american(s):
    m = re.search(r"[+-]?\d{3,}", str(s or "").replace("\u2212", "-"))
    return int(m[0]) if m else None
def am2dec(a): return 1 + 100 / -a if a < 0 else 1 + a / 100
def dec2am(d): return round((d - 1) * 100) if d >= 2 else round(-100 / (d - 1))
def implied(a): return -a / (-a + 100) if a < 0 else 100 / (a + 100)

def straight(r):
    """(kind, side_text, line) for a straight ML/spread/total bet, else None."""
    m = (r.get("market") or "").lower(); p = (r.get("pick") or "").strip()
    if re.search(r"parlay|sgp|leg|prop|future|player|first|anytime|half|quarter|period|inning|team total|corner|card", m + " " + p.lower()): return None
    if " + " in p or "unconfirmed" in (p + " " + (r.get("price") or "")).lower(): return None
    if american(r.get("price")) is None: return None
    t = re.match(r"(?i)(over|under)\s+(\d+(?:\.\d+)?)$", p)
    if re.search(r"\blive\b|in-play", m): return None
    if t:
        return ("tot", t[1].lower(), float(t[2]))
    if "spread" in m or "puck line" in m or "run line" in m or "handicap" in m:
        s = re.match(r"(.+?)\s+([+-]\d+(?:\.\d+)?)$", p)
        return ("sp", s[1].strip(), float(s[2])) if s else None
    if re.search(r"moneyline|\bml\b|match result|3-way|1x2|draw", m + " " + p.lower()):
        side = re.sub(r"(?i)\s+(ml|to win|moneyline)$", "", p).strip()
        return ("ml", side, None)
    return None

def parse_start(r):
    try:
        import build as B; return B.parse_date(r)
    except Exception: return None

def _n(s): return re.sub(r"[^a-z0-9 ]", "", s.lower().replace("st.", "state").replace("&", "and")).strip()
def sim(a, b):
    a, b = _n(a), _n(b)
    if not a or not b: return 0
    if a in b or b in a: return 0.95
    return difflib.SequenceMatcher(None, a, b).ratio()

def teams_of(event):
    ev = re.sub(r"\s*\([^)]*\)", "", event or "")
    t = re.split(r"\s+@\s+|\s+vs\.?\s+|\s+v\s+", ev, flags=re.I)
    return [x.strip() for x in t if x.strip()][:2] if len(t) >= 2 else []

def find_game(r, start_utc, pins):
    tm = teams_of(r.get("event")); best, bs = None, 0
    for g in pins:
        try: gs = dt.datetime.fromisoformat(g["start"].replace("Z", "+00:00"))
        except Exception: continue
        if abs((gs - start_utc).total_seconds()) > 3 * 3600: continue
        if len(tm) == 2:
            s = max(min(sim(tm[0], g["away"]), sim(tm[1], g["home"])), min(sim(tm[0], g["home"]), sim(tm[1], g["away"])))
        else:
            s = max(sim(r.get("pick", ""), g["home"]), sim(r.get("pick", ""), g["away"])) * 0.9
        if s > bs: best, bs = g, s
    return best if bs >= 0.7 else None

def close_fair(r, g):
    """No-vig probability of the bet's side at Pinnacle, or (None, reason)."""
    k = straight(r); kind, side, line = k; pm = g["markets"]
    def nv(prices, s):
        tot = sum(implied(v) for v in prices.values()); return implied(prices[s]) / tot
    if kind == "ml":
        mk = pm.get("ml")
        if not mk: return None, "no Pinnacle moneyline"
        if re.fullmatch(r"(?i)draw|tie", side): s = "draw"
        else: s = "home" if sim(side, g["home"]) >= sim(side, g["away"]) else "away"
        if s not in mk["prices"]: return None, "side not offered"
        return nv(mk["prices"], s), ""
    if kind == "sp":
        s = "home" if sim(side, g["home"]) >= sim(side, g["away"]) else "away"
        hp = line if s == "home" else -line
        mk = pm.get(("sp", float(hp)))
        if not mk or len(mk["prices"]) < 2: return None, f"Pinnacle has no {line:+g} line"
        return nv(mk["prices"], s), ""
    mk = pm.get(("tot", float(line)))
    if not mk or len(mk["prices"]) < 2: return None, f"Pinnacle has no total {line:g}"
    return nv(mk["prices"], side), ""

def clv_pct(fair, price): return round((fair * am2dec(price) - 1) * 100, 2)

def boosted_dec(dec_price, pct): return 1 + (dec_price - 1) * (1 + pct / 100.0)

def close_fields(r, fair, source="pinnacle"):
    """The rule-1 close columns for bet row r given the fair (no-vig) closing probability of its side."""
    from common import boost_pct
    ou, ob = open_prices(r); fdec = 1 / fair
    pct = boost_pct(r.get("market", ""), r.get("price", ""), r.get("boosted_price", "")) if (ob or "boost" in (r.get("market") or "").lower()) else None
    out = {"close_price_unboosted": f"{dec2am(fdec):+d}", "close_price_boosted": "", "clv_unboosted_pct": "", "clv_boosted_pct": "", "close_source": source}
    if ou: out["clv_unboosted_pct"] = f"{clv_pct(fair, int(ou)):.2f}"
    if pct: out["close_price_boosted"] = f"{dec2am(boosted_dec(fdec, pct)):+d}"
    if ob: out["clv_boosted_pct"] = f"{clv_pct(fair, int(ob)):.2f}"
    elif pct and ou: out["clv_boosted_pct"] = f"{round((fair * boosted_dec(am2dec(int(ou)), pct) - 1) * 100, 2):.2f}"   # boost % from the market text
    return out

def capture(dry=False, now=None, fetch=None, verbose=True):
    now = now or now_et()
    cands = []
    for r in all_bets():
        if (r.get("result") or "").strip().lower() not in ("open", ""): continue
        if not straight(r): continue
        st = parse_start(r)
        if not st or not (now <= st <= now + dt.timedelta(minutes=CAPTURE_MIN)): continue
        cands.append((r, st))
    if not cands: return 0
    if fetch is None:
        import ev_scan as E
        key = E.pinnacle_key(); cache = {}
        def fetch(sid):
            if sid not in cache:
                try: cache[sid] = E.pinnacle_sport(sid, key)
                except Exception as e: print("clv: pinnacle", sid, e, file=sys.stderr); cache[sid] = []
            return cache[sid]
    try:
        from zoneinfo import ZoneInfo; ET = ZoneInfo("America/Toronto")
    except Exception: ET = dt.timezone(dt.timedelta(hours=-4))
    m = load(); n = 0
    for r, st in cands:
        su = st.replace(tzinfo=ET).astimezone(dt.timezone.utc); g = None
        for sid in SIDS:
            g = find_game(r, su, fetch(sid))
            if g: break
        row = m.setdefault(r["bet_id"], {"bet_id": r["bet_id"]})
        if not g:
            row["note"] = "no Pinnacle game match"; continue
        fair, why = close_fair(r, g)
        if fair is None: row["note"] = why; continue
        price = american(r["price"])
        row.update({"close_at": now.strftime("%Y-%m-%d %H:%M"), "close_fair_pct": f"{fair * 100:.2f}",
                    "close_price": f"{dec2am(1 / fair):+d}", "clv_pct": f"{clv_pct(fair, price):.2f}", "note": ""})
        row.update(close_fields(r, fair)); ou, ob = open_prices(r)
        if ou and not row.get("open_price_unboosted"): row["open_price_unboosted"] = ou
        if ob and not row.get("open_price_boosted"): row["open_price_boosted"] = ob
        n += 1
        if verbose: print(f"clv {r['bet_id']} {r['pick'][:40]} @ {price:+d}: close fair {dec2am(1/fair):+d} -> CLV {row['clv_pct']}%")
    if not dry: save(m)
    return n

def is_pinnacle(c): return (c.get("close_source") or "pinnacle") == "pinnacle"

def summary(rows=None):
    """CLV summary over every bet with a captured Pinnacle close (headline), plus coverage of closes / open prices."""
    m = load(); allr = list(rows or all_bets()); byid = {r["bet_id"]: r for r in allr}
    xs = []
    for k, c in m.items():
        if c.get("clv_pct") and k in byid and is_pinnacle(c):
            try: xs.append((float(c["clv_pct"]), byid[k]))
            except ValueError: pass
    strt = [r for r in allr if straight(r)]
    has_close = lambda i: bool((m.get(i) or {}).get("close_price_unboosted") or (m.get(i) or {}).get("clv_pct"))
    cov = {"bets": len(allr), "straight": len(strt), "straight_with_close": sum(has_close(r["bet_id"]) for r in strt),
           "proxy_closes": sum(1 for c in m.values() if (c.get("close_source") or "") == "espn_dk_final"),
           "open_price_logged": sum(1 for c in m.values() if c.get("open_price_unboosted")), "placed_at_logged": sum(1 for c in m.values() if c.get("placed_at"))}
    base = {"coverage": cov, "tracked": cov["placed_at_logged"]}
    if not xs: return {"n": 0, "avg": None, "beat": 0, "beat_pct": None, **base}
    beat = sum(1 for v, _ in xs if v > 0)
    return {"n": len(xs), "avg": round(sum(v for v, _ in xs) / len(xs), 2), "beat": beat,
            "beat_pct": round(beat / len(xs) * 100, 1), **base,
            "recent": [{"bet_id": r["bet_id"], "pick": r["pick"][:60], "book": r["book"], "price": r["price"],
                        "close_price": m[r["bet_id"]]["close_price"], "clv_pct": v}
                       for v, r in sorted(xs, key=lambda x: x[1].get("date", ""), reverse=True)[:10]]}

def missing_closes(rows=None, now=None):
    """Reminder list: straight bets (already started or settled) with no closing price on file."""
    now = now or now_et(); m = load(); out = []
    for r in (rows or all_bets()):
        if not straight(r): continue
        c = m.get(r["bet_id"]) or {}
        if c.get("close_price_unboosted") or c.get("clv_pct"): continue
        st = parse_start(r)
        if (r.get("result") or "").strip().lower() in ("open", "") and st and st > now: continue   # not started yet: capture() will get it
        out.append({"bet_id": r["bet_id"], "date": r["date"], "book": r["book"], "pick": r["pick"][:50], "event": r["event"][:50],
                    "start_et": r.get("start_et", ""), "why": c.get("note") or ("no placed_at row (logged before CLV tracking)" if not c else "no close captured (not graded within 60 min of the start)")})
    return out

if __name__ == "__main__":
    from common import lock
    with lock(): print("captured", capture(dry="--dry-run" in sys.argv))
