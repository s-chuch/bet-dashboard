"""Shared paths + the single writer lock for the bet tracker.

The repo (s-chuch/bet-dashboard) is the source of truth: data/*.csv are the books, scripts/ the logic.
Writers (autorun, ledger log/settle/anchor/sync, rec add/grade, build) take LOCK with flock so two
processes on the same machine never write at once. On GitHub Actions the workflow's concurrency group
does the same across runs. The lock is re-entrant for child processes via BETS_LOCK_HELD=1.
"""
import os, fcntl, time, contextlib, datetime, csv, glob
try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/Toronto")
except Exception:  # pragma: no cover
    ET = None

REPO = os.environ.get("BETS_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # BETS_ROOT: per-user export dir (publish_snapshots.py)
DATA = os.path.join(REPO, "data")
BETS = os.path.join(DATA, "bets.csv")
LEDGER = os.path.join(DATA, "ledger.csv")
BAL = os.path.join(DATA, "balances.csv")
RECS = os.path.join(DATA, "recommendations.csv")
PIN_CACHE = os.path.join(DATA, "pregame_cache.json")
AUTO = os.path.join(DATA, "autorun.json")
ARCHIVE_DIR = os.path.join(DATA, "archive")
ARCHIVE_LOG = os.path.join(ARCHIVE_DIR, "archive_log.csv")
ARCHIVE_DAYS = 5
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

def read_csv(path):
    """(rows, fieldnames) of a CSV; ([], []) when missing/empty. None values become ''."""
    if not os.path.exists(path): return [], []
    with open(path, newline="") as f:
        rd = csv.DictReader(f); rows = list(rd); cols = list(rd.fieldnames or [])
    for r in rows:
        for k in list(r):
            if r[k] is None: r[k] = ""
    return rows, cols

def archive_files():
    return sorted(glob.glob(os.path.join(ARCHIVE_DIR, "bets-????-??.csv")))

def archive_rows():
    """Every archived (old, settled) bet row, oldest file first."""
    out, seen = [], set()
    for p in archive_files():
        for r in read_csv(p)[0]:
            b = r.get("bet_id")
            if b in seen: continue          # same id in two files (crash/month edit): count once
            seen.add(b); out.append(r)
    return out

def all_bets():
    """Full history: live bets.csv rows + archived rows (deduped by bet_id; bets.csv wins)."""
    live = read_csv(BETS)[0]
    seen = {r.get("bet_id") for r in live if r.get("bet_id")}
    return live + [r for r in archive_rows() if r.get("bet_id") not in seen]

# ---------- profit boost size ----------
BOOST_SIZES = (10, 15, 20, 25, 30, 33, 40, 50, 60, 75, 100)
def _am(s):
    import re as _re
    m = _re.search(r"[+-]?\d{3,}", str(s or "").replace("\u2212", "-"))
    return int(m[0]) if m else None
def boost_pct(market="", price="", boosted_price=""):
    """Boost size in %: from the market text ('50% Profit Boost'), else from unboosted vs boosted odds
    (profit ratio within 2 points of a standard size). None = unknown."""
    import re as _re
    t = str(market or "")
    m = _re.search(r"(\d{1,3})\s*%\s*(?:profit\s*|odds\s*|sgp\s*|parlay\s*)*boost", t, _re.I) or _re.search(r"boost[^%\d]{0,20}(\d{1,3})\s*%", t, _re.I)
    if m and 0 < int(m.group(1)) <= 200: return int(m.group(1))
    if "unconfirmed" in str(boosted_price).lower(): return None
    a, b = _am(price), _am(boosted_price)
    if a is None or b is None: return None
    pa = a / 100 if a > 0 else 100 / -a; pb = b / 100 if b > 0 else 100 / -b
    if pa <= 0 or pb <= pa: return None
    x = (pb / pa - 1) * 100
    near = min(BOOST_SIZES, key=lambda s: abs(s - x))
    return near if abs(near - x) <= 2.5 else None
