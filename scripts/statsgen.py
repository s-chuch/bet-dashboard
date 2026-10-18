#!/usr/bin/env python3
"""Network-free generators for stats.json, archive.json and log.json (repo root).

Each file is rewritten only when its content (ignoring generated_at) changed, like data.json.
Full history = data/bets.csv + data/archive/*.csv (common.all_bets()).
Called from build.build() and standalone: python3 scripts/build.py --static
"""
import csv, json, os, re, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import REPO, DATA, LEDGER, RECS, AUTO, ARCHIVE_LOG, ARCHIVE_DAYS, all_bets, archive_rows, read_csv

def num(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "")); return float(m[0]) if m else 0.0
def r2(x): return round(float(x), 2)
def is_settled(r): return (r.get("result") or "").strip().lower() not in ("open", "")
def is_bonus(r): return "bonus" in (r.get("stake") or "").lower() or bool(re.search(r"bonus bet|free bet|no sweat token", r.get("market") or "", re.I))
def cash_stake(r): return 0.0 if is_bonus(r) else num(r.get("stake"))
def american(s):
    m = re.search(r"[+-]?\d+", str(s or "").replace("−", "-")); 
    return int(m[0]) if m else None
def now_iso(): return datetime.datetime.now().astimezone().isoformat(timespec="seconds")

# ---------- stat helpers ----------
def agg(rows):
    won = [r for r in rows if r["result"].strip().lower() == "won"]
    lost = [r for r in rows if r["result"].strip().lower() == "lost"]
    staked = sum(cash_stake(r) for r in rows); pnl = sum(num(r["pnl"]) for r in rows)
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
    a = american(r.get("boosted_price") or r.get("price"))
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
            "bankroll": bankroll(led), "picks": picks_summary()}

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
    with open(tmp, "w") as f: json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
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
