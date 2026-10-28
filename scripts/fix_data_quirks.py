#!/usr/bin/env python3
"""One-off, idempotent clean-up of data quirks found in the Oct 27 stats review (rule 3 in RULES.md).  Dry run unless --apply.

  1. A bet linked to two recs (a0031feb: Cienciano v UTC Cajamarca draw was also linked to the Cesena v Avellino draw rec):
     keep the link whose rec is the same game AND book, drop the others.  Cause: same_rec matched on the shared 'v' in the event names.
  2. A rec linked to a bet at a DIFFERENT sportsbook (7 bets: 1fd5cd6b/5ff31714 Nets, f3374acf Bulls, 510ab24b FIU, b6420427 Knicks,
     03b14c2d Suns, 5dd07ebb Kent State): the bet is unlinked and gets its own rec at its own book (same selection/game; fair % copied
     from the original rec only if the bet has none; EV only when the bet price is confirmed).  The original rec keeps its book and
     is marked placed=no when no bet at that book remains.
  3. Missing start_et: filled ONLY when 3+ other bets on the same event/day in the files agree on one value (3829ebcd).
     The other six (6388e853, c352d06d, d91a6de4, 2d46e615, ec6db8a6, ef269fe1) have no source in the repo and are left blank.
Never changes stakes, prices, results, pnl or the ledger.
"""
import csv, glob, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import rec as RC
from common import all_bets, lock, BETS, DATA

def fix_links(rows, bets):
    """mutates rec rows; returns (log lines)"""
    log = []; byid = {b["bet_id"]: b for b in bets}
    linked = {}
    for r in rows:
        for i in RC._ids(r): linked.setdefault(i, []).append(r)
    # 1. one bet -> one rec
    for bid, rs in linked.items():
        if len(rs) < 2 or bid not in byid: continue
        cand = RC._cand(byid[bid]); keep = [r for r in rs if RC.same_rec_book(r, cand)]
        if len(keep) != 1: continue
        for r in rs:
            if r is not keep[0]:
                r["bet_ids"] = ";".join(i for i in RC._ids(r) if i != bid)
                r["placed"] = "yes" if r["bet_ids"] else "no"
                r["notes"] = "; ".join(filter(None, [r["notes"], f"unlinked bet {bid}: a different game ({byid[bid]['event'][:40]})"]))
                log.append(f"unlinked {bid} from rec {r['rec_id']} (kept on {keep[0]['rec_id']})")
    # 2. recs linked to a bet at another book
    for r in list(rows):
        for bid in RC._ids(r):
            b = byid.get(bid)
            if not b or RC.bkey(b["book"]) == RC.bkey(r["book"]): continue
            if any(bid in RC._ids(x) and x is not r for x in rows): continue          # already has its own rec
            new = split_rec(r, b); rows.append(new)
            r["bet_ids"] = ";".join(i for i in RC._ids(r) if i != bid); r["placed"] = "yes" if r["bet_ids"] else "no"
            r["notes"] = "; ".join(filter(None, [r["notes"], f"bet {bid} was placed at {b['book']}, not {r['book']}: moved to rec {new['rec_id']}"]))
            log.append(f"rec {r['rec_id']} ({r['book']}) -> bet {bid} at {b['book']} now has rec {new['rec_id']}")
    return log

def split_rec(r, b):
    promo = RC.promo_of(" ".join([b["event"], b["market"], b["pick"], b.get("stake", "")]))
    pr = RC.am(b["price"]); bp = RC.am(b["boosted_price"]); unconf = "unconfirmed" in (b["price"] or "").lower()
    if bp is None and pr is not None and "x2" in (b["boosted_price"] or ""):
        dd = 1 + 2 * (RC.dec(pr) - 1); bp = round((dd - 1) * 100) if dd >= 2 else round(-100 / (dd - 1))
    eff = bp if bp and promo in ("profit boost", "live boost") else pr
    fair = (b.get("fair_pct") or "").strip(); note = [f"split from rec {r['rec_id']} (the bet was placed at {b['book']}, the rec was for {r['book']})"]
    if not fair and (r.get("fair_pct") or "").strip(): fair = r["fair_pct"]; note.append(f"fair % copied from rec {r['rec_id']} (same selection and game)")
    ev = (b.get("ev_pct") or "").strip()
    if not ev and fair and not unconf and eff is not None:
        v = RC.ev_calc(fair, eff, promo); ev = f"{v:g}" if v is not None else ""
    if unconf and pr is not None: note.append("price approx (unconfirmed in tracker)")
    fmt = lambda a: f"{a:+d}" if a is not None else ""
    n = {k: r.get(k, "") for k in RC.COLS}
    n.update({"rec_id": RC.rid(r["game_start_et"][:10], r["selection"], r["event"], b["book"]), "rec_date": b["date"], "rec_time_et": "",
              "market": b["market"], "book": b["book"], "rec_price": fmt(pr), "eff_price": fmt(eff), "fair_pct": fair, "ev_pct": ev,
              "stake": b.get("stake", ""), "promo": promo, "friend": "no", "placed": "yes", "bet_ids": b["bet_id"],
              "result": b["result"].strip().lower() if b["result"].strip().lower() in ("won", "lost", "push", "void") else "pending",
              "source": "fix_data_quirks.py (split)", "notes": "; ".join(note)})
    return n

def fill_start_et(bets):
    """{bet_id: (event, start_et)} for bets with a blank start_et that 3+ same-event, same-day bets agree on."""
    out = {}
    for b in bets:
        if (b.get("start_et") or "").strip(): continue
        ev = re.sub(r"\s*\([^)]*\)", "", b["event"]).strip()
        same = [x["start_et"].strip() for x in bets if x["bet_id"] != b["bet_id"] and x["start_et"].strip() and re.sub(r"\s*\([^)]*\)", "", x["event"]).strip() == ev]
        # same game = same event name and the start is on the day the bet was placed or the day after
        import datetime as dt
        d = dt.date.fromisoformat(b["date"]); days = {(d + dt.timedelta(days=k)).strftime("%a %b %d").replace(" 0", " ") for k in (0, 1)}
        same = [s for s in same if re.sub(r",", "", s)[:10].replace(" 0", " ") in days or re.sub(r",", "", s)[:10] in days]
        top = max(set(same), key=same.count) if same else None
        if top and same.count(top) >= 3: out[b["bet_id"]] = (ev, top)
    return out

def write_start(bet_id, value):
    for p in [BETS] + sorted(glob.glob(os.path.join(DATA, "archive", "bets-*.csv"))):
        txt = open(p, newline="").read()
        rows = list(csv.reader(txt.splitlines(True)))
        hdr = rows[0]; ib, isx = hdr.index("bet_id"), hdr.index("start_et")
        for i, r in enumerate(rows):
            if len(r) > ib and r[ib] == bet_id and not r[isx].strip():
                lines = txt.splitlines(True); r[isx] = value
                import io; buf = io.StringIO(); csv.writer(buf, lineterminator=lines[i][len(lines[i].rstrip("\r\n")):] or "\n").writerow(r)
                lines[i] = buf.getvalue()
                open(p, "w", newline="").write("".join(lines)); return p
    return None

def main(argv):
    apply = "--apply" in argv
    def run():
        bets = all_bets(); rows = RC.load(); log = fix_links(rows, bets)
        for l in log: print(l)
        st = fill_start_et(bets)
        for bid, (ev, s) in st.items(): print(f"start_et {bid} ({ev}) = {s!r} (agreed by 3+ other bets on that game)")
        print(f"{len(log)} link change(s), {len(st)} start_et fill(s)" + ("" if apply else "  [dry run, add --apply]"))
        if apply:
            RC.save(rows)
            for bid, (ev, s) in st.items(): print("written:", bid, write_start(bid, s))
    if apply:
        with lock(): run()
    else: run()

if __name__ == "__main__":
    main(sys.argv[1:])
