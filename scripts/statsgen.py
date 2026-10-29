#!/usr/bin/env python3
"""Network-free generators for stats.json, archive.json and log.json (repo root).

Each file is rewritten only when its content (ignoring generated_at) changed, like data.json.
Full history = data/bets.csv + data/archive/*.csv (common.all_bets()).
Called from build.build() and standalone: python3 scripts/build.py --static
"""
import csv, json, math, os, re, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import REPO, DATA, LEDGER, RECS, AUTO, ARCHIVE_LOG, ARCHIVE_DAYS, all_bets, archive_rows, read_csv

def num(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "").replace(",", "")); return float(m[0]) if m else 0.0
def r2(x): return round(float(x), 2)
def is_settled(r): return (r.get("result") or "").strip().lower() not in ("open", "")
def is_early_payout(r): return str(r.get("early_payout") or "").strip() in ("1", "true", "yes")
# Note: early-payout bets stay in results/ROI but should be excluded from any model-accuracy / calibration checks
# (fair_pct vs actual outcome). Filter with `not is_early_payout(r)` when computing those.
def is_bonus(r): return "bonus" in (r.get("stake") or "").lower() or bool(re.search(r"bonus bet|free bet|no sweat token", r.get("market") or "", re.I))
def cash_stake(r): return 0.0 if is_bonus(r) else num(r.get("stake"))
def american(s):
    s = str(s or "").replace("−", "-")
    if re.search(r"\bx\d", s, re.I): return None   # "boosted x2 profit" is a label, not a price
    m = re.search(r"[+-]?\d{3,}", s) or re.search(r"[+-]\d+", s)
    return int(m[0]) if m else None
def row_payout(r):
    """(cash_stake, payout_if_win, estimated?) for one unsettled bet. payout = what lands back in the balance on a win
    (stake + profit; profit only for bonus bets). profit = to_win when known, else derived from the American price."""
    cs = cash_stake(r); profit = num(r.get("to_win")); est = False
    if not profit:
        o = american(r.get("boosted_price")) or american(r.get("price")); st = num(r.get("stake"))
        if o and st: profit = st * (o / 100.0 if o > 0 else 100.0 / abs(o)); est = True
        else: return cs, None, False
    return cs, round(cs + profit, 2), est
def open_summary(rows):
    """One definition of 'unsettled' for every page: all bets whose result is still open."""
    n = stake = pay = tbc = est_n = 0
    for r in rows:
        n += 1; cs, p, est = row_payout(r); stake += cs
        if p is None: tbc += 1
        else: pay += p; est_n += est
    return {"n": n, "cash_stake": round(stake, 2), "max_payout": round(pay, 2), "payout_tbc": tbc, "payout_estimated": est_n}
def now_iso(): return datetime.datetime.now().astimezone().isoformat(timespec="seconds")

# ---------- stat helpers ----------
def agg(rows):
    won = [r for r in rows if r["result"].strip().lower() == "won"]
    lost = [r for r in rows if r["result"].strip().lower() == "lost"]
    # push/void/cashout-less refunds: stake comes back, so it is not capital at risk for ROI
    staked = sum(cash_stake(r) for r in rows if r["result"].strip().lower() not in ("push", "void")); pnl = sum(num(r["pnl"]) for r in rows)
    return {"bets": len(rows), "won": len(won), "lost": len(lost), "staked": r2(staked), "pnl": r2(pnl),
            "roi": r2(pnl / staked * 100) if staked else 0.0,
            "win_rate": r2(len(won) / (len(won) + len(lost)) * 100) if (won or lost) else 0.0}

def group(rows, keyf, name, order=None):
    g = {}
    for r in rows:
        k = keyf(r)
        if k is not None: g.setdefault(k, []).append(r)
    out = [{name: k, **agg(v)} for k, v in g.items()]
    if order: out.sort(key=lambda d: order.index(d[name]) if d[name] in order else 99)
    else: out.sort(key=lambda d: -d["pnl"])
    return out

def market_bucket(r):
    m = (r.get("market") or "").lower(); p = (r.get("pick") or "").lower()
    if "sgp" in m or "parlay" in m: return "Parlay/SGP"
    if "future" in m or "relegation" in m: return "Other"
    if "3-way" in m or "draw" in m or "draw" in p: return "Soccer"
    if "prop" in m: return "Player prop"
    if "spread" in m or "puck line" in m or "run line" in m: return "Spread"
    if "total" in m or m in ("over", "under") or re.match(r"(over|under)\b", m): return "Total"
    if "moneyline" in m or m in ("ml",): return "Moneyline"
    if " + " in p: return "Parlay/SGP"
    if re.match(r"(over|under)\s", p): return "Total"
    if re.search(r"\bml\b", p): return "Moneyline"
    return "Other"

def odds_bucket(r):
    a = american(r.get("boosted_price"))
    if a is None: a = american(r.get("price"))
    if a is None: return None
    if a < 100: return "Favourites (<+100)"
    if a < 300: return "+100 to +299"
    if a < 600: return "+300 to +599"
    return "+600+"

def brief(r):
    return {"pick": r["pick"], "book": r["book"], "event": re.sub(r"\s*\([^)]*\)", "", r["event"]), "date": r["date"], "pnl": r2(num(r["pnl"]))}

# ---------- bankroll replay (same semantics as ledger.balances) ----------
def bankroll(led, cap=400):
    bal = {}; pts = []
    for e in led:
        b = e["book"]
        try: a = float(e["amount"])
        except Exception: continue
        if not math.isfinite(a): continue
        if e["event_type"] == "anchor": bal[b] = a
        elif b in bal: bal[b] += a
        else: continue
        pt = {"ts": e["ts_et"], "total": r2(sum(bal.values())), "books": {k: r2(v) for k, v in bal.items()}}
        if pts and pts[-1]["ts"] == e["ts_et"]: pts[-1] = pt
        else: pts.append(pt)
    if len(pts) > cap:
        step = (len(pts) - 1) / (cap - 1)
        pts = [pts[round(i * step)] for i in range(cap)]
    return pts

def picks_summary():
    recs = read_csv(RECS)[0]
    won = sum(1 for r in recs if r.get("result") == "won"); lost = sum(1 for r in recs if r.get("result") == "lost")
    graded = sum(1 for r in recs if r.get("result") in ("won", "lost", "push", "void"))
    return {"total": len(recs), "graded": graded, "won": won, "lost": lost,
            "win_rate": r2(won / (won + lost) * 100) if (won + lost) else None,
            "placed": sum(1 for r in recs if r.get("placed") == "yes")}


# ---------- game plan (rules from the Oct 22 analysis, tracked live from the data) ----------
def is_boost(r): return bool((r.get("boosted_price") or "").strip()) or bool(re.search(r"profit boost|odds boost|\bboost", r.get("market") or "", re.I))
def money_kind(r): return "Bonus bet" if is_bonus(r) else ("Profit boost" if is_boost(r) else "Cash")
def eff_price(r):
    a = american(r.get("boosted_price"))
    return a if a is not None else american(r.get("price"))
def plan_band(r):
    a = eff_price(r)
    if a is None or "unconfirmed" in (r.get("price") or "").lower(): return "Price unconfirmed"
    if a <= -150: return "Fav -150 or shorter"
    if a <= 150: return "-149 to +150"
    if a <= 400: return "+151 to +400"
    return "+401 or longer"
def legs_n(r):
    m = re.search(r"(\d+)[- ]?leg", r.get("market") or "", re.I)
    return int(m[1]) if m else len([x for x in re.split(r"\s+\+\s+", r.get("pick") or "") if x])

def boost_size(r):
    from common import boost_pct
    p = boost_pct(r.get("market"), r.get("price"), r.get("boosted_price")); return f"{p}%" if p else "unknown %"

def by_money(st):
    """Cash / Profit boost / Bonus bet, with the boost row broken down by boost size (and by book inside each size)."""
    out = []
    for g in group(st, money_kind, "key", ["Cash", "Profit boost", "Bonus bet"]):
        out.append(g)
        if g["key"] != "Profit boost": continue
        bs = [r for r in st if money_kind(r) == "Profit boost"]
        order = sorted({boost_size(r) for r in bs}, key=lambda k: (k == "unknown %", int(k[:-1]) if k[:-1].isdigit() else 0))
        for s in group(bs, boost_size, "key", order):
            out.append({**s, "sub": 1})
            sz = [r for r in bs if boost_size(r) == s["key"]]
            books = group(sz, lambda r: r["book"], "key")
            if len(books) > 1: out += [{**b, "sub": 2} for b in books]
    return out

def game_plan(rows):
    st = [r for r in rows if is_settled(r)]
    cut = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    wk = [r for r in rows if (r.get("date") or "") >= cut]
    recs = read_csv(RECS)[0]; rec_ids = set()
    for x in recs:
        rec_ids.update(i.strip() for i in (x.get("bet_ids") or "").split(";") if i.strip())
    bonus = [r for r in st if is_bonus(r)]
    face = sum(num(r.get("stake")) for r in bonus); ret = sum(max(0.0, num(r.get("pnl"))) for r in bonus)
    conv = r2(ret / face * 100) if face else None
    pb_roll = [r for r in st if r["book"] == "PointsBet" and re.search(r"WELCOMEDM|rollover", r.get("market") or "", re.I)]
    pb_cash_wk = [r for r in wk if r["book"] == "PointsBet" and money_kind(r) == "Cash" and not re.search(r"WELCOMEDM|rollover", r.get("market") or "", re.I)]
    cz = [r for r in st if r["book"] == "Caesars" and is_boost(r)]
    sgp = [r for r in st if market_bucket(r) == "Parlay/SGP"]; sgp_wk = [r for r in wk if market_bucket(r) == "Parlay/SGP"]
    fav_sp = [r for r in st if money_kind(r) == "Cash" and (plan_band(r) == "Fav -150 or shorter" or market_bucket(r) == "Spread")]
    fav_sp_wk = [r for r in wk if money_kind(r) == "Cash" and (plan_band(r) == "Fav -150 or shorter" or market_bucket(r) == "Spread")]
    b3h = [r for r in st if r["book"] in ("bet365", "Hard Rock") and is_boost(r)]
    unconf = [r for r in rows if "unconfirmed" in ((r.get("price") or "") + " " + (r.get("pick") or "") + " " + (r.get("stake") or "")).lower()]
    try:
        import clv as C; cs = C.summary(rows)
    except Exception: cs = {"n": 0, "avg": None, "beat": 0, "beat_pct": None, "tracked": 0}
    cov = cs.get("coverage") or {}
    no_rec = [r for r in rows if r.get("bet_id") not in rec_ids]; no_rec_wk = [r for r in no_rec if (r.get("date") or "") >= cut]
    no_ev = [r for r in rows if not (r.get("ev_pct") or "").strip()]; no_fair = [r for r in rows if not (r.get("fair_pct") or "").strip()]
    try:
        import rules as BR
        bchk = [(r, BR.boost_check_bet(r)) for r in wk]; bchk = [(r, c) for r, c in bchk if c]
    except Exception: bchk = []
    b_flag = [r for r, c in bchk if c[0] in ("flagged_low_ev", "flagged_no_ev")]
    A = agg
    def line(rs): a = A(rs); return f"{a['bets']} bets, {money(a['pnl'])}" + (f" ({a['roi']:+.1f}% ROI)" if a["staked"] else "")
    rules = [
        {"n": 1, "rule": "Finish the PointsBet rollover cheaply (near-even prices, fair-checked), then no new cash at PointsBet.",
         "track": f"Rollover so far: {line(pb_roll)}. New PointsBet cash bets in the last 7 days: {len(pb_cash_wk)}.",
         "ok": len(pb_cash_wk) == 0},
        {"n": 2, "rule": "Take every Caesars 100% profit boost, full size, on +100 to +300 prices.",
         "track": f"Caesars boosts: {line(cz)}.", "ok": A(cz)["pnl"] >= 0},
        {"n": 3, "rule": "Bonus bets: one at a time, +300 to +500, fair-checked (Bet Finder > Bonus bet). Target 60%+ of face back over time.",
         "track": f"Bonus bets returned {money(ret).lstrip('+')} of {money(face).lstrip('+')} face" + (f" = {conv:.0f}%" if conv is not None else "") + f" ({len(bonus)} settled).",
         "ok": conv is None or conv >= 60},
        {"n": 4, "rule": "Cut tiny SGPs. Keep only boosted 2-leg SGPs.",
         "track": f"Parlays/SGPs: {line(sgp)}. Placed in the last 7 days: {len(sgp_wk)}.", "ok": len(sgp_wk) <= 5},
        {"n": 5, "rule": "No plain cash favourites at -150 or shorter, and no cash spreads, unless the Finder shows +2% EV.",
         "track": f"Cash favs/spreads: {line(fav_sp)}. Last 7 days: {len(fav_sp_wk)}.", "ok": len(fav_sp_wk) == 0},
        {"n": 6, "rule": "Use the profit-boost routine at bet365 and Hard Rock too (Bet Finder > Profit boost).",
         "track": f"bet365 + Hard Rock boosts: {line(b3h)}.", "ok": A(b3h)["pnl"] >= 0},
        {"n": 7, "rule": "Log every bet when placed so CLV (vs Pinnacle's closing no-vig line) is tracked; confirm unconfirmed prices.",
         "track": (f"CLV on {cs['n']} bet(s): avg {cs['avg']:+.1f}%, beat the close {cs['beat_pct']:.0f}%." if cs["n"] else "No closing lines captured yet.")
                  + (f" Closing price on file for {cov['straight_with_close']} of {cov['straight']} straight bets (+{cov['proxy_closes']} ESPN-final proxies); open price logged for {cov['open_price_logged']} of {cov['bets']} bets." if cov else "")
                  + f" Bets with an unconfirmed price: {len(unconf)}.", "ok": len(unconf) == 0},
        {"n": 8, "rule": "Boost rule: boost straights or 2-leg bets at +100 to +299. Avoid cash favourites and 3-leg SGPs unless the promo requires 3 legs (bet365, FanDuel NBA/NHL); otherwise +2% EV at the model price.",
         "track": f"Boosted bets in the last 7 days: {len(bchk)}; flagged below the +2% bar or with no EV logged: {len(b_flag)}.", "ok": len(b_flag) == 0},
        {"n": 9, "rule": "Every bet links to a rec with fair % and EV at placement; skips are logged.",
         "track": f"Bets with no rec: {len(no_rec)} of {len(rows)} ({len(no_rec_wk)} in the last 7 days). No EV logged: {len(no_ev)}. No fair %: {len(no_fair)}.", "ok": len(no_rec_wk) == 0},
    ]
    followed = [r for r in st if r.get("bet_id") in rec_ids]; own = [r for r in st if r.get("bet_id") not in rec_ids]
    band_order = ["Fav -150 or shorter", "-149 to +150", "+151 to +400", "+401 or longer", "Price unconfirmed"]
    return {"rules": rules,
            "by_type": group(st, market_bucket, "key"),
            "by_book": group(st, lambda r: r["book"], "key"),
            "by_band": group(st, plan_band, "key", band_order),
            "by_money": by_money(st),
            "by_source": [{"key": "Followed my picks", **A(followed)}, {"key": "Own picks", **A(own)}],
            "by_legs": group([r for r in st if market_bucket(r) == "Parlay/SGP"], lambda r: f"{legs_n(r)} legs", "key"),
            "bonus": {"n": len(bonus), "face": r2(face), "returned": r2(ret), "conv_pct": conv},
            "clv": cs, "unconfirmed": len(unconf),
            "rec_coverage": {"bets": len(rows), "no_rec": len(no_rec), "no_rec_7d": len(no_rec_wk), "no_ev": len(no_ev), "no_fair": len(no_fair)},
            "unconfirmed_list": [{"bet_id": r.get("bet_id", ""), "date": r["date"], "book": r["book"], "event": re.sub(r"\s*\([^)]*\)", "", r.get("event") or ""),
                                  "market": r.get("market", ""), "pick": r["pick"], "price": r.get("price", ""), "boosted_price": r.get("boosted_price", ""),
                                  "stake": r.get("stake", ""), "result": r.get("result", ""), "pnl": r2(num(r.get("pnl")))}
                                 for r in sorted(unconf, key=lambda r: r["date"], reverse=True)],
            "note": "Small sample: treat splits under ~30 bets as signals, not proof."}

def build_stats(rows, led):
    st = sorted([r for r in rows if is_settled(r)], key=lambda r: (r["date"], r.get("start_et", ""), r.get("bet_id", "")))
    opn = [r for r in rows if not is_settled(r)]
    a = agg(st)
    wins = [num(r["pnl"]) for r in st if r["result"].lower() == "won"]; losses = [num(r["pnl"]) for r in st if r["result"].lower() == "lost"]
    totals = {"bets": a["bets"], "won": a["won"], "lost": a["lost"], "push_void": a["bets"] - a["won"] - a["lost"],
              "win_rate": a["win_rate"], "staked": a["staked"], "returned": r2(a["staked"] + a["pnl"]), "pnl": a["pnl"], "roi": a["roi"],
              "avg_stake": r2(a["staked"] / a["bets"]) if a["bets"] else 0.0,
              "avg_win": r2(sum(wins) / len(wins)) if wins else 0.0, "avg_loss": r2(sum(losses) / len(losses)) if losses else 0.0,
              "open": len(opn), "open_stake": r2(sum(cash_stake(r) for r in opn)),
              "open_payout": open_summary(opn)["max_payout"], "open_payout_tbc": open_summary(opn)["payout_tbc"],
              "first_date": st[0]["date"] if st else None, "last_date": st[-1]["date"] if st else None,
              "best": brief(max(st, key=lambda r: num(r["pnl"]))) if st else None,
              "worst": brief(min(st, key=lambda r: num(r["pnl"]))) if st else None}
    seq = [r["result"].lower() for r in st if r["result"].lower() in ("won", "lost")]
    best_w = worst_l = run = 0; prev = None
    for x in seq:
        run = run + 1 if x == prev else 1; prev = x
        if x == "won": best_w = max(best_w, run)
        else: worst_l = max(worst_l, run)
    streak = {"current": {"type": prev, "n": run} if seq else None, "best_win": best_w, "worst_loss": worst_l}
    daily = []; cum = 0.0
    bydate = {}
    for r in st: bydate.setdefault(r["date"], []).append(r)
    for d, v in sorted(bydate.items()):
        g = agg(v); cum += g["pnl"]
        daily.append({"date": d, "bets": g["bets"], "won": g["won"], "lost": g["lost"], "staked": g["staked"], "pnl": g["pnl"], "cum_pnl": r2(cum)})
    for x in daily[-30:]:  # per-bet detail for the "Recent settled days" tiles (tap to expand)
        x["items"] = [{"book": r["book"], "event": re.sub(r"\s*\([^)]*\)", "", r.get("event") or ""), "market": r.get("market", ""),
                       "pick": r.get("pick", ""), "price": r.get("price", ""), "boosted_price": r.get("boosted_price", ""),
                       "stake": r.get("stake", ""), "result": r.get("result", ""), "pnl": r2(num(r.get("pnl"))), "kind": money_kind(r)}
                      for r in bydate[x["date"]]]
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    def wd(r):
        try: return days[datetime.date.fromisoformat(r["date"]).weekday()]
        except Exception: return None
    odds_order = ["Favourites (<+100)", "+100 to +299", "+300 to +599", "+600+"]
    bo = [r for r in st if (r.get("boosted_price") or "").strip()]; reg = [r for r in st if not (r.get("boosted_price") or "").strip()]
    return {"generated_at": now_iso(), "totals": totals, "streak": streak, "daily": daily,
            "by_book": group(st, lambda r: r["book"], "book"),
            "by_market": group(st, market_bucket, "market"),
            "by_odds": group(st, odds_bucket, "bucket", odds_order),
            "by_weekday": group(st, wd, "day", days),
            "boosted": {"boosted": agg(bo), "regular": agg(reg)},
            "bankroll": bankroll(led), "picks": picks_summary(), "game_plan": game_plan(rows)}

def build_archive(arch):
    bets = []
    for r in sorted(arch, key=lambda r: (r["date"], r.get("start_et", ""), r.get("bet_id", "")), reverse=True):
        bets.append({"bet_id": r["bet_id"], "date": r["date"], "book": r["book"], "event": r["event"], "market": r["market"],
                     "pick": r["pick"], "price": american(r["price"]), "boosted_price": american(r.get("boosted_price")),
                     "stake": r2(num(r["stake"])), "to_win": r2(num(r["to_win"])), "result": r["result"],
                     "pnl": r2(num(r["pnl"])), "settled_at": r.get("settled_at", ""), "settled_by": r.get("settled_by", "")})
    return {"generated_at": now_iso(), "cutoff_days": ARCHIVE_DAYS, "count": len(bets),
            "months": sorted({b["date"][:7] for b in bets}, reverse=True), "bets": bets}

def money(x): return f"{'+' if x > 0 else '-' if x < 0 else ''}${abs(x):.2f}"

def build_log(rows, led):
    byid = {r["bet_id"]: r for r in rows if r.get("bet_id")}
    events = []
    for e in reversed(led[-600:]):
        try: amt = float(e["amount"])
        except Exception: amt = None
        if amt is not None and not math.isfinite(amt): amt = None
        t = e["event_type"]; b = byid.get(e["bet_id"]); pick = (b["pick"][:60] if b else "")
        if t == "anchor": label = f"Balance set to ${amt:.2f} · {e['book']}" if amt is not None else f"Balance anchor · {e['book']}"
        elif t == "adjust": label = f"Adjustment {money(amt or 0)} · {e['book']}"
        elif t == "stake": label = f"Placed ${abs(amt or 0):.2f} · {e['book']}" + (f" · {pick}" if pick else "")
        elif t in ("return", "settled"):
            res = (e["note"].split(",")[0] or "").strip().upper() or "RETURN"
            p = num(b["pnl"]) if b else (amt or 0)
            label = f"Settled {res} {money(p)} · {e['book']}" + (f" · {pick}" if pick else "")
        else: label = f"{t} · {e['book']}"
        events.append({"ts": e["ts_et"], "type": t, "book": e["book"], "bet_id": e["bet_id"], "amount": amt, "note": e["note"], "label": label})
    runs = []
    for r in reversed(read_csv(ARCHIVE_LOG)[0]):
        runs.append({"ts": r["ts_et"], "moved": int(num(r["moved"])), "cutoff": r["cutoff"]})
    try: auto = json.load(open(AUTO))
    except Exception: auto = {}
    return {"generated_at": now_iso(), "events": events, "archive_runs": runs,
            "auto": {"last_change_at": auto.get("last_change_at"), "last_settled": auto.get("last_settled", []),
                     "needs_review_count": len(auto.get("needs_review", [])), "errors": auto.get("errors", [])}}

def _write_if_changed(name, data):
    path = os.path.join(REPO, name)
    try: old = json.load(open(path))
    except Exception: old = None
    strip = lambda d: {k: v for k, v in (d or {}).items() if k != "generated_at"}
    if old is not None and strip(old) == strip(data): return False
    tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump(data, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    os.replace(tmp, path); return True

def build_static(verbose=True):
    """Write stats.json / archive.json / log.json if changed. Returns {name: changed}."""
    rows = all_bets(); led = read_csv(LEDGER)[0]
    out = {"stats.json": _write_if_changed("stats.json", build_stats(rows, led)),
           "archive.json": _write_if_changed("archive.json", build_archive(archive_rows())),
           "log.json": _write_if_changed("log.json", build_log(rows, led))}
    if verbose: print("static:", ", ".join(f"{k} {'CHANGED' if v else 'unchanged'}" for k, v in out.items()))
    return out

if __name__ == "__main__":
    build_static()
