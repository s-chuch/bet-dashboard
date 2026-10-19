#!/usr/bin/env python3
"""How long until the next autorun? (used by .github/workflows/timer.yml)

Rules:
  - A bet is ACTIVE from LEAD (10 min) before its start until it is settled, but no longer than ACTIVE_HOURS after the start.
    While any bet is active: refresh every FAST seconds.
  - Otherwise wake LEAD before the next upcoming start, but never wait longer than IDLE (1 hour). No upcoming bets: IDLE, forever.
  - Bets without a real start time (futures) and bets already waiting on the owner (needs_review) never keep the timer fast.

Prints one line `delay=<seconds> reason=<text>`; with GITHUB_OUTPUT set it also writes delay= and reason= there.
  python3 scripts/next_run.py [--now 2026-10-19T00:00Z]   # --now is for testing
"""
import json, os, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import REPO, AUTO

LEAD, FAST, IDLE, MIN_WAIT, ACTIVE_HOURS = 600, 120, 3600, 30, 8
UTC = datetime.timezone.utc

def parse(ts):
    try: return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)
    except Exception: return None

def plan(bets, review_ids, now):
    """-> (delay_seconds, reason). bets: data.json open[] entries."""
    starts = []
    for b in bets:
        if b.get("bet_id") in review_ids: continue
        t = parse(b.get("start_ts") or "")
        if t: starts.append(t)
    active = [t for t in starts if t - datetime.timedelta(seconds=LEAD) <= now <= t + datetime.timedelta(hours=ACTIVE_HOURS)]
    if active:
        return FAST, f"{len(active)} bet(s) started or starting within {LEAD // 60} min: refreshing every {FAST}s"
    future = sorted(t for t in starts if t - datetime.timedelta(seconds=LEAD) > now)
    if future:
        wait = int((future[0] - datetime.timedelta(seconds=LEAD) - now).total_seconds())
        if wait < IDLE: return max(MIN_WAIT, wait), f"next bet starts {future[0]:%Y-%m-%d %H:%M}Z: waking {LEAD // 60} min before"
        return IDLE, f"next bet starts {future[0]:%Y-%m-%d %H:%M}Z, far away: hourly check"
    return IDLE, "no upcoming bets: hourly check"

def open_bets():
    """Open rows straight from data/bets.csv (always current, unlike data.json which autorun rebuilds) with a UTC start_ts."""
    import csv, build as B
    from common import BETS, ET
    out = []
    for r in csv.DictReader(open(BETS, newline="")):
        if (r.get("result") or "").strip().lower() not in ("open", ""): continue
        try:
            d = B.parse_date(r)
            ts = d.replace(tzinfo=ET).astimezone(UTC).strftime("%Y-%m-%dT%H:%MZ") if d and ET else None
        except Exception: ts = None
        out.append({"bet_id": r.get("bet_id"), "start_ts": ts})
    return out

def main():
    a = sys.argv[1:]
    now = parse(a[a.index("--now") + 1]) if "--now" in a else datetime.datetime.now(UTC)
    try:
        bets = open_bets()
        review = {r.get("bet_id") for r in (json.load(open(AUTO)).get("needs_review", []) if os.path.exists(AUTO) else [])}
        delay, reason = plan(bets, review, now)
    except Exception as e:           # never leave the chain without a next step
        delay, reason = IDLE, f"could not read the bets ({e}): hourly check"
    print(f"delay={delay} reason={reason}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f: f.write(f"delay={delay}\nreason={reason}\n")
    return 0

if __name__ == "__main__": sys.exit(main())
