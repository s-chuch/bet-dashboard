"""Shared paths + the single writer lock for the bet tracker.

The repo (s-chuch/bet-dashboard) is the source of truth: data/*.csv are the books, scripts/ the logic.
Writers (autorun, ledger log/settle/anchor/sync, rec add/grade, build) take LOCK with flock so two
processes on the same machine never write at once. On GitHub Actions the workflow's concurrency group
does the same across runs. The lock is re-entrant for child processes via BETS_LOCK_HELD=1.
"""
import os, fcntl, time, contextlib, datetime
try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/Toronto")
except Exception:  # pragma: no cover
    ET = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO, "data")
BETS = os.path.join(DATA, "bets.csv")
LEDGER = os.path.join(DATA, "ledger.csv")
BAL = os.path.join(DATA, "balances.csv")
RECS = os.path.join(DATA, "recommendations.csv")
PIN_CACHE = os.path.join(DATA, "pregame_cache.json")
AUTO = os.path.join(DATA, "autorun.json")
LOCKFILE = os.environ.get("BETS_LOCK", "/tmp/bet-tracker.lock")
CI = os.environ.get("GITHUB_ACTIONS") == "true"

def now_et():
    """Naive datetime in Toronto time (CI runners are UTC)."""
    if ET: return datetime.datetime.now(ET).replace(tzinfo=None)
    return datetime.datetime.now()

@contextlib.contextmanager
def lock(timeout=180):
    if os.environ.get("BETS_LOCK_HELD") == "1":
        yield; return
    f = open(LOCKFILE, "a+")
    t0 = time.time()
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.time() - t0 > timeout:
                raise SystemExit(f"bet tracker busy: another writer holds {LOCKFILE} (waited {timeout}s)")
            time.sleep(1)
    os.environ["BETS_LOCK_HELD"] = "1"
    try:
        yield
    finally:
        os.environ.pop("BETS_LOCK_HELD", None)
        fcntl.flock(f, fcntl.LOCK_UN); f.close()
