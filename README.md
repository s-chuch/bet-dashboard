# bet-dashboard — Shawn's bet tracker (runs itself on GitHub)

Live site: https://s-chuch.github.io/bet-dashboard/ (GitHub Pages, branch `main`, root). Three static pages, all
vanilla JS from `assets/`, all reading the generated JSON in the repo root:
| Page | Shows | Reads |
|---|---|---|
| `index.html` (Live) | open bets with live scores, balances, needs-review, settled in the last 5 days, picks, health badge | `data.json` + live ESPN/Polymarket/Action Network + GitHub Actions API |
| `stats.html` (Stats) | totals, streaks, daily P&L, by book/market/odds/weekday, boosted vs regular, bankroll replay, picks record | `stats.json` |
| `log.html` (Logs) | archived bets, ledger activity, autorun run history | `archive.json`, `log.json`, GitHub Actions API |
**This repo is the source of truth.** Nothing runs on a schedule anywhere else (no box cron/systemd).

## What runs where
| What | Where | How often |
|---|---|---|
| `scripts/autorun.py` (settle → archive → balances → Tracker P&L → picks grading → rebuild `data.json`, `stats.json`, `archive.json`, `log.json`) | GitHub Actions, `.github/workflows/autorun.yml` | cron `*/5 * * * *` (GitHub may delay scheduled runs 5–20 min) + manual "Run workflow" |
| Live scores, WINNING/LOSING pills, leg bars, wagered brackets | the browser (`index.html`) | every 10 s while the page is open |
| Logging new bets, app-balance anchors, Drive screenshots | box (agent) via the wrappers below | when Shawn sends a bet / balance |

Runs never overlap (workflow `concurrency: autorun`). A run commits **only** when `data/`, `data.json`, `stats.json`, `archive.json` or `log.json` changed
(live-volatile fields like scores/clock are excluded from the change hash; a failed `autorun.py` still commits whatever
data it produced, then the run is marked failed), using the workflow's `GITHUB_TOKEN`
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
`autorun.json` (needs_review + last auto settles + errors), `archive/` (see below). **The repo is public, so all of this is publicly readable.**

**Archive:** settled bets whose `date` is more than 5 days old (date < today ET - 5) move out of `bets.csv` into
`data/archive/bets-YYYY-MM.csv` (same columns, sorted, deduped by `bet_id`; open bets are never archived). Each run that
moves rows appends to `data/archive/archive_log.csv`. `scripts/archive.py` runs in every autorun pass after settling and
before the build (a failure is reported in `errors` but never stops the build). Anything needing full history
(totals, stats, rec grading) reads `common.all_bets()` = `bets.csv` + archive. The ledger is untouched, so balances don't change.

**Generated JSON (repo root):** `data.json` (live page; `settled_recent` = bets dated in the last 5 days, `pnl_total` over all history),
`stats.json` (totals, streaks, daily, by book/market/odds/weekday, boosted vs regular, bankroll replay, picks record),
`archive.json` (archived bets, newest first), `log.json` (last 600 ledger events with labels, archive runs, autorun status).
The last three need no network: `python3 scripts/build.py --static`. Each file is rewritten only when its content changed.

## Box = editor only
`/workspace/sportsbets/{bets.csv,recommendations.csv,pregame_cache.json}`, `/workspace/sportsbook-balances/{ledger.csv,balances.csv}`
and `/workspace/sportsbets/dashboard/index.html` are symlinks into this checkout. Box writers take a flock
(`/tmp/bet-tracker.lock`), `git pull --rebase`, write, then commit + push (`scripts/repo_sync.py`):
- `python3 /workspace/sportsbook-balances/ledger.py log|settle|anchor|adjust|sync ...`
- `python3 /workspace/sportsbets/rec.py add|grade ...`
- `python3 /workspace/sportsbets/publish_dashboard.py` (one full autorun pass from the box + push)
- hand edits: `flock /tmp/bet-tracker.lock python3 /workspace/bet-dashboard/scripts/repo_sync.py pull`, edit, then
  `... repo_sync.py push "msg"`.

Manual commands: `python3 scripts/autorun.py --dry-run` (writes nothing), `python3 scripts/autorun.py --regrade 2026-10-18`
(re-grade bets settled that day), `python3 scripts/archive.py [--dry-run]`, `python3 scripts/build.py --static`.

## Security & automation
**What is hardened.** `autorun.yml` runs only on `s-chuch/bet-dashboard` (not forks), denies all token permissions
at the top level and grants `contents: write` + `pages: write` to the one job (which only runs on `main`), pins every action to a commit SHA
(Dependabot bumps them weekly), uses a 15-minute timeout, passes values through `env` rather than `${{ }}` in scripts,
commits only `data/`, `data.json`, `stats.json`, `archive.json`, `log.json`, and ends with a step that fails the run
if anything went wrong (which also turns the page's health badge red). Bot commits count as repo activity, so the
5-minute schedule is not auto-disabled after 60 days. `ci.yml` (PRs and non-main pushes, read-only token) compiles
the scripts, validates bet CSV headers / unique `bet_id`s across `bets.csv` + `data/archive/bets-*.csv` / JSON files, scans for secret patterns, and enforces the
page rule below. See `SECURITY.md` for reporting.

**Pages must not use inline script.** The pages declare a CSP via `<meta http-equiv="Content-Security-Policy">` with
`script-src 'self'`: put JS in files under `assets/`, no inline `<script>` bodies, no `onclick=` style attributes,
no `javascript:` URLs. CI fails on violations.

**Limits, honestly.** Data in a public repo is world-readable, including stakes and balances. GitHub Pages cannot send
custom HTTP headers, so CSP works only via meta tags and `frame-ancestors` (clickjacking protection) cannot be enforced.

**Repo settings to enable manually (Settings):**
- [ ] Branches / Rulesets: protect `main` (block force-push and deletion) but allow `github-actions[bot]` to push, or add the bot as a ruleset bypass actor.
- [ ] Code security: enable **Secret scanning** and **Push protection**.
- [ ] Code security: enable **Private vulnerability reporting**.
- [ ] Code security: enable **Dependabot alerts** (and security updates).
- [ ] Actions -> General: **Require approval for all outside collaborators**.
- [ ] Actions -> General: Workflow permissions = **Read repository contents** (read-only default); allow only GitHub-owned, verified-creator or SHA-pinned actions.
- [ ] Pages: tick **Enforce HTTPS**.

## Manual settle from the Logs page
`manual-settle.yml` (`workflow_dispatch` only, so only people with repo write access can run it) settles one open bet:
inputs `bet_id`, `result` (won/lost/void) and optional `profit` (CAD, used only for a win whose `to_win` is unknown).
It runs `scripts/manual_settle.py` (refuses unknown, already settled or archived bets), then a normal `autorun.py` pass,
commits `manual settle <id> <result>` and pushes. It shares the `autorun` concurrency group. The page calls
`POST https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/manual-settle.yml/dispatches` with
`{"ref":"main","inputs":{"bet_id":"...","result":"won","profit":""}}` using a fine-grained token limited to this repo
(Actions: read and write, Metadata: read). Never add other triggers to that workflow.
