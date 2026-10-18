# bet-dashboard — Shawn's bet tracker (runs itself on GitHub)

Live page: https://s-chuch.github.io/bet-dashboard/ (GitHub Pages, branch `main`, root).
**This repo is the source of truth.** Nothing runs on a schedule anywhere else (no box cron/systemd).

## What runs where
| What | Where | How often |
|---|---|---|
| `scripts/autorun.py` (settle → balances → Tracker P&L → picks grading → rebuild `data.json`) | GitHub Actions, `.github/workflows/autorun.yml` | cron `*/5 * * * *` (GitHub may delay scheduled runs 5–20 min) + manual "Run workflow" |
| Live scores, WINNING/LOSING pills, leg bars, wagered brackets | the browser (`index.html`) | every 10 s while the page is open |
| Logging new bets, app-balance anchors, Drive screenshots | box (agent) via the wrappers below | when Shawn sends a bet / balance |

Runs never overlap (workflow `concurrency: autorun`). A run commits **only** when `data/` or `data.json` changed
(live-volatile fields like scores/clock are excluded from the change hash), using the workflow's `GITHUB_TOKEN`
(`contents: write`). No credentials are stored in the repo.

## Auto-settle rules (`scripts/settle.py`)
A bet is settled automatically only when **every game it depends on is final on ESPN** and **every leg is matched
and graded unambiguously** (ML incl. 3-way soccer, draw, spread, game/team totals, MLB game doubles, player props
from the ESPN box score / soccer lineups / MLB play-by-play). Settles go through `ledger.settle`, keyed by `bet_id`,
which refuses anything already settled (no double settles). Wins pay `to_win` (already the boosted payout).

Book void rules: bet365 soccer player props void if the player doesn't **start**; FanDuel/DraftKings/Caesars/theScore
void only if the player never plays (a parlay is then repriced → we can't know the price → review);
PointsBet/Hard Rock void the whole SGP.

Anything else goes to **needs_review** (`data/autorun.json`, shown at the top of the page) and is never auto-settled:
unknown/unlisted legs, unmatched team or player, ambiguous player names, missing stats, postponed/cancelled games,
soccer extra time, NFL ties, void legs that need repricing, wins with no/unconfirmed payout. Futures wait.

## Health
The page reads the public Actions API for this workflow and shows "Auto-updated h:mm ET". It turns **red** if the last
run failed or the last successful run is more than 30 minutes old. Run logs: Actions tab → autorun.

## Data (`data/`)
`bets.csv` (every bet, `bet_id`, `settled_at`, `settled_by=auto` for automatic settles), `ledger.csv` (append-only:
anchors, stakes, returns), `balances.csv` (generated), `recommendations.csv` (My picks log), `pregame_cache.json`,
`autorun.json` (needs_review + last auto settles). **The repo is public, so all of this is publicly readable.**

## Box = editor only
`/workspace/sportsbets/{bets.csv,recommendations.csv,pregame_cache.json}`, `/workspace/sportsbook-balances/{ledger.csv,balances.csv}`
and `/workspace/sportsbets/dashboard/index.html` are symlinks into this checkout. Box writers take a flock
(`/tmp/bet-tracker.lock`), `git pull --rebase`, write, then commit + push (`scripts/repo_sync.py`):
- `python3 /workspace/sportsbook-balances/ledger.py log|settle|anchor|adjust|sync ...`
- `python3 /workspace/sportsbets/rec.py add|grade ...`
- `python3 /workspace/sportsbets/publish_dashboard.py` (one full autorun pass from the box + push)
- hand edits: `flock /tmp/bet-tracker.lock python3 /workspace/bet-dashboard/scripts/repo_sync.py pull`, edit, then
  `... repo_sync.py push "msg"`.

Manual dry checks: `python3 scripts/autorun.py --dry-run`, `python3 scripts/autorun.py --regrade 2026-10-18`.
