#!/usr/bin/env python3
"""Box-side helper: the box is only an editor of the repo. Every box writer runs
    with lock(): pre(); <change data/>; post("msg")
pre(): commit any hand edits under data/ (or index.html), then git pull --rebase from origin/main.
post(): commit data/, data.json, index.html if they changed and push (rebasing on a race, 3 tries).
GitHub Actions (autorun.yml) does the same from its side, so neither side overwrites the other.

  python3 scripts/repo_sync.py pull            # just bring the box copy up to date
  python3 scripts/repo_sync.py push "message"  # commit + push whatever changed
"""
import subprocess, sys, os, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import REPO, lock
PATHS = ["data", "data.json", "index.html"]

def g(*a, check=False):
    r = subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True)
    if check and r.returncode: raise SystemExit(f"git {' '.join(a)} failed: {r.stderr.strip()[-400:]}")
    return r

def _commit(msg):
    g("add", "-A", *PATHS)
    if g("diff", "--cached", "--quiet").returncode == 0: return False
    g("commit", "-qm", msg, check=True); return True

def pre():
    _commit(f"box: local edits {datetime.datetime.now():%Y-%m-%d %H:%M} ET")
    r = g("pull", "-q", "--rebase", "origin", "main")
    if r.returncode:
        g("rebase", "--abort")
        raise SystemExit("REPO SYNC CONFLICT: box edits and GitHub autorun changed the same rows. Nothing was overwritten; "
                         "resolve in /workspace/bet-dashboard (git status) then rerun.\n" + r.stderr.strip()[-400:])

def post(msg):
    committed = _commit(msg)
    if not committed and g("rev-list", "--count", "origin/main..HEAD").stdout.strip() in ("", "0"):
        print("no changes to publish"); return True
    for _ in range(3):
        r = g("push", "-q", "origin", "HEAD:main")
        if r.returncode == 0: print("pushed"); return True
        pr = g("pull", "-q", "--rebase", "origin", "main")
        if pr.returncode:
            g("rebase", "--abort"); print("PUSH FAILED (conflict with autorun): " + pr.stderr.strip()[-300:]); return False
    print("PUSH FAILED: " + r.stderr.strip()[-300:]); return False

if __name__ == "__main__":
    a = sys.argv[1:]
    with lock():
        if a and a[0] == "pull": pre(); print("up to date")
        elif a and a[0] == "push": pre(); sys.exit(0 if post(a[1] if len(a) > 1 else "box: update") else 1)
        else: sys.exit(__doc__)
