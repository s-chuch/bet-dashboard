#!/usr/bin/env python3
"""Kalshi moneyline mid prices for the games on open bets -> a small JSON file (argv[1]).

Kalshi rejects browser requests, so the live loop runs this on the GitHub runner and force-pushes the file to the
`live-feed` branch (one commit, rewritten every time: no history growth, no Pages rebuild). The Live page reads it
through the GitHub contents API. Public data only; fails soft (no file written on any error)."""
import json, os, sys, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build

def main(out):
    d = json.load(open(os.path.join(build.REPO, "data.json")))
    games, seen = {}, set()
    for b in d.get("open", []):
        for m in [b.get("match")] + [L.get("match") for L in b.get("legs", [])]:
            if not m or m["id"] in seen or m["path"] not in build.KAL_SERIES: continue
            seen.add(m["id"])
            snap = m.get("snapshot") or {}
            if snap.get("completed"): continue
            try: k = build.kalshi_find(m)
            except Exception as e: print("kalshi_live", m["id"], e, file=sys.stderr); k = None
            if k: games[m["id"]] = {"home": k["home"], "away": k["away"], "spread": k["spread"]}
    if not games: return 0
    json.dump({"t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "games": games}, open(out, "w"))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/kalshi.json"))
