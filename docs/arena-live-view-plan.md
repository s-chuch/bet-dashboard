# Live "Arena" view: game visuals toggle on index.html

## Context
The Live section of index.html shows open bets as cards (pill, score, legs, sparkline). Some per-sport visuals already exist inside expanded cards (`assets/ui-visuals.js`: period pips, baseball diamond, football field, soccer minute bar). Shawn wants a more fun way to watch live games. Chosen direction: **animated per-sport game visuals**, reached via a **toggle on the Live page** (current cards stay the default).

## Approach
Add a second view, "Arena", that shows one tile per live game (not per bet) with a big sport visual, and the user's bets on that game as chips underneath. No new data sources, since everything needed is already in `games[id]`, `summaries[id]`, `probs[id]`, `legStatsFor(b)` and `betLive(b)`.

### Tile contents (per live game, deduped from `DATA.open` via `gameFor`/`matchOfLeg`)
- Header: team badges (`LiveUI.badge` in ui-board.js), score, clock/period (`g.detail`), LIVE pill.
- Sport visual:
  - MLB: reuse the diamond + B/S/O + batter/pitcher (`baseballHTML` / `diamondSVG` in ui-visuals.js), enlarged.
  - NFL/college football: reuse `fieldHTML` (field, ball, first-down line).
  - Soccer: reuse `soccerHTML` minute bar, plus last-event badge from `playsOf(summaries[id])`.
  - NEW basketball: simple court with scoring-run bar (points in the last N plays from `playsOf`) and lead-swing meter.
  - NEW hockey: simple rink with shots-on-goal bars (`teams[].st`) and power-play badge.
- Tug-of-war win-probability bar from `probFor(m)` (ESPN `probs[id]`), with the `swingText` delta; falls back to no bar when null.
- "My bets" chips under the tile: each bet on that game shows its `pillState`/`betLive` colour and a mini ring (reuse ui-bets.js `ringHTML` / `legInfo`), tap to jump to the full card.
- Motion: reuse the existing score-change flash (`lbFlash`) and hit/bust animations (`uiPop`, `uiBust`); add a "last play" ticker line that slides in when `lastPlay` changes. Respect the global reduced-motion rule.

### Grid: minimized multi-game view
- Third toggle option. Every live game at once as a small tile (2 per row on a phone): league + clock, two score rows with team badges, thin win-chance bar, one-line situation (count/runners, down & distance, run, power play, last event), and one dot per bet on the game (green winning, amber even, red losing, ringed green = leg hit).
- Summary row above: games live, bets in play, winning / losing / one leg away. Tiles sorted by bets in play; a tile with a bet one leg away gets an amber border.
- Double-click (double-tap on phones, Enter on keyboard) a tile switches to Arena, scrolls to that game's full tile and highlights it briefly; a sticky "Back to grid" button returns. A single click only shows a "double-click to open" hint, so a stray tap never navigates.
- Reuses the same per-game data and bet states as Arena, so it is a second renderer in `ui-arena.js`, not new data work. Mockup: https://claude.ai/artifact/8fnAE4zP1zbk5ch8YSo7Az

### Bet slips with win chance
- Under each Arena tile, every bet on that game is a slip row: ring, pick, price · stake to win amount, and a large "NN% chance to win". Colour follows win/even/lose; a hit leg shows a check.
- Parlay slips list each leg underneath: status marker, description with progress, that leg's chance to win (`legP`) and its price. Parlay chance = product of the legs.
- Any slip with more than one leg gets a "N legs" tag, its headline label reads "all N legs hit", and the leg list ends with an "Overall chance this slip wins" row showing the product (for example 100% × 66% × 32% = 21%). Single-leg slips have no such row.
- In Grid, each bet shows its win % in place of a dot; multi-leg bets add a small "3L" tag.
- Source: `betLive(b)` / `legP` in home.js (market prices first, then the model estimate), same number the Cards view uses. For parlays, the product of leg chances.

### Total band (Arena and Grid)
- Above the tiles: chance of finishing ahead across all live bets, expected wins (sum of bet chances), amount at risk, expected profit, and best/worst case. Computed in the browser from each live bet's chance (`betLive`), stake and to-win; the "finish ahead" chance is exact by combining the bets (dynamic programming over outcomes), treating bets as independent. Bets on the same game are correlated, so the band notes that.

### Placement and toggle
- New segmented control (Cards | Arena | Grid) above `#live` in index.html; choice saved in `localStorage` (try/catch, default Cards).
- In Arena mode `#live` renders the tiles, and `#bets` (upcoming) and settled sections are unchanged.
- Hook in as `LiveUI.afterRender` / `LiveUI.tick`, like the other ui-* modules; no changes to `render()` card logic beyond a small mode check. If the hook throws, the Cards view still works (existing try/catch pattern).

## Files
- New: `assets/ui-arena.js` (tile builder, toggle, basketball/hockey visuals, registers on `window.LiveUI`), `assets/ui-arena.css`.
- Edit: `index.html` (toggle container, load new CSS/JS, bump `?v=` strings per convention), possibly export `baseballHTML`/`fieldHTML`/`soccerHTML` from `assets/ui-visuals.js` on `window.LiveUI` so the arena can reuse them; small mode check in `assets/home.js` `render()`.
- Cache busters: new files get `?v=1`; any edited asset gets its `?v=` bumped.

## Reuse (do not rewrite)
`LiveUI.badge`, `scoreBox` (ui-board.js); `baseballHTML`, `fieldHTML`, `soccerHTML`, `pipsHTML` (ui-visuals.js); `ringHTML`, `legInfo` (ui-bets.js); `gameFor`, `probFor`, `legStatsFor`, `betLive`, `pillState`, `swingText`, `playsOf`, `esc`, `setHTML` (home.js).

## Verification
- Serve locally (`python3 -m http.server 8765`), drive with Playwright (`/opt/node-tools/node_modules/playwright`) with external APIs routed via mocked ESPN scoreboard/summary fixtures for MLB, NFL, NBA, NHL and soccer; screenshot both toggle states at 375px and desktop width.
- Confirm: toggle persists across reload, Cards view unchanged, a score change fires the flash, a game with no `sit`/`probs` degrades gracefully, no console errors, reduced-motion disables animation.
- Run existing suites (`tests/test_*.py`, `node tests/slipparse.test.js`) to confirm nothing regressed. There are no JS tests for `home.js`/`ui-*.js`, so verification of the view is visual via Playwright.
- Deliver on branch `claude/cool-lamport-kglz2o`; push to `main` only if Shawn says so.

## Open risks
- Basketball run-bar and hockey rink depend on what ESPN `plays`/`teams[].st` actually contain; check real payloads first and cut the feature rather than fake data.
- Games live only via backup feeds (MLB statsapi, league feed) have no plays/situation, so tiles show score + clock only.
