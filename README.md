# bet-dashboard — Shawn's bet tracker (runs itself on GitHub)

Live site: hosted on Cloudflare Pages behind a login (see **Private hosting** below; before that, https://s-chuch.github.io/bet-dashboard/ on GitHub Pages). Three static pages, all
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
| `scripts/autorun.py` (settle → archive → balances → Tracker P&L → picks grading → rebuild `data.json`, `stats.json`, `archive.json`, `log.json`) | GitHub Actions, `.github/workflows/autorun.yml` | cron every 5 min while public (every 30 min once private, see **Private hosting**); GitHub may delay scheduled runs + manual "Run workflow" |
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

**Postponed / canceled / suspended games:** if every leg of a bet is in one game (single bet or same-game parlay) and ESPN
shows that game as Postponed, Canceled or Suspended (not completed), the bet is auto-**void**ed (stake refunded,
`settled_by=auto`, reason in the autorun log) once 48 hours have passed since the game's scheduled start (ET). Until then
it sits in needs_review with "game postponed; auto-void on <day time> ET if not played". If the game is completed
(even rescheduled) it is graded normally instead. Multi-game parlays with such a game, other statuses (forfeit,
abandoned) and missing/ambiguous ESPN data always stay in review.

Anything else goes to **needs_review** (`data/autorun.json`, shown at the top of the page) and is never auto-settled:
unknown/unlisted legs, unmatched team or player, ambiguous player names, missing stats, postponed/cancelled games in multi-game parlays or still inside the 48h grace,
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
at the top level and grants only `contents: write` to the one job (which only runs on `main`), pins every action to a commit SHA
(Dependabot bumps them weekly), uses a 15-minute timeout, passes values through `env` rather than `${{ }}` in scripts,
commits only `data/`, `data.json`, `stats.json`, `archive.json`, `log.json`, and ends with a step that fails the run
if anything went wrong (which also turns the page's health badge red). Bot commits count as repo activity, so the
schedule is not auto-disabled after 60 days. `ci.yml` (PRs and non-main pushes, read-only token) compiles
the scripts, validates bet CSV headers / unique `bet_id`s across `bets.csv` + `data/archive/bets-*.csv` / JSON files, scans for secret patterns, and enforces the
page rule below. See `SECURITY.md` for reporting.

**Pages must not use inline script.** The pages declare a CSP via `<meta http-equiv="Content-Security-Policy">` with
`script-src 'self'`: put JS in files under `assets/`, no inline `<script>` bodies, no `onclick=` style attributes,
no `javascript:` URLs. CI fails on violations.

**Limits, honestly.** Data in a public repo is world-readable, including stakes and balances. GitHub Pages cannot send
custom HTTP headers, so CSP works only via meta tags and `frame-ancestors` (clickjacking protection) cannot be enforced.

**Repo settings to enable manually (Settings):**
- [ ] [Branches / Rulesets](https://github.com/s-chuch/bet-dashboard/settings/rules): protect `main` (block force-push and deletion) but allow `github-actions[bot]` to push, or add the bot as a ruleset bypass actor.
- [ ] [Code security](https://github.com/s-chuch/bet-dashboard/settings/security_analysis): enable **Secret scanning** and **Push protection**.
- [ ] [Code security](https://github.com/s-chuch/bet-dashboard/settings/security_analysis): enable **Private vulnerability reporting**.
- [ ] [Code security](https://github.com/s-chuch/bet-dashboard/settings/security_analysis): enable **Dependabot alerts** (and security updates).
- [ ] [Actions -> General](https://github.com/s-chuch/bet-dashboard/settings/actions): **Require approval for all outside collaborators**.
- [ ] [Actions -> General](https://github.com/s-chuch/bet-dashboard/settings/actions): Workflow permissions = **Read repository contents** (read-only default); allow only GitHub-owned, verified-creator or SHA-pinned actions.
- [ ] [Pages](https://github.com/s-chuch/bet-dashboard/settings/pages) (only while still on GitHub Pages): tick **Enforce HTTPS**.

## Manual settle from the Logs page
`manual-settle.yml` (`workflow_dispatch` only, so only people with repo write access can run it) settles one open bet:
inputs `bet_id`, `result` (won/lost/void) and optional `profit` (CAD, used only for a win whose `to_win` is unknown).
It runs `scripts/manual_settle.py` (refuses unknown, already settled or archived bets), then a normal `autorun.py` pass,
commits `manual settle <id> <result>` and pushes. It shares the `autorun` concurrency group. The page calls
`POST https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/manual-settle.yml/dispatches` with
`{"ref":"main","inputs":{"bet_id":"...","result":"won","profit":""}}` using a fine-grained token limited to this repo
(Actions: read and write, Metadata: read). Never add other triggers to that workflow.

## Private hosting (free): private repo + Cloudflare Pages + Cloudflare Access
GitHub Pages is always public on free plans, so to put a login in front of the site the repo goes **private** and the
site is served by **Cloudflare Pages**, protected by **Cloudflare Access** (free plan, up to 50 users). Nothing else changes:
GitHub Actions still settles, archives and rebuilds, and Cloudflare redeploys on every push to `main`.
1. **Cloudflare account** (free): [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) -> sign up. Then *Zero Trust* (left menu), pick a team name, choose the **Free** plan (it may ask for a card to verify; the free plan is not charged).
2. **Pages project**: *Workers & Pages -> Create -> Pages -> Connect to Git* -> authorise the Cloudflare GitHub app for `s-chuch/bet-dashboard` (works for private repos) -> project name e.g. `bet-tracker`, production branch `main`, **no build command, output directory `/`** -> Save and Deploy. The site is now at `https://bet-tracker.pages.dev`.
3. **Login**: *Zero Trust -> Access -> Applications -> Add -> Self-hosted* -> application domain `bet-tracker.pages.dev` (also add `*.bet-tracker.pages.dev` so preview URLs are covered) -> policy **Allow**, include **Emails** = your email -> identity provider **One-time PIN** (default) -> Save. Visiting the site now asks for an emailed code (session length is configurable, e.g. 30 days, so the phone rarely asks).
4. **Check** in a private/incognito window that `https://bet-tracker.pages.dev/data.json` shows the login page, not JSON.
5. **Make the repo private**: GitHub -> Settings -> General -> Danger Zone -> [Change visibility](https://github.com/s-chuch/bet-dashboard/settings#danger-zone) -> Private. GitHub Pages is switched off automatically. Re-check *Settings -> Actions -> General* still allows workflows, and that the Cloudflare app keeps access.
6. **Actions minutes**: private repos on the free plan get 2,000 min/month. **Change the `cron` line in `.github/workflows/autorun.yml` to `"7,37 11-23,0-5 * * *"`** (every 30 min, 07:00-01:59 ET, about 1,150 min/month; minutes 7/37 because GitHub drops top-of-hour schedules). The current 5-minute schedule would use ~8,600+ min/month and exhaust the free allowance. Watch *Settings -> Billing -> Actions usage* the first week; tighten or loosen the `cron` line as needed. Bots' scheduled runs stop after 60 days of repo inactivity only if data stops changing.
7. **The Logs page** needs a GitHub token to read Actions runs and to settle bets (the repo is private): create a [fine-grained token](https://github.com/settings/personal-access-tokens/new?name=bet-tracker&target_name=s-chuch&expires_in=90&actions=write&metadata=read) for this repo only (Actions: Read and write, Metadata: Read; the link pre-fills them) and paste it into *Logs -> Activity -> Connect GitHub*. It is stored only in that browser.
**Honest limits:** anything that was public before stays in whatever copies, forks or caches already exist, so treat past data as seen. Cloudflare can serve a single page but the repo/Actions logs are private to you. Never print bet data in workflow logs on a public repo.

## Adaptive timer + live loop (GitHub only, free while the repo is public)
GitHub's own cron fires only about once per 8 hours, so `.github/workflows/timer.yml` is the clock. Each cycle `scripts/next_run.py` decides
what is due and the timer acts on it:
- **Live time** = a bet has started (or starts within 10 minutes) and is not settled yet (until 8 h after its start). The timer starts a **live autorun**:
  one long job (`autorun.yml` with `live=true`, up to 55 min) that checks for finished games **every 5-10 seconds** (10 s period, never closer than 5 s) (`scripts/autorun.py --fast`:
  only started bets, graded in parallel, ~6 s per pass) and does the full rebuild only when a bet actually settles. The timer wakes again after ~50 min
  (or 10 min before the next bet starts) so the next live job takes over without a gap. Live jobs have their own concurrency group, so box pushes never cancel a queued handoff.
- **Otherwise** it wakes **10 minutes before the next upcoming bet starts**, but at least once an hour, and runs a normal refresh. No upcoming bets: a check every hour, forever. Idle mode only exists to avoid pointless runs.
- Futures (no start time) and bets already waiting for your OK never count as live.
The Live page itself polls ESPN every 10 seconds (never closer than 5 s apart; it only backs off when ESPN answers HTTP 429).
A bet you log from the box still rebuilds the page right away (`autorun.yml` runs on pushes) and restarts the timer so it re-plans around the new bet.
Limits: only while the repo is **public** (it stops by itself when you make the repo private, since private repos have a monthly Actions-minutes allowance), only one timer exists at a time, and runs commit only when data changed.
**Off switch:** add a repository variable `AUTORUN_CHAIN` = `false` (Settings > Secrets and variables > Actions > Variables), or disable the *timer* workflow.
**Restart:** a 6-hourly cron and any push to `data/` restart it; or run *timer* by hand (Actions > timer > Run workflow).

## If GitHub's cron stalls (it is best-effort and may not fire for hours)
GitHub's cron has been observed firing about once in 8 hours instead of every 5 minutes, so **finished bets are settled when something starts a run**. Starters: the schedule, any push to `data/` or `scripts/` (every box commit), the Refresh button, and the Live page itself: with a token connected, an open Live page asks for a run (at most one per 5 min, once per finished bet) as soon as it sees a game finish. Updates are triggered these ways: the 5-minute `schedule`, any push to `data/` or `scripts/` (so every box commit rebuilds
immediately), and the **Refresh** button on the Live page, which with a connected token (Logs -> Activity -> Connect GitHub)
starts an `autorun` run and reloads the data about 45 and 90 seconds later. For a dependable timer without a server, use a
free external scheduler such as [cron-job.org](https://cron-job.org):
1. Create a *separate* fine-grained token ([pre-filled page](https://github.com/settings/personal-access-tokens/new?name=bet-timer&target_name=s-chuch&expires_in=90&actions=write&metadata=read)), repository `s-chuch/bet-dashboard` only. It can only start workflows, but treat it like a password: it lives on the third-party site.
2. New cron job -> URL `https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/autorun.yml/dispatches`, method **POST**, request body `{"ref":"main"}`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`. A success is HTTP 204.
3. Schedule **every 2 minutes** while the repo is public (Actions minutes are unlimited for public repos; each run takes about 30 s and only commits when data changed, and overlapping requests merge because the workflow queues at most one). Every 30 minutes once the repo is private (see the Actions-minutes note under *Private hosting*). In cron-job.org, tick *Save responses in history* and enable the failure notification so you hear if the token expires (it is 90 days by default).

## Set a book's balance from the Logs page
`set-balance.yml` (`workflow_dispatch` only) sets a fresh balance snapshot (ledger `anchor`) for one book when the app's
real cash balance differs from the tracker and open bets do not explain the gap. Inputs: `book` (PointsBet, bet365,
FanDuel, DraftKings, theScore, Caesars, Hard Rock), `amount` (app cash balance, CAD, up to 2 decimals, max 100000) and
optional `note`. It validates them, runs `scripts/set_balance.py` (same as `ledger.py anchor`; never touches `bets.csv`),
a normal `autorun.py` pass, commits `set balance <book> <amount>` and pushes. Later stakes/returns apply on top of the
new anchor. It shares the `autorun` concurrency group. The page calls
`POST https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/set-balance.yml/dispatches` with
`{"ref":"main","inputs":{"book":"FanDuel","amount":"123.45","note":""}}` and the same fine-grained token as manual settle.
