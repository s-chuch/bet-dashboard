/* slipparse.js - turn raw OCR text of ONE sportsbook screenshot into draft bet row(s).
 * Pure functions, no DOM, no network, ES2017. window.SlipParse = {parseSlip, parseSlips}.
 * Principle: correct-or-null. Anything guessed/derived that the user should double check
 * gets a string in `warnings`. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SlipParse = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* ---------- team table (for event names / short leg names) ---------- */
  var TEAM_SRC = {
    NBA: 'Atlanta|Hawks,Boston|Celtics,Brooklyn|Nets,Charlotte|Hornets,Chicago|Bulls,Cleveland|Cavaliers,Dallas|Mavericks,Denver|Nuggets,Detroit|Pistons,Golden State|Warriors,Houston|Rockets,Indiana|Pacers,Los Angeles|Clippers,Los Angeles|Lakers,Memphis|Grizzlies,Miami|Heat,Milwaukee|Bucks,Minnesota|Timberwolves,New Orleans|Pelicans,New York|Knicks,Oklahoma City|Thunder,Orlando|Magic,Philadelphia|76ers,Phoenix|Suns,Portland|Trail Blazers,Sacramento|Kings,San Antonio|Spurs,Toronto|Raptors,Utah|Jazz,Washington|Wizards',
    NFL: 'Arizona|Cardinals,Atlanta|Falcons,Baltimore|Ravens,Buffalo|Bills,Carolina|Panthers,Chicago|Bears,Cincinnati|Bengals,Cleveland|Browns,Dallas|Cowboys,Denver|Broncos,Detroit|Lions,Green Bay|Packers,Houston|Texans,Indianapolis|Colts,Jacksonville|Jaguars,Kansas City|Chiefs,Las Vegas|Raiders,Los Angeles|Chargers,Los Angeles|Rams,Miami|Dolphins,Minnesota|Vikings,New England|Patriots,New Orleans|Saints,New York|Giants,New York|Jets,Philadelphia|Eagles,Pittsburgh|Steelers,San Francisco|49ers,Seattle|Seahawks,Tampa Bay|Buccaneers,Tennessee|Titans,Washington|Commanders',
    NHL: 'Anaheim|Ducks,Boston|Bruins,Buffalo|Sabres,Calgary|Flames,Carolina|Hurricanes,Chicago|Blackhawks,Colorado|Avalanche,Columbus|Blue Jackets,Dallas|Stars,Detroit|Red Wings,Edmonton|Oilers,Florida|Panthers,Los Angeles|Kings,Minnesota|Wild,Montreal|Canadiens,Nashville|Predators,New Jersey|Devils,New York|Islanders,New York|Rangers,Ottawa|Senators,Philadelphia|Flyers,Pittsburgh|Penguins,San Jose|Sharks,Seattle|Kraken,St. Louis|Blues,Tampa Bay|Lightning,Toronto|Maple Leafs,Utah|Mammoth,Vancouver|Canucks,Vegas|Golden Knights,Washington|Capitals,Winnipeg|Jets',
    MLB: 'Arizona|Diamondbacks,Atlanta|Braves,Baltimore|Orioles,Boston|Red Sox,Chicago|Cubs,Chicago|White Sox,Cincinnati|Reds,Cleveland|Guardians,Colorado|Rockies,Detroit|Tigers,Houston|Astros,Kansas City|Royals,Los Angeles|Angels,Los Angeles|Dodgers,Miami|Marlins,Milwaukee|Brewers,Minnesota|Twins,New York|Mets,New York|Yankees,Oakland|Athletics,Philadelphia|Phillies,Pittsburgh|Pirates,San Diego|Padres,San Francisco|Giants,Seattle|Mariners,St. Louis|Cardinals,Tampa Bay|Rays,Texas|Rangers,Toronto|Blue Jays,Washington|Nationals',
    WNBA: 'Atlanta|Dream,Chicago|Sky,Connecticut|Sun,Dallas|Wings,Golden State|Valkyries,Indiana|Fever,Las Vegas|Aces,Los Angeles|Sparks,Minnesota|Lynx,New York|Liberty,Phoenix|Mercury,Seattle|Storm,Washington|Mystics'
  };
  var TEAMS = [];
  Object.keys(TEAM_SRC).forEach(function (lg) {
    TEAM_SRC[lg].split(',').forEach(function (s) {
      var p = s.split('|');
      TEAMS.push({ league: lg, city: p[0], nick: p[1] });
    });
  });
  function initials(c) { return c.split(' ').map(function (w) { return w[0]; }).join('').toLowerCase(); }
  /* -> {league, city, nick, sure} or null. Bare ambiguous nicknames (Rangers, Jets...) give sure:false. */
  function teamFind(x) {
    var s = String(x || '').toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+\d+$/, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    var c = TEAMS.filter(function (t) { var n = t.nick.toLowerCase(); return s === n || s.slice(-n.length - 1) === ' ' + n; });
    if (!c.length) return null;
    if (c.length === 1) return { league: c[0].league, city: c[0].city, nick: c[0].nick, sure: true };
    var tok = s.split(' ')[0], m = c.filter(function (t) {
      var ci = t.city.toLowerCase();
      return s.indexOf(ci + ' ') === 0 || initials(t.city) === tok || ci.slice(0, 3) === tok;
    });
    if (m.length) return { league: m[0].league, city: m[0].city, nick: m[0].nick, sure: true };
    return { league: null, city: null, nick: c[0].nick, sure: false };
  }
  function teamShort(x) { var f = teamFind(x); return f ? f.nick : String(x || '').trim(); }
  function teamFull(x) { var f = teamFind(x); return f && f.sure ? f.city + ' ' + f.nick : String(x || '').trim(); }
  function sportOf(s) {
    s = String(s || '');
    var m = /\b(NBA|WNBA|NFL|NHL|MLB|NCAAF|NCAAB)\b/.exec(s);
    return m ? m[1] : null;
  }

  /* ---------- small helpers ---------- */
  var MS = '(?:[CcSs€6]{0,2}\\$|CS)\\s?(\\d[\\d,]*\\.\\d{2})';
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function after(t, label) { var m = new RegExp(label + '\\s*:?\\s*' + MS, 'i').exec(t); return m ? num(m[1]) : null; }
  /* raw money strings in a line ("$0.50 $171" -> ['0.50','171']) */
  function moneyRaw(s) {
    var re = /(?:[CcSs€6]{1,2}\$|\bCS|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g, o = [], m;
    while ((m = re.exec(s))) o.push(m[1]);
    return o;
  }
  function moneys(s) { return moneyRaw(s).map(num); }
  function oddsIn(s) {
    var re = /(?:^|[\s,(])([+#\-–“"‘])\s?(\d{3,4})(?![\d:.])/g, o = [], m;
    while ((m = re.exec(s))) o.push((m[1] === '+' || m[1] === '#' ? '+' : '-') + m[2]);
    return o;
  }
  function ratioOf(p) { var n = parseInt(p, 10); return n > 0 ? n / 100 : 100 / -n; }
  function amer(r) {
    if (!isFinite(r) || r <= 0) return null;
    return r >= 1 ? '+' + Math.round(r * 100) : '-' + Math.round(100 / r);
  }
  function flip(p) { return (p[0] === '+' ? '-' : '+') + p.slice(1); }
  function r2(x) { return Math.round(x * 100) / 100; }
  /* choose a printed odds value consistent with the money (profit/stake); else derive from money. */
  function pickOdds(cands, derived, stake, w) {
    if (derived == null) return cands[0] || null;
    var tol = 0.015 + 0.007 / Math.max(0.05, (stake || 1) * derived), i, v;
    for (i = 0; i < cands.length; i++) {
      v = cands[i];
      if (Math.abs(ratioOf(v) / derived - 1) <= tol) return v;
      if (Math.abs(ratioOf(flip(v)) / derived - 1) <= tol) return flip(v);
    }
    if (cands.length) w.push('odds read from slip (' + cands.join(', ') + ') disagree with payout; used ' + amer(derived) + ' derived from stake/payout');
    return amer(derived);
  }
  function snapPct(base, boosted) {
    var p = (boosted / base - 1) * 100;
    return p < 2 ? null : Math.round(p / 5) * 5;
  }
  function clean(s) {
    return String(s || '').replace(/^[^A-Za-z0-9+\-$#]+/, '')
      .replace(/^(?:[a-z]{1,4}|[A-Z])\s+(?=[A-Z0-9])/, '')
      .replace(/\s*[|(\[]*[>»]+\)?\s*$/, '').trim();
  }
  /* strip OCR icon junk in front of a name by checking it against other mentions in the text */
  function cleanName(raw, ctx) {
    var tk = clean(raw).split(/\s+/);
    if (ctx.split(tk.join(' ')).length > 2) return tk.join(' ');
    while (tk.length > 1 && !/^[A-Z][A-Za-z.'’\-]{2,}$/.test(tk[0])) tk.shift();
    return tk.join(' ');
  }
  function dropJunk(n) {
    var tk = n.replace(/^[^A-Za-z]+/, '').split(/\s+/);
    while (tk.length > 1 && !/^[A-Z][A-Za-z.'’\-]{2,}$/.test(tk[0])) tk.shift();
    return tk.join(' ');
  }
  function numPlus(s) {
    var m = /(\d+(?:\.\d+)?)\s*\+/.exec(s) || /(\d+)\s*or more/i.exec(s);
    return m ? m[1] + '+' : null;
  }
  function ouTok(s) {
    var m = /^(over|under|o|u)\s*(\d+(?:\.\d+)?)/i.exec(s || '');
    return m ? m[1][0].toUpperCase() + m[2] : null;
  }
  var STATS = [
    [/shots? on target|\bsot\b/i, 'SOT'], [/shots? on goal|\bsog\b/i, 'SOG'], [/total bases/i, 'TB'],
    [/shots?/i, 'shots'], [/rebounds?/i, 'rebounds'], [/assists?/i, 'ast'], [/saves?/i, 'saves'],
    [/rec(?:eiving)?\.?\s*(?:yds|yards)/i, 'rec yds'], [/rush(?:ing)?\s*(?:yds|yards)/i, 'rush yds'],
    [/pass(?:ing)?\s*(?:yds|yards)/i, 'pass yds'], [/receptions?/i, 'rec'], [/points?|\bpts\b/i, 'pts'],
    [/hits?/i, 'hits'], [/runs?/i, 'runs'], [/goals?/i, 'goals'], [/strikeouts?/i, 'K'], [/touchdowns?|\btd\b/i, 'TD']
  ];
  function statShort(s, sport) {
    for (var i = 0; i < STATS.length; i++) if (STATS[i][0].test(s)) {
      return STATS[i][1] === 'shots' && sport === 'NHL' ? 'SOG' : STATS[i][1];
    }
    return null;
  }

  /* ---------- leg classification + normalisation (shared by all books) ---------- */
  var PLAYER_STAT = '(?:alternate\\s+)?(?:player\\s+)?(?:shots on goal|shots on target|total bases|shots|hits|points|rebounds|assists|saves|receiving (?:yds|yards)|rushing (?:yds|yards)|passing (?:yds|yards)|receptions|strikeouts|goals)';
  var PLAYER_RE = new RegExp('^(.+?)(?:\\s+-\\s+|\\s+)(' + PLAYER_STAT + ')$', 'i');
  /* classify a *market descriptor* line (the line under/over the selection) */
  function classify(s) {
    var m;
    if (/^(money ?line|match betting|match result|3-way.*)$/i.test(s)) return { t: 'ml' };
    if (/^(point )?spread$|^handicap$/i.test(s)) return { t: 'spread' };
    if (/^(total( points| runs| goals)?|pick your own total|game total.*)$/i.test(s)) return { t: 'total' };
    if ((m = /^(home|away) total/i.exec(s))) return { t: 'teamtotal', side: m[1].toLowerCase() };
    if ((m = /^(.+?) total( points| runs| goals)?$/i.exec(s)) && teamFind(m[1]) && !PLAYER_RE.test(m[1] + ' x')) {
      return { t: 'teamtotal', sub: m[1], unit: m[2] ? statShort(m[2]) : null };
    }
    if (/^anytime (td|touchdown|goal ?scorer)/i.test(s)) return { t: 'anytime', kind: /goal/i.test(s) ? 'goal' : 'td' };
    if (/^first (td|touchdown|goal) ?scorer/i.test(s)) return { t: 'first', text: s };
    if (/score or assist/i.test(s)) return { t: 'soa' };
    if (/quarter of 1st touchdown/i.test(s)) return { t: 'q1td' };
    if ((m = PLAYER_RE.exec(s)) && /\s/.test(m[1])) return { t: 'player', sub: m[1], stat: m[2] };
    return null;
  }
  function makeLeg(c, sel, ctx, w) {
    var sub = c.sub || '', m, t;
    sel = String(sel || '').trim();
    switch (c.t) {
      case 'ml':
        if (/^draw$/i.test(sel)) return 'Draw';
        return teamShort(sel) + ' ML';
      case 'spread':
        m = /^(.*?)\s*([+-]\d+(?:\.\d+)?)$/.exec(sel);
        if (m) return teamShort(m[1]) + ' ' + m[2];
        break;
      case 'total':
        if (/^(over|under)\s+\d/i.test(sel)) return sel.replace(/^(\w)(\w*)/, function (a, b, r) { return b.toUpperCase() + r.toLowerCase(); }).replace(/\s+(runs|goals|points)\b/i, function (a, u) { return ' ' + u.toLowerCase(); });
        break;
      case 'teamtotal':
        t = c.sub ? c.sub : (c.side === 'home' ? ctx.home : c.side === 'away' ? ctx.away : null);
        m = ouTok(sel);
        if (t && m) {
          var unit = c.unit || statShort(sel) || ({ NHL: 'goals', NBA: 'pts', WNBA: 'pts', NFL: 'pts', NCAAF: 'pts', NCAAB: 'pts', MLB: 'runs' }[ctx.sport]) || null;
          if (!unit) w.push('team total unit unknown: "' + sel + '"');
          return teamShort(t) + ' ' + m + ' team ' + (unit === 'pts' || !unit ? 'pts' : unit);
        }
        break;
      case 'anytime': return sub ? (c.kind === 'goal' ? sub + ' 1+ goals' : sub + ' anytime TD') : null;
      case 'first': return sub ? sub + ' ' + c.text.replace(/\b\w/g, function (x) { return x.toUpperCase(); }) : null;
      case 'soa': return sub ? sub + ' score or assist' : null;
      case 'q1td': return '1st TD in ' + sel.toLowerCase();
      case 'player':
        var st = statShort(c.stat, ctx.sport);
        m = ouTok(sel);
        var n = m || numPlus(sel);
        if (st && n) return sub + ' ' + n + ' ' + st;
        break;
    }
    w.push('could not normalise leg: "' + [sub, sel, c.stat || c.t].join(' / ') + '"');
    return (sub + ' ' + sel).trim();
  }
  /* (selection line, descriptor line) pairs in lines[from..to) */
  function scanPairs(L, from, to, ctx, w) {
    var legs = [], i, c, raw, sel, sub;
    for (i = Math.max(from, 1); i < to; i++) {
      raw = clean(L[i]);
      c = classify(raw);
      if (!c) continue;
      sel = clean(L[i - 1]);
      if (c.t === 'ml' || c.t === 'soa' || c.t === 'anytime' || c.t === 'first') {
        c.sub = c.sub || sel.replace(/\s+\d+\+$/, '');
      }
      if (c.t === 'player') c.sub = c.sub.replace(/^(?:[a-z]{1,4})\s+(?=[A-Z])/, '');
      legs.push(makeLeg(c, sel, ctx, w));
    }
    return legs;
  }

  /* ---------- result scaffolding ---------- */
  function blank(kind, book) {
    return { kind: kind, book: book || null, event: null, start_text: null, market: null, pick: null, price: null,
      boosted_price: null, stake: null, to_win: null, boost_pct: null, legs: [], ref: null, warnings: [], confidence: 0 };
  }
  function other(why) { var r = blank('other'); r.warnings.push(why); return finish(r); }
  function marketName(n, sgp, pct, word, single, boosted, sport) {
    var b = n > 1 ? (sgp ? 'SGP ' : 'Parlay ') + n + '-leg' : (single || null);
    if (b && pct) b += ' (' + pct + '% ' + (sport ? sport + ' ' : '') + word + ')';
    else if (b && boosted) b += ' (' + word + ')';
    return b;
  }
  function finish(r) {
    if (r.kind === 'other') { r.confidence = 0.05; return r; }
    if (r.legs.length) r.pick = r.legs.join(' + ');
    var c = 0.95;
    if (!r.pick) c -= 0.3;
    if (r.stake == null) c -= 0.3;
    if (r.to_win == null) c -= 0.15;
    if (r.price == null) c -= 0.1;
    c -= 0.07 * r.warnings.length;
    r.confidence = Math.max(0.05, Math.min(1, Math.round(c * 100) / 100));
    return r;
  }
  function eventFrom(txt) {
    var m = /^(.+?)\s+(?:@|at)\s+(.+)$/i.exec(txt);
    if (m) return { ev: teamFull(m[1]) + ' @ ' + teamFull(m[2]), away: m[1], home: m[2] };
    m = /^(.+?)\s+(vs\.?|v)\s+(.+)$/i.exec(txt);
    if (m) return { ev: m[1].trim() + ' ' + m[2].toLowerCase().replace('.', '') + ' ' + m[3].trim(), away: m[1], home: m[3] };
    return null;
  }
  function ctxOf(ev) {
    var e = ev && eventFrom(ev), f = e && teamFind(e.home);
    return { sport: f && f.league, home: e && e.home, away: e && e.away };
  }
  var DATE_RE = /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d/;

  /* ---------- Caesars ---------- */
  function parseCaesars(L, t) {
    var r = blank(/\bplaced\b/i.test(t) ? 'placed' : 'open', 'Caesars'), w = r.warnings, i;
    r.stake = after(t, 'Cash Wagered');
    r.to_win = after(t, 'To Win');
    var pair = [], k = L.findIndex(function (x) { return /Total Cash Wagered/i.test(x); });
    if (k >= 0) pair = moneys(L[k + 1] || '');
    if (r.to_win == null && r.stake != null && pair[1] != null) { r.to_win = r2(pair[1] - r.stake); w.push('to_win derived from total payout'); }
    if (r.to_win != null && r.stake != null && pair[1] != null && Math.abs(pair[1] - r.stake - r.to_win) > 0.02) w.push('total payout and To Win disagree');
    var hi = L.findIndex(function (x) { return /Same Game Parlay\s*[+#]?\d|\d-?Leg/i.test(x) && /Leg|Parlay/i.test(x); });
    var nm = /(\d)\s*-?\s*Leg/i.exec(L[hi] || ''), n = nm ? +nm[1] : null;
    var hdrOdds = oddsIn(L[hi] || '');
    var om = /Odds:\s*([+#\-])\s?(\d{3,4})/i.exec(t);
    var price = om ? (om[1] === '-' ? '-' : '+') + om[2] : null;
    var from = 0, hdr = '';
    if (hi >= 0) {
      var j = hi + 1;
      for (; j < Math.min(L.length, hi + 4); j++) { hdr += ' ' + L[j]; if (DATE_RE.test(L[j]) || /\|\s*\d+\s*(?:PM|AM)/i.test(L[j])) break; }
      if (hdr.indexOf('|') >= 0) {
        var parts = hdr.split('|').map(function (s) { return s.trim(); }), e = eventFrom(parts[0]);
        if (e) r.event = e.ev;
        if (DATE_RE.test(parts[parts.length - 1])) r.start_text = parts[parts.length - 1].replace(/\s+/g, ' ');
        from = j + 1;
      }
    }
    var end = L.findIndex(function (x) { return /^Odds:/i.test(x); });
    if (end < 0) end = L.length;
    r.legs = scanPairs(L, from, end, ctxOf(r.event), w);
    if (n && r.legs.length !== n) w.push('header says ' + n + ' legs but ' + r.legs.length + ' parsed');
    if (!r.event) w.push('event not visible');
    var d = r.stake && r.to_win != null ? r.to_win / r.stake : null, boosted = false;
    if (price == null && hdrOdds.length) { price = hdrOdds[0]; w.push('odds taken from header (OCR may misread)'); }
    r.price = price;
    if (d != null && price) {
      var tol = 0.015 + 0.007 / Math.max(0.05, r.stake * d), rb = d / ratioOf(price);
      if (rb > 1 + tol) {
        boosted = true; r.boosted_price = amer(d);
        r.boost_pct = snapPct(ratioOf(price), d);
        if (r.boost_pct == null) w.push('boost % unclear');
      } else if (rb < 1 - tol) w.push('To Win is lower than the odds imply; check stake/odds');
    } else if (d != null) w.push('price not readable');
    r.ref = (/\b([0-9a-f]{8})-[0-9a-f]{4}-/.exec(t) || [])[1] || null;
    r.market = marketName(r.legs.length || n, true, r.boost_pct, 'profit boost', 'Single', boosted);
    return [r];
  }

  /* ---------- FanDuel ---------- */
  function parseFanDuel(L, t) {
    var res = /^(WON|LOST)$/m.exec(t);
    var r = blank(/Bet Placed|bet has been placed/i.test(t) ? 'placed' : (res ? 'settled' : 'open'), 'FanDuel'), w = r.warnings;
    var wi = L.findIndex(function (x) { return /TOTAL WAGER/.test(x); });
    var raw = wi >= 0 ? moneyRaw(L[wi - 1] || '') : [];
    if (raw.length < 2 && wi >= 0) raw = moneyRaw(L[wi]);
    if (raw.length >= 2) {
      r.stake = num(raw[0]);
      var a = num(raw[1]), pay = a;
      if (raw[1].indexOf('.') < 0) {
        if (!(a > r.stake && a / r.stake <= 60)) { pay = a / 100; w.push('payout decimal point missing in OCR; read as ' + pay.toFixed(2)); }
      }
      if (pay > r.stake) r.to_win = r2(pay - r.stake);
      else w.push('payout not > stake; to_win left blank');
    } else w.push('stake/payout not found');
    if (res) { r.result = res[1].toLowerCase(); }
    var hi = L.findIndex(function (x) { return /Parlay|Moneyline|Spread/i.test(x) && oddsIn(x).length; });
    var cands = hi >= 0 ? oddsIn(L[hi]) : [];
    var si = L.findIndex(function (x) { return /@|\sv\s/.test(x) && /\d{1,2}:\d\d\s?[AP]M/i.test(x); });
    if (si >= 0) {
      var m = /^(.+?)\s+(@|v)\s+(.+?)\s+(\d{1,2}:\d\d\s?[AP]M(?:\s?ET)?)/i.exec(clean(L[si]));
      if (m) { r.event = m[2] === '@' ? teamFull(m[1]) + ' @ ' + teamFull(m[3]) : m[1] + ' vs ' + m[3]; /* FanDuel prints 'v', tracker uses 'vs' */ r.start_text = m[4]; }
    }
    var ctx = ctxOf(r.event), end = wi >= 0 ? wi : L.length, legs = [], i, d, sub, c;
    for (i = 1; i < end; i++) {
      d = L[i].replace(/^.*?(?=[A-Z]{3,})/, '');
      if (!d || d !== d.toUpperCase() || !/MONEYLINE|SPREAD|POINTS|ASSISTS|REBOUNDS|SHOTS|YARDS|TOUCHDOWN|\bTD\b|GOALS?|RECEPTIONS|HITS|SAVES|STRIKEOUTS/.test(d)) continue;
      sub = cleanName(L[i - 1], t);
      if (/MONEYLINE/.test(d)) c = { t: 'ml' };
      else if (/ANYTIME/.test(d)) c = { t: 'anytime', kind: /GOAL/.test(d) ? 'goal' : 'td', sub: sub };
      else c = { t: 'player', sub: sub, stat: d };
      legs.push(makeLeg(c, c.t === 'player' ? numPlus(d) || d : sub, ctx, w));
    }
    r.legs = legs;
    if (!legs.length) w.push('no legs recognised');
    var boost = /PROFIT BOOST/i.test(t), d0 = r.to_win != null ? r.to_win / r.stake : null;
    if (boost) r.boost_pct = ((/PROFIT BOOST\s*(\d{2,3})\s*%/i.exec(t)) || [])[1] * 1 || null;
    if (d0 != null) {
      var p = pickOdds(cands, d0, r.stake, w);
      if (boost) {
        r.boosted_price = p;
        if (r.boost_pct) r.price = amer(d0 / (1 + r.boost_pct / 100));
        else { r.price = null; w.push('profit boost % not readable; pre-boost price left blank'); }
      } else r.price = p;
    } else if (cands.length) w.push('odds on slip unverified: ' + cands.join(', '));
    r.market = marketName(legs.length, /Same Game Parlay|SGP/i.test(t), r.boost_pct, 'profit boost', 'Single', boost);
    r.ref = null;
    if (res) r.warnings.push('settled FanDuel slips are only partially supported');
    return [r];
  }

  /* ---------- DraftKings ---------- */
  function parseDraftKings(L, t) {
    var r = blank('placed', 'DraftKings'), w = r.warnings;
    r.stake = after(t, 'Wager Amount');
    var pi = L.findIndex(function (x) { return /Total Payout/i.test(x); }), pv = pi >= 0 ? moneys(L[pi]) : [];
    if (pi >= 0 && !pv.length) pv = moneys(L[pi + 1] || '');
    var payout = pv.length ? pv[pv.length - 1] : null, first = pv.length > 1 ? pv[0] : null;
    var hi = L.findIndex(function (x) { return /\d+\s*Pick/i.test(x); }), n = hi >= 0 ? +/(\d+)\s*Pick/i.exec(L[hi])[1] : null;
    var cands = hi >= 0 ? oddsIn(L[hi]) : [];
    var evRe = /^(.+?)\s@\s(.+?)\s+[•·+–-]\s+((?:Today|Tomorrow|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|[A-Z][a-z]{2}\s\d).*)$/;
    var ei = L.findIndex(function (x) { return evRe.test(x); }), m = ei >= 0 ? evRe.exec(L[ei]) : null;
    if (m) { r.event = teamFull(m[1]) + ' @ ' + teamFull(m[2]); r.start_text = m[3].replace(/\s+/g, ' '); }
    else w.push('event not found');
    if (L.filter(function (x) { return evRe.test(x); }).length > 1) w.push('several events on receipt (non-SGP parlay); only the first is filled');
    var end = L.findIndex(function (x) { return /Wager Amount/i.test(x); });
    r.legs = scanPairs(L, ei + 1, end < 0 ? L.length : end, ctxOf(r.event), w);
    if (n && n !== r.legs.length) w.push('header says ' + n + ' picks but ' + r.legs.length + ' parsed');
    var ref = /\b(DK\d{10,})\b/.exec(t); r.ref = ref ? ref[1] : null;
    if (r.stake == null || payout == null) { w.push('stake/payout not found'); }
    else {
      var d = (payout - r.stake) / r.stake;
      r.to_win = r2(payout - r.stake);
      var bm = /(\d+)\s*%\s*(?:PARLAY|PROFIT)\s*BOOST/i.exec(t), pct = bm ? +bm[1] : null, boosted = !!(bm || first != null || cands.length > 1);
      if (first != null) { r.price = amer((first - r.stake) / r.stake); r.boost_pct = snapPct((first - r.stake) / r.stake, d); }
      else if (cands.length > 1) r.price = cands[0];
      else if (pct) { r.price = amer(d / (1 + pct / 100)); r.boost_pct = pct; }
      if (boosted) r.boosted_price = pickOdds(cands.slice(-1), d, r.stake, w);
      else {
        r.boosted_price = amer(d);
        w.push('pre-boost price is not on the OCR text (struck-through); boosted_price is from the payout, price left blank');
      }
      var sg = r.legs.length > 1 && L.filter(function (x) { return evRe.test(x); }).length === 1;
      r.market = marketName(r.legs.length || n, sg, r.boost_pct, 'parlay boost', 'Single', boosted && r.boost_pct);
    }
    return [r];
  }

  /* ---------- PointsBet ---------- */
  var LEAGUE_RE = /^(.+?)\s+[e•·©@®]\s+((?:Today|Tomorrow|Yesterday)\b.*|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*|[A-Z][a-z]{2}\s\d.*)$/;
  var NA_LEAGUES = /^(NFL|NBA|NHL|MLB|WNBA|NCAAF|NCAAB)$/;
  function cutTime(s) { var m = /^(.*?\d\s?(?:am|pm))/i.exec(s); return (m ? m[1] : s).trim(); }
  function parsePointsBet(L, t) {
    if (/BET RECEIPTS|Receipt #/i.test(t)) return pbReceipt(L, t);
    var out = [], idx = [], i;
    for (i = 1; i < L.length; i++) if (LEAGUE_RE.test(L[i])) idx.push(i);
    idx.forEach(function (lg, k) {
      var stop = k + 1 < idx.length ? idx[k + 1] - 1 : L.length, seg = L.slice(lg - 1, stop);
      out.push(pbCard(seg));
    });
    if (!out.length) return [other('PointsBet screen without recognisable bet cards')];
    return out;
  }
  function pbCard(S) {
    var lm = LEAGUE_RE.exec(S[1]), r = blank('open', 'PointsBet'), w = r.warnings;
    var lg = clean(lm[1]), ev = clean(S[0]);
    var e = eventFrom(ev);
    r.event = (e ? e.ev : ev) + (NA_LEAGUES.test(lg) ? '' : ' (' + lg + ')');
    r.start_text = cutTime(lm[2]);
    var sel = clean(S[2] || ''), wi = S.findIndex(function (x) { return /^WAGER\b/i.test(x); });
    var head = S.slice(2, wi < 0 ? S.length : wi).join(' ');
    var mk = /(Match Result|Moneyline|Total|Spread)/i.exec(S.slice(3, wi < 0 ? S.length : wi).join(' '));
    var cands = oddsIn(head);
    var amt = wi >= 0 ? moneys(S[wi + 1] || '') : [], hdr = wi >= 0 ? S[wi] : '';
    if (amt.length >= 2) {
      r.stake = amt[0]; var ret = amt[amt.length - 1];
      r.to_win = r2(ret - r.stake);
      if (/NO\s*RETURN/i.test(hdr)) { r.kind = 'settled'; r.result = 'lost'; r.returned = 0; w.push('lost bet: to_win is the would-be profit'); }
      else if (/PAYOUT/i.test(hdr)) { r.kind = 'settled'; r.result = 'won'; r.returned = ret; }
      r.price = pickOdds(cands, r.to_win / r.stake, r.stake, w);
    } else { w.push('wager/return line not readable'); r.price = cands[0] || null; }
    var name = mk ? mk[1].toLowerCase() : '';
    var dm = /DEPOSIT MATCH/i.test(S.join(' ')) ? ' (deposit match rollover)' : '';
    if (name === 'match result') r.market = (/^draw$/i.test(sel) ? '3-Way Draw' : '3-Way Moneyline') + dm;
    else if (name) r.market = name[0].toUpperCase() + name.slice(1) + dm;
    r.legs = [sel];
    return finish(r);
  }
  function pbReceipt(L, t) {
    var r = blank(/Bet Placed/i.test(t) ? 'placed' : 'open', 'PointsBet'), w = r.warnings;
    var rm = /Receipt\s*#\s*(\w+)/i.exec(t); r.ref = rm ? rm[1] : null;
    var li = L.findIndex(function (x) { return LEAGUE_RE.test(x); });
    var sport = null;
    if (li > 0) {
      var lm = LEAGUE_RE.exec(L[li]); r.start_text = cutTime(lm[2]); sport = sportOf(lm[1]);
      var e = eventFrom(clean(L[li - 1]));
      if (e) { r.event = e.ev + (sport ? '' : ' (' + clean(lm[1]) + ')'); }
    } else w.push('event not found');
    var ctx = ctxOf(r.event); ctx.sport = ctx.sport || sport;
    var ei = L.findIndex(function (x) { return /PROFIT BOOST OFFER|^WAGER\b/i.test(x); });
    var legs = [], i, sel, desc, c, m;
    for (i = li + 1; i + 1 < (ei < 0 ? L.length : ei); i += 2) {
      sel = clean(L[i]); desc = clean(L[i + 1]);
      c = classify(desc);
      if (c && (c.t === 'ml' || c.t === 'soa' || c.t === 'anytime')) c.sub = sel;
      if (!c || /^player/i.test(desc) || /^alternate/i.test(desc)) {
        m = /^(.+?)(?:\s+To (?:Get|Score|Record|Have))?\s+(\d+\+)(?:\s+(.*))?$/i.exec(sel);
        if (m) { c = { t: 'player', sub: m[1], stat: desc + ' ' + (m[3] || '') }; sel = m[2]; }
      }
      legs.push(c ? makeLeg(c, sel, ctx, w) : (w.push('unrecognised leg: ' + sel + ' / ' + desc), sel));
    }
    r.legs = legs;
    var nm = /(\d+)\s*Legs?/i.exec(t);
    if (nm && +nm[1] !== legs.length) w.push('header says ' + nm[1] + ' legs but ' + legs.length + ' parsed');
    var wi = L.findIndex(function (x) { return /^WAGER\b.*PAYOUT/i.test(x); }), amt = wi >= 0 ? moneys(L[wi + 1] || '') : [];
    var cands = [], hdrs = L.filter(function (x) { return /Parlay|\bLegs?\b/i.test(x); });
    hdrs.forEach(function (x) { cands = cands.concat(oddsIn(x)); });
    if (amt.length >= 2) {
      r.stake = amt[0]; r.to_win = r2(amt[1] - amt[0]);
      var d = r.to_win / r.stake, pm = /(\d+)\s*%\s*(?:[A-Z]+\s+)?PROFIT BOOST OFFER/i.exec(t);
      var p = pickOdds(cands, d, r.stake, w);
      if (pm) { r.boost_pct = +pm[1]; r.boosted_price = p; r.price = amer(d / (1 + r.boost_pct / 100)); }
      else if (/PROFIT BOOST/i.test(t)) { r.boosted_price = p; w.push('boost % not readable'); }
      else r.price = p;
      r.market = marketName(legs.length, /Same Game Parlay/i.test(t), r.boost_pct, 'profit boost', 'Single', !!r.boosted_price, sport);
    } else w.push('wager/payout not found');
    return [r];
  }

  /* ---------- bet365 ---------- */
  var B365_DESC = /^(Player Shots on Target|Player Shots|Shots on Goal|Rebounds|Assists|Points|Receiving Yds|Receptions|Total|Money Line|Team \d Total|Anytime TD Scorer|Passing Yds|Rushing Yds|Player [A-Za-z ]+|[A-Za-z ]+ Yds)$/i;
  function b365Legs(L, ctx, w) {
    var legs = [], acc = [], i, s, T, D, m, c, sub;
    for (i = 0; i < L.length; i++) {
      s = L[i].replace(/^[^A-Za-z0-9]+/, '').replace(/\s*[|(\[]*[>»]+\)?\s*$/, '').trim();
      if (!s || (s.length <= 3 && !/\d/.test(s))) continue;
      if (/^(To Return|Track this|Live Alerts|Bet Ref|Bet Placed|SAME GAME PARLAY|PARLAY|.*Live Alerts.*|.*Reuse Selections)/i.test(s) || /inc[li1].*Boost/i.test(s)) { acc = []; continue; }
      if (/^(Wager|\d+%\s*PROFIT BOOST)/i.test(s)) break;
      if (B365_DESC.test(s) && acc.length) {
        T = acc.join(' ').replace(/\s+/g, ' '); D = s; acc = [];
        if ((m = /^(.+?):\s*(.+)$/.exec(T))) {
          if (/^money ?line$/i.test(m[1])) { legs.push(makeLeg({ t: 'ml' }, m[2], ctx, w)); continue; }
          c = /^Team \d Total$/i.test(D)
            ? { t: 'teamtotal', sub: dropJunk(m[1]), unit: statShort(m[2]) }
            : { t: 'player', sub: dropJunk(m[1]), stat: m[2] + ' ' + D };
          legs.push(makeLeg(c, c.t === 'teamtotal' ? m[2] : (ouTok(m[2]) ? m[2] : numPlus(m[2])), ctx, w));
        } else if (/^total$/i.test(D)) legs.push(makeLeg({ t: 'total' }, T, ctx, w));
        else if ((m = /^(.+?)\s+to score a td/i.exec(T))) legs.push(dropJunk(m[1]) + ' anytime TD');
        else { w.push('unrecognised leg: ' + T + ' / ' + D); legs.push(T); }
        continue;
      }
      if (/:|^(Over|Under)\s+\d|to score a td/i.test(s)) acc = [];  /* a new leg starts here; earlier lines were OCR junk */
      acc.push(s);
    }
    return legs;
  }
  function parseBet365(L, t) {
    var hs = [], i;
    for (i = 0; i < L.length; i++) if (/^(SAME GAME PARLAY|PARLAY)\b.*[+#]\d{3}/i.test(clean(L[i]))) hs.push(i);
    if (/Bet Placed/i.test(t) && /Bet Ref/i.test(t) || !hs.length) {
      var c = b365Card(L, 0, L.length, true);
      return [c];
    }
    return hs.map(function (h, k) { return b365Card(L, h, k + 1 < hs.length ? hs[k + 1] : L.length, false); });
  }
  function b365Card(L, from, to, placed) {
    var S = L.slice(from, to), t = S.join('\n'), r = blank(placed ? 'placed' : 'settled', 'bet365'), w = r.warnings, i;
    var ref = /Bet Ref\s*(\w+)/i.exec(t); r.ref = ref ? ref[1] : null;
    var hdr = null, ev = null;
    if (placed) {
      var m = /^(.+?)\s+([+#-]\d{3,4})\s+\$?(\d[\d.,]*)\s*$/.exec(L.filter(function (x) { return /\s[+#-]\d{3,4}\s+\$?\d/.test(x); })[0] || '');
      if (m) { ev = m[1]; hdr = m[2].replace('#', '+'); r.stake = num(m[3]); r.event = eventFrom(ev) ? eventFrom(ev).ev : ev; }
    } else {
      hdr = (oddsIn(clean(S[0])) || [])[0] || null;
      var back = '', b;
      for (b = from - 1; b >= Math.max(0, from - 6); b--) { if (/Returned/i.test(L[b])) break; back += ' ' + L[b]; }
      var rm = /\b(WON|W[GO0]|LOST|Lost|VOID|Void|Push)\b/.exec(back);
      if (rm) r.result = /^W/i.test(rm[1]) ? 'won' : /^L/i.test(rm[1]) ? 'lost' : 'void';
      else w.push('result badge not found');
    }
    var wi = S.findIndex(function (x) { return /^Wager\b/i.test(x); });
    var amt = wi >= 0 ? moneys((S[wi + 1] || '').replace(/inc[li1].*$/i, '')) : [];
    var ret;
    if (amt.length >= 2) { r.stake = amt[0]; ret = amt[1]; }
    else if (r.stake == null) {
      var sm = /\$\s?(\d[\d.]*)\s+Same Game Parlay/i.exec(t + ' ' + (from > 0 ? L.slice(Math.max(0, from - 6), from).join(' ') : ''));
      if (sm && amt.length) { r.stake = num(sm[1]); ret = amt[0]; w.push('stake read from the card title (wager line garbled)'); }
      else w.push('wager/return not readable');
    }
    var tr = /To Return\s*\$?\s*(\d[\d.,]*)/i.exec(t); if (!r.stake || ret == null) { if (tr) ret = num(tr[1]); }
    var bm = /inc[li1]\s*\$?\s*(\d[\d.,]*)\s*Boost/i.exec(t), boostAmt = bm ? num(bm[1]) : null;
    var pm = /(\d+)\s*%\s*PROFIT BOOST/i.exec(t), pct = pm ? +pm[1] : null;
    var rl = S.filter(function (x) { return /Returned/i.test(x) && moneys(x).length; });
    if (!placed && rl.length) r.returned = moneys(rl[rl.length - 1])[0];
    var lost = r.result === 'lost' || (ret === 0);
    if (r.stake != null && ret != null && ret > r.stake) {
      var profit = ret - r.stake; r.to_win = r2(profit);
      r.boosted_price = amer(profit / r.stake);
      if (boostAmt != null && profit - boostAmt > 0) {
        var base = (profit - boostAmt) / r.stake;
        r.price = pickOdds(hdr ? [hdr] : [], base, r.stake, w);
        r.boost_pct = pct || snapPct(base, profit / r.stake);
      } else { r.price = hdr; r.boost_pct = pct; if (pct) w.push('boost % from slip label; boost amount not visible'); }
      if (!boostAmt && !pct) r.boosted_price = null;
      else if (r.price && r.boost_pct) {  /* exact boost arithmetic beats cent-rounded payouts */
        var calc = amer(ratioOf(r.price) * (1 + r.boost_pct / 100)), tl = 0.015 + 0.007 / Math.max(0.05, r.stake * profit / r.stake);
        if (Math.abs(ratioOf(calc) / (profit / r.stake) - 1) <= tl) r.boosted_price = calc;
      }
    } else if (lost && hdr && pct && r.stake) {
      r.price = hdr; r.boost_pct = pct; r.boosted_price = amer(ratioOf(hdr) * (1 + pct / 100));
      r.to_win = r2(r.stake * ratioOf(r.boosted_price));
      w.push('lost bet: to_win estimated from odds and boost, not shown on slip');
    } else { r.price = hdr; if (r.stake != null) w.push('payout not available; to_win left blank'); }
    var lines = S.slice(1), ctx = ctxOf(r.event);
    r.legs = b365Legs(lines, ctx, w);
    if (!r.legs.length) w.push('no legs recognised');
    if (!placed) {
      var teams = [];
      S.forEach(function (x) { var f = clean(x).replace(/\s+\d+$/, ''); if (f && teamFind(f) && teamFind(f).sure && !/[:]|PROFIT|Wager|Return/i.test(f) && teams.length < 2 && f.length < 28) teams.push(teamFull(f)); });
      if (teams.length === 2) r.event = teams[0] + ' @ ' + teams[1]; else w.push('event not visible');
    }
    var sgp = /SAME GAME PARLAY/i.test(t) || /Same Game Parlay/i.test(t);
    r.market = marketName(r.legs.length, sgp, r.boost_pct, 'profit boost', 'Single', !!r.boosted_price);
    return finish(r);
  }

  /* ---------- router ---------- */
  function lines(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function parseSlips(text) {
    var L = lines(text), t = L.join('\n'), out;
    if (!L.length) return [other('empty text')];
    if (/Bet Tracker|s-chuch\.github|Est\. leg|% to hit|Expand all|no result yet|UPCOMING|LIVE NOW|Settled recently/.test(t)) return [other('screenshot of the tracker itself, not a sportsbook slip')];
    if (/CAESARS|Cash Wagered|Same Game Parlay Placed/i.test(t)) out = parseCaesars(L, t);
    else if (/DEPOSIT MATCH|ESTIMATED RETURN|BET RECEIPTS|POINTSBET|PROFIT BOOST OFFER/i.test(t)) out = parsePointsBet(L, t);
    else if (/Bets Placed|\bDK\d{10,}|Wager Amount|Keep Picks/i.test(t)) out = parseDraftKings(L, t);
    else if (/TOTAL WAGER|TOTAL PAYOUT|Substituted players/i.test(t)) out = parseFanDuel(L, t);
    else if (/Bet Ref|To Return|Wager\s*Return|Live Alerts|SAME GAME PARLAY\s*[+#]\d/i.test(t)) out = parseBet365(L, t);
    else if (/BONUS BET|Bonus Bet/.test(t)) return [other('bonus-bet offer, not a bet slip')];
    else return [other('unrecognised sportsbook layout')];
    return out.map(function (r) { return r.kind === 'other' ? r : finish(r); });
  }
  function parseSlip(text) {
    var all = parseSlips(text), r = all[0];
    for (var i = 0; i < all.length; i++) if (all[i].legs && all[i].legs.length && all[i].stake != null) { r = all[i]; break; }
    if (all.length > 1 && r.kind !== 'other') r.warnings.push(all.length + ' bets in this screenshot; this is the first complete one (parseSlips returns all)');
    return r;
  }
  return { parseSlip: parseSlip, parseSlips: parseSlips };
});
