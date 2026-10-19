#!/usr/bin/env python3
"""Keep ONE GitHub issue ("Bets need your OK") in sync with data/autorun.json needs_review, so a phone
notification arrives when something needs a decision. Needs GH_TOKEN and the gh CLI (both on Actions runners).

  - needs_review non-empty and no open issue  -> open one (mentions the owner)
  - the set of bet_ids changed                -> comment on it (that is what notifies) and refresh the body
  - needs_review empty and an issue is open   -> comment + close it
Never raises: a notification problem must not fail the tracker run.
"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import AUTO
TITLE = "Bets need your OK"
OWNER = os.environ.get("NOTIFY_MENTION", "s-chuch")
SITE = os.environ.get("NOTIFY_LOGS_URL", "log.html#activity")
MARK = "<!-- ids:"

def gh(*a):
    r = subprocess.run(["gh", *a], capture_output=True, text=True, timeout=60)
    if r.returncode: raise RuntimeError(f"gh {' '.join(a[:3])}: {r.stderr.strip()[-200:]}")
    return r.stdout

def body(items):
    ids = ",".join(sorted(i["bet_id"] for i in items))
    lines = [f"@{OWNER} {len(items)} bet(s) can't be settled automatically. Open the Logs page ({SITE}) and tap Win / Void / Loss.", ""]
    for i in items:
        lines.append(f"- **{i['book']}** · {i['pick'][:90]} (${i['stake']}) — {i['reason']}")
    lines += ["", f"{MARK}{ids} -->", "_Updated automatically by the tracker; this issue closes itself when nothing needs review._"]
    return "\n".join(lines), ids

def main():
    try:
        items = (json.load(open(AUTO)) if os.path.exists(AUTO) else {}).get("needs_review", [])
        found = json.loads(gh("issue", "list", "--state", "open", "--search", f'"{TITLE}" in:title', "--json", "number,title,body", "--limit", "5") or "[]")
        cur = next((x for x in found if x["title"] == TITLE), None)
        if not items:
            if cur:
                gh("issue", "close", str(cur["number"]), "--comment", "Nothing needs review any more.")
                print("notify: closed issue", cur["number"])
            return 0
        text, ids = body(items)
        if not cur:
            out = gh("issue", "create", "--title", TITLE, "--body", text); print("notify: opened", out.strip()); return 0
        old = (cur.get("body") or "")
        old_ids = old.split(MARK, 1)[1].split(" -->", 1)[0] if MARK in old else None
        if old_ids != ids:
            gh("issue", "edit", str(cur["number"]), "--body", text)
            gh("issue", "comment", str(cur["number"]), "--body", f"@{OWNER} the list changed: {len(items)} bet(s) need your OK ({SITE}).")
            print("notify: updated issue", cur["number"])
        else: print("notify: no change")
    except Exception as e:
        print("notify: skipped:", e); return 0
    return 0

if __name__ == "__main__": sys.exit(main())
