/* Run: node tests/slipparse.test.js   (exit code 1 on any failure)
 * Fixtures are Tesseract output of real screenshots with balances, receipt/bet ids and timestamps removed. */
'use strict';
var P = require('../assets/slipparse.js');
var fails = 0, n = 0;
function eq(label, got, want) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.error('FAIL ' + label + '\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function check(name, text, want, idx) {
  var all = P.parseSlips(text), r = idx == null ? P.parseSlip(text) : all[idx];
  Object.keys(want).forEach(function (k) { eq(name + '.' + k, r[k], want[k]); });
  return r;
}

var CAESARS_PLACED = [
  'Same Game Parlay Placed', 'Total Cash Wagered Total Payout', 'CS$0.50 C$2.29', 'CAESARS. =', 'SPORTSBOOK Be',
  'SGP 3-Leg Same Game Parlay +325 "A', 'Miami Dolphins at New York Jets | Under 26.5 | New', 'York Jets | 1st Quarter | OCT 25 1PM',
  'Under 26.5', 'New York Jets Total Points', '= New York Jets', 'Money Line', '1st Quarter', 'Quarter of 1st Touchdown',
  'Odds: +325', 'Cash Wagered: C$0.50', 'To Win: C$1.79', 'Profit Boost:', 'Pays: $2.43 = C$2.29', '< Share Bet'].join('\n');
check('caesars sgp', CAESARS_PLACED, {
  kind: 'placed', book: 'Caesars', event: 'Miami Dolphins @ New York Jets', start_text: 'OCT 25 1PM',
  market: 'SGP 3-leg (10% profit boost)', pick: 'Jets U26.5 team pts + Jets ML + 1st TD in 1st quarter',
  price: '+325', boosted_price: '+358', stake: 0.5, to_win: 1.79, boost_pct: 10 });

var CAESARS_4 = [
  'Same Game Parlay Placed', 'Total Cash Wagered Total Payout', 'C$0.50 C$3.10', 'CAESARS. S', 'SPORTSBOOK A',
  'SGP 4-Leg Same Game Parlay +400 "~', 'Los Angeles Kings at Washington Capitals | 2+ | 3+ | 3+ |', '24+ | OCT 20 7:08 PM',
  '(X21) Follow Bet on Lock Screen @ Track', '2+', 'Jakob Chychrun - Alternate Shots On Goal', '3+', 'Adrian Kempe - Alternate Shots On Goal',
  '3+', 'Alex Ovechkin - Alternate Shots On Goal', '24+', 'Darcy Kuemper - Alternate Saves',
  'Odds: +400', 'Cash Wagered: C$0.50', 'To Win: C$2.60', 'Profit Boost:', 'Pays: 6$2.50 9» C$3.10'].join('\n');
check('caesars nhl', CAESARS_4, { event: 'Los Angeles Kings @ Washington Capitals', price: '+400', boosted_price: '+520', to_win: 2.6, boost_pct: 30,
  pick: 'Jakob Chychrun 2+ SOG + Adrian Kempe 3+ SOG + Alex Ovechkin 3+ SOG + Darcy Kuemper 24+ saves' });

var DK = [
  '1:55 \\ al 5G @&', 'Y Receipt 1 of 1 Bets Placed', 'Bet Placed', '3 Pick Parlay CASH OUT G)', '',
  'BOS Celtics @ DET Pistons - Today 3:00 PM', 'BOS Celtics', 'Moneyline', '16+', 'Paul George Points', '25+', 'Jayson Tatum Points',
  'Wager Amount: $0.20 CAD', 'Total Payout: $1.22 CAD', 'Share the NHL Action', 'Keep Picks', 'in Betslip'].join('\n');
check('draftkings', DK, { kind: 'placed', book: 'DraftKings', event: 'Boston Celtics @ Detroit Pistons', market: 'SGP 3-leg',
  pick: 'Celtics ML + Paul George 16+ pts + Jayson Tatum 25+ pts', price: null, boosted_price: '+510', stake: 0.2, to_win: 1.02 });
eq('draftkings warns about price', P.parseSlip(DK).warnings.length > 0, true);

var B365_PLACED = [
  '2:17 4 al) 5G', 'Bet Placed', 'Track this event on your lock screen', 'LX Live Alerts Reuse Selections',
  'Bayern Munich v Arsenal +120 $0.20', 'To Return $0.56', 'incl $0.12 Boost', 'Harry Kane: 1+ Shots on Target', 'D>',
  'Player Shots on Target', 'Harry Kane: 3+ Shots |>', 'Player Shots', 'Jamal Musiala: 3+ Shots |>', 'Player Shots',
  'Wager To Return', '$0.20 $0.56'].join('\n');
check('bet365 placed', B365_PLACED, { kind: 'placed', book: 'bet365', event: 'Bayern Munich v Arsenal', price: '+120', boosted_price: '+180',
  stake: 0.2, to_win: 0.36, boost_pct: 50, pick: 'Harry Kane 1+ SOT + Harry Kane 3+ shots + Jamal Musiala 3+ shots' });

var B365_SETTLED = [
  'iGaming BetGuard', '| Y) $0.53 Returned |', 'WON', '$0.20 Same Game Parlay', '(") Share', '% SAME GAME PARLAY +110',
  'Beckett Sennecke: 2+ Shots on Goal', '] Shots on Goal', 'Pavel Dorofeyev: 2+ Shots on Goal', '] Shots on Goal',
  '@ Cutter Gauthier: 3+ Shots on Goal', 'Shots on Goal', 'ANA Ducks', 'NY Rangers', '30% PROFIT BOOST',
  'Wager Return', '$0.20 $0.49 incl $0.07 Boost', 'Y) $0.49 Returned', '$0.20 Same Game Parlay Lost'].join('\n');
check('bet365 settled', B365_SETTLED, { kind: 'settled', result: 'won', returned: 0.49, event: 'Anaheim Ducks @ New York Rangers',
  price: '+110', boosted_price: '+143', stake: 0.2, to_win: 0.29, boost_pct: 30,
  pick: 'Beckett Sennecke 2+ SOG + Pavel Dorofeyev 2+ SOG + Cutter Gauthier 3+ SOG' });

var FD = [
  '2:03 4 al 5G EX)', 'My Bets', 'Open Settled Saved', '@ Substituted players determined by Opta x', 'Go to Opta',
  'ON ont @ Live Cash Out', 'Same Game Parlay" +424', '@ PROFIT BOOST',
  'Boston Celtics Moneyline, Jayson Tatum To Score 20+ Points, A', 'Cade Cunningham To Score 15+ Points',
  'Boston Celtics @ Detroit Pistons 3:00PM ET', 'ey Boston Celtics', '2" MONEYLINE', 't% Jayson Tatum', 'wp 10 SCORE 20+ POINTS',
  'ge Cade Cunningham', 'ep 10 SCORE 15+ POINTS', '@ Follow bet on Lock Screen @', '$0.50 $171', 'TOTAL WAGER TOTAL PAYOUT'].join('\n');
var fd = check('fanduel', FD, { kind: 'open', book: 'FanDuel', event: 'Boston Celtics @ Detroit Pistons', start_text: '3:00PM ET',
  pick: 'Celtics ML + Jayson Tatum 20+ pts + Cade Cunningham 15+ pts', stake: 0.5, to_win: 1.21 });
eq('fanduel odds near +241', Math.abs(parseInt(fd.boosted_price, 10) - 241) <= 2, true); // wrong header (+424) rejected, derived from payout
eq('fanduel price unknown -> null', fd.price, null);

var PB_RECEIPT = [
  '3:03 NX all 5G', '< BACK', 'Betslip ra', 'BET RECEIPTS', 'Bet Placed', 'Same Game Parlay +440', 'ISGP}', '% Legs +210',
  'Toronto Maple Leafs @ Columbus Blue Jackets', 'NHL e Today, 7:15pm', 'Under 7.5', 'Pick Your Own Total', 'Over 1.5', 'Home Total (2-Way)',
  'Auston Matthews 3+', 'Alternate Player Shots', '50% NHL PROFIT BOOST OFFER', 'A Expires MinLegs Min Odds Max Wager Profit Boost',
  '8h55m 3 +100 $25.00 50%', 'WAGER PROFIT BOOST PAYOUT', '$0.50 $1.55 A'].join('\n');
check('pointsbet receipt', PB_RECEIPT, { kind: 'placed', book: 'PointsBet', event: 'Toronto Maple Leafs @ Columbus Blue Jackets',
  market: 'SGP 3-leg (50% NHL profit boost)', pick: 'Under 7.5 + Blue Jackets O1.5 team goals + Auston Matthews 3+ SOG',
  price: '+140', boosted_price: '+210', stake: 0.5, to_win: 1.05, boost_pct: 50 });

var PB_LIST = [
  'PB Q 2', '< BACK', 'Forest Green v Chesham Utd', 'English FA Cup e Tomorrow, 2:45pm', 'Chesham Utd', 'Match Result +1000',
  'WAGER ESTIMATED RETURN', '$10.00 | DEPOSIT MATCH $110.00', 'SHOW DETAILS', 'Barcelona v Alaves', 'Spanish LaLiga e Sat Oct 31st, 4:00pm',
  'Draw', 'Match Result +800', 'WAGER ESTIMATED RETURN', '$10.00 | & DEPOSIT MATCH $90.00', 'SHOW DETAILS'].join('\n');
eq('pointsbet list count', P.parseSlips(PB_LIST).length, 2);
check('pointsbet list 1', PB_LIST, { kind: 'open', event: 'Forest Green v Chesham Utd (English FA Cup)', pick: 'Chesham Utd', price: '+1000', stake: 10, to_win: 100 }, 0);
check('pointsbet list 2', PB_LIST, { pick: 'Draw', price: '+800', to_win: 80, market: '3-Way Draw (deposit match rollover)' }, 1);

var PB_SETTLED = ['PENDING SETTLED', 'Panteras de Aguascalientes v Lobos Plateados de la Buap', 'Mexican LNBP e Yesterday, 9:00pm',
  'Panteras de Aguascalientes', ', -210', 'Moneyline', 'WAGER NORETURN @', '$25.00 © DEPOSIT MATCH $36.90 Loss'].join('\n');
check('pointsbet lost', PB_SETTLED, { kind: 'settled', result: 'lost', price: '-210', stake: 25, to_win: 11.9 });

/* non-slips must come back as 'other' with everything null, and garbage must never throw */
var bonus = check('bonus offer', '$15 BONUS BET\nExpires on 10/31/2026\nEligible Events:\nAll Sports\nMinimum Odds:\n+300\nBet Now', { kind: 'other', book: null, pick: null, stake: null, price: null });
eq('other has a warning', bonus.warnings.length > 0, true);
check('tracker page', 'Bet Tracker Stats Logs\nLIVE NOW\nCaesars ($0.50)\n0/2 legs hit', { kind: 'other', stake: null });
['', '   ', 'hello world', '+++ $$$ @@@ \n\n 12345'].forEach(function (g, i) {
  var r = P.parseSlip(g); eq('garbage ' + i + ' -> other', r.kind, 'other'); eq('garbage ' + i + ' pick', r.pick, null);
});


/* ---------- Hard Rock fallback (synthetic layout fixtures) ---------- */
var HR_SINGLE = ['HARD ROCK BET', 'Bet Placed', 'Single', 'Toronto Raptors @ Boston Celtics 7:30 PM', 'Raptors +4.5 -110', 'Spread',
  'Wager $2.20', 'To Pay $4.20'].join('\n');
var hr = check('hard rock single', HR_SINGLE, { kind: 'placed', book: 'Hard Rock', event: 'Toronto Raptors @ Boston Celtics', price: '-110', stake: 2.2, to_win: 2, market: 'Single' });
eq('hard rock warns', hr.warnings.some(function (x) { return /fallback/.test(x); }), true);
var HR_BONUS = ['Hard Rock Bet', 'Bet Placed', 'Single', 'Bonus Bet', 'Atalanta v Frosinone', 'Draw +335', 'Wager $20.00', 'Potential Payout $67.00'].join('\n');
check('hard rock bonus', HR_BONUS, { kind: 'placed', book: 'Hard Rock', stake: 20, to_win: 67, price: '+335', market: 'Single (bonus bet $20)', event: 'Atalanta v Frosinone' });
var HR_LOST = ['Hard Rock Bet', 'My Bets', 'Settled', 'Lost', 'Heat @ Hornets', 'Heat ML +120', 'Wager $5.00', 'Paid $0.00'].join('\n');
check('hard rock lost', HR_LOST, { kind: 'settled', result: 'lost', stake: 5, book: 'Hard Rock' });
check('hard rock promo is not a slip', 'Hard Rock Bet\n$20 BONUS BET\nPlace a $5 bet at +100 or longer\nOpt in', { kind: 'other', stake: null });
var HR_PARLAY = ['Hard Rock Bet', 'Bet Placed', '3 Leg Parlay +596', 'Wager $1.00', 'To Pay $6.96'].join('\n');
var hp = check('hard rock parlay', HR_PARLAY, { stake: 1, to_win: 5.96, price: '+596', market: 'Parlay 3-leg', pick: null });
eq('hard rock parlay warns about legs', hp.warnings.some(function (x) { return /legs/.test(x); }), true);

/* ---------- friend check ---------- */
eq('account names', P.accountNames('Account: Mike Jones\nBet Placed'), ['Mike Jones']);
eq('welcome name', P.accountNames('Welcome back, Shawn!\nWager $1.00'), ['Shawn']);
eq('owner is not foreign', P.foreignAccount(['Shawn Chu Cheong'], null), []);
eq('owner handle not foreign', P.foreignAccount(['charles123'], null), []);
eq('friend is foreign', P.foreignAccount(['Mike Jones'], null), ['Mike Jones']);
eq('custom owners', P.foreignAccount(['Mike Jones'], ['Mike']), []);

/* ---------- math check ---------- */
eq('math ok', P.mathCheck(2, 4, '+200', '').level, 'ok');
eq('math ok negative', P.mathCheck(2.2, 2, '-110', '').level, 'ok');
eq('math ok boosted', P.mathCheck(1, 3.56, '+237', '+356').level, 'ok');
eq('math bonus profit only', P.mathCheck(20, 67, '+335', '').level, 'ok');
eq('math warn 3%', P.mathCheck(10, 20.6, '+200', '').level, 'warn');
eq('math block (payout typed as to_win)', P.mathCheck(10, 30, '+200', '').level, 'block');
eq('math cent rounding ok', P.mathCheck(0.5, 0.56, '+110', '').level, 'ok');
eq('math missing -> ok', P.mathCheck('', '', '', '').level, 'ok');

/* ---------- unclear-field flags ---------- */
eq('unclear odds+stake', P.unclearFields(['odds cut off', 'wager/return not readable']), { price: 1, stake: 1, to_win: 1 });
eq('derived odds not flagged', P.unclearFields(['odds not printed on the slip; derived from stake and payout']), {});
eq('plain warning not flagged', P.unclearFields(['settled FanDuel slips are only partially supported']), {});

console.log((n - fails) + '/' + n + ' assertions passed');
process.exit(fails ? 1 : 0);
