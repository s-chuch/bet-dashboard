#!/usr/bin/env python3
"""Move old settled bets out of data/bets.csv into data/archive/bets-YYYY-MM.csv.

  python3 scripts/archive.py            # archive (idempotent)
  python3 scripts/archive.py --dry-run  # show what would move

Rule: result is settled (not open/blank) AND date < today_ET - 5 days. Open bets are never archived.
Archive files keep bets.csv columns, are sorted by date and deduped by bet_id; every write is tmp + os.replace.
One line per run that moved something is appended to data/archive/archive_log.csv (ts_et,moved,bet_ids,cutoff).
Readers needing full history use common.all_bets().
"""
import csv, os, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import BETS, ARCHIVE_DIR, ARCHIVE_LOG, ARCHIVE_DAYS, read_csv, now_et, lock

def _write(path, rows, cols):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, cols, extrasaction="ignore"); w.writeheader(); w.writerows(rows)
    os.replace(tmp, path)

def archive(dry=False, days=ARCHIVE_DAYS):
    """Returns list of moved bet_ids."""
    rows, cols = read_csv(BETS)
    if not rows: return []
    cutoff = (now_et().date() - datetime.timedelta(days=days)).isoformat()
    move = [r for r in rows if (r.get("result") or "").strip().lower() not in ("open", "")
            and (r.get("date") or "") and r["date"] < cutoff and r.get("bet_id")]
    if not move: return []
    if dry: return [r["bet_id"] for r in move]
    by_month = {}
    for r in move: by_month.setdefault(r["date"][:7], []).append(r)
    for ym, rs in by_month.items():   # archive first, so a crash never loses rows (dupes are deduped on read/next run)
        path = os.path.join(ARCHIVE_DIR, f"bets-{ym}.csv")
        old = read_csv(path)[0]
        have = {r["bet_id"]: r for r in old}
        for r in rs: have[r["bet_id"]] = r
        merged = sorted(have.values(), key=lambda r: (r["date"], r.get("start_et", ""), r["bet_id"]))
        _write(path, merged, cols)
    ids = {r["bet_id"] for r in move}
    _write(BETS, [r for r in rows if r.get("bet_id") not in ids], cols)
    new = not os.path.exists(ARCHIVE_LOG)
    with open(ARCHIVE_LOG, "a", newline="") as f:
        w = csv.writer(f)
        if new: w.writerow(["ts_et", "moved", "bet_ids", "cutoff"])
        w.writerow([now_et().strftime("%Y-%m-%d %H:%M"), len(ids), ";".join(r["bet_id"] for r in move), cutoff])
    return [r["bet_id"] for r in move]

if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    if dry: ids = archive(True)
    else:
        with lock(): ids = archive()
    print(f"archive: {'would move' if dry else 'moved'} {len(ids)} bets", ids if ids else "")
