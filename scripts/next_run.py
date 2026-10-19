#!/usr/bin/env python3
"""How long until the next autorun, and is it live time? (used by .github/workflows/timer.yml and autorun.yml)

Rules:
  - A bet is ACTIVE ("live") from LEAD (10 min) before its start until it is settled, but no longer than ACTIVE_HOURS after the start.
    While any bet is active the timer starts a LIVE autorun: one long job that checks for finished games every ~10 s.
    The timer then wakes again after LIVE_SPAN (before that job ends, so the next one takes over without a gap).
  - Otherwise wake LEAD before the next upcoming start, but never wait longer than IDLE (1 hour). No upcoming bets: IDLE, forever.
  - Bets without a real start time (futures) and bets already waiting on the owner (needs_review) never count as active.

Prints `delay=<seconds> live=<true|false> reason=<text>`; with GITHUB_OUTPUT set it also writes those there.
  python3 scripts/next_run.py [--now 2026-10-19T00:00Z]   # plan; --now is for testing
  python3 scripts/next_run.py --live-check                # exit 0 while any bet is active, 1 otherwise (used inside the live loop)
"""
import json, os, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import REPO, AUTO

LEAD, LIVE_SPAN, IDLE, MIN_WAIT, ACTIVE_HOURS = 600, 3000, 3600, 30, 8
UTC = datetime.timezone.utc

def parse(ts):
    try: return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC)
    except Exception: return None

def plan(bets, review_ids, now):
    """-> (delay_seconds, reason, live). bets: dicts with bet_id and start_ts."""
    starts = []
    for b in bets:
        if b.get("bet_id") in review_ids: continue
        t = parse(b.get("start_ts") or "")
        if t: starts.append(t)
    lead, span = datetime.timedelta(seconds=LEAD), datetime.timedelta(hours=ACTIVE_HOURS)
    active = [t for t in starts if t - lead <= now <= t + span]
    future = sorted(t for t in starts if t - lead > now)
    if active:
        delay = LIVE_SPAN
        if future: delay = min(delay, max(MIN_WAIT, int((future[0] - lead - now).total_seconds())))
        return delay, f"{len(active)} bet(s) started or starting within {LEAD // 60} min: LIVE loop (checks every ~10 s)", True
    if future:
        wait = int((future[0] - lead - now).total_seconds())
        if wait < IDLE: return max(MIN_WAIT, wait), f"next bet starts {future[0]:%Y-%m-%d %H:%M}Z: waking {LEAD // 60} min before", False
        return IDLE, f"next bet starts {future[0]:%Y-%m-%d %H:%M}Z, far away: hourly check", False
    return IDLE, "no upcoming bets: hourly check", False

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
        delay, reason, live = plan(bets, review, now)
    except Exception as e:           # never leave the chain without a next step
        delay, reason, live = IDLE, f"could not read the bets ({e}): hourly check", False
    if "--live-check" in a: return 0 if live else 1
    print(f"delay={delay} live={'true' if live else 'false'} reason={reason}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f: f.write(f"delay={delay}\nlive={'true' if live else 'false'}\nreason={reason}\n")
    return 0

if __name__ == "__main__": sys.exit(main())
