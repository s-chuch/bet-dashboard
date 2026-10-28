# Betting rules in the program

Three rules the tracker now enforces or reports on. Each one only **flags or warns**; none of them blocks a bet.
Rule text shown on the Stats page (Game plan, rules 7–9) comes from `scripts/statsgen.py`.

## 1. Log CLV for every bet (boosted and unboosted kept apart)

- `data/clv.csv` has one row per bet (`bet_id`). Besides the older `placed_at`, `close_at`, `close_fair_pct`, `close_price`, `clv_pct`, `note`:
  - `open_price_unboosted`, `open_price_boosted` — the book prices when the bet was logged (boosted blank when there is no boost).
    Written by `ledger.py log` (so by `add_bets.py`, the uploader and the Finder). Only clean American prices are stored; `unconfirmed (~+120)` stays blank.
  - `close_price_unboosted` — the fair (no-vig) closing price of the bet's side. `close_price_boosted` — that fair close with the same boost % applied.
  - `clv_unboosted_pct` / `clv_boosted_pct` — `fair_close × decimal(open price) − 1`, for the unboosted and the boosted open price.
  - `close_source` — `pinnacle` (autorun capture in the last 60 min before the start) or `espn_dk_final` (see below).
- `clv_pct` and the headline CLV on the Stats page stay **Pinnacle, unboosted** only, so boosts never inflate CLV.
- Backfill / reminder list: `python3 scripts/clv_backfill.py [--espn] [--apply] [--json out.json]` (dry run by default).
  It copies open prices from `bets.csv`, expands existing Pinnacle closes to the new columns, and lists every straight bet still without a close.
  `--espn` adds ESPN's *final DraftKings line* (no-vig) for finished games as `espn_dk_final`. That is a soft-book proxy, **not** Pinnacle, and it is kept out of the headline CLV.
  The Pinnacle feed does not serve games that already started, so a close missed at the time cannot be recovered.
- Only straight ML / spread / total bets are graded for CLV (parlays and SGPs have no single closing line).

## 2. Boost rule (`scripts/rules.py`)

- Prefer boosts on **straights or 2-leg bets whose unboosted price is +100 to +299**.
- Avoid boosting plain cash favourites and 3-leg SGPs, **unless the promo requires 3 legs** (bet365 boosts; FanDuel NBA/NHL boosts). Required-3-leg boosts are never flagged.
- Anything outside the preferred set is *flagged* and needs **+2% EV at the model price**. Below that, or with no EV logged, it is a warning.
- Where it shows:
  - `ev_scan.py` / `finder.json`: `rules.boost_rule`, and each `boost_pool` entry carries `boost_rule` / `boost_rule_msg`. The pool is now +100 to +299 (was +100 to +300). Ad-hoc check: `python3 scripts/ev_scan.py --check-boost --legs 3 --price 110 --ev 1.5 --book DraftKings`.
  - Finder page: a rule note under the Profit boost helper and a tag on each pick.
  - `ledger.py log`: prints `boost rule ...` / `BOOST RULE WARNING` for a boosted bet.
  - Stats page, game plan rule 8: boosted bets in the last 7 days and how many were flagged low-EV / no EV.

## 3. Every bet links to a rec with fair % and EV at placement; skips are logged

- `ledger.py log` now, for every new bet (skip with `--no-rec`; `add_bets.py` does that for Finder bets because it links them itself):
  1. links it to an existing rec for the same selection, game day **and sportsbook**;
  2. otherwise creates a rec when the bet carries `fair_pct=` (EV is computed at the bet's own price, boosted price for profit boosts; not computed for unconfirmed prices);
  3. fills a blank `fair_pct` from the linked rec and a blank `ev_pct` from fair % and price (never overwrites);
  4. prints `WARNING: no rec linked ...` / `WARNING: no fair % / EV recorded` when it cannot. Pass `fair_pct=` (and `ev_pct=` if you have it) when logging a bet that did not come from the Finder.
- Linking is now book-aware: `rec.link_placed`, the Finder link and the skip log only match a rec at the same sportsbook, a bet links to at most one rec, and the event match ignores the shared `v` in `X v Y` names (that caused a bet to link to the wrong soccer draw rec).
- Skips: the Finder Skip button writes `data/finder_skips.csv` and a `placed=no` rec noted `SKIPPED in Bet Finder: <reason>`. `python3 scripts/rec.py skip --rec-id ID --note "why"` does the same for any other recommended pick that was not played.
- Audit / reminder list: `python3 scripts/audit.py [--since YYYY-MM-DD] [--json out.json]` (read only) lists bets with no rec, no fair %, no EV, no `start_et`, no close, a double link, or a rec at a different book.
- One-off clean-up of old data: `python3 scripts/fix_data_quirks.py [--apply]` (dry run by default, idempotent).
- Stats page: the CLV card shows closing-price coverage and bets with no rec; game plan rule 9 tracks it.
