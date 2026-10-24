/* LiveUI: extension points for the ui-*.js modules (all optional). scoreBox(g) may return replacement HTML; afterRender(ctx) runs after every render() once the DOM is updated. */
window.LiveUI={scoreBox:null,crow:null,afterRender:[],tick:[]};
const ESPN="https://site.api.espn.com/apis/site/v2/sports/";
const TZ="America/Toronto";
let DATA=null, games={}, summaries={};
const $=id=>document.getElementById(id);
const money=v=>v==null?"?":"$"+Number(v).toFixed(2);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(Boolean);
function teamMatch(q,t){const qn=norm(q);if(!qn.length)return false;
  for(const f of [t.name,t.abbr,t.short,t.location,t.nick]){const fn=norm(f);if(fn.length&&fn.join(" ")===qn.join(" "))return true}
  const d=norm(t.name);return qn.every(w=>d.includes(w))&&(qn.length>1||qn[0].length>3)}
// ESPN carries a sportsbook's lines (DraftKings) on the scoreboard for almost every game, soccer and small leagues included
function pickOdds(od){const o=od&&od[0];if(!o)return null;const n=v=>{const x=parseFloat(String(v).replace(/[^\d.+-]/g,""));return isFinite(x)?x:null};
  const cl=x=>x&&(x.close||x.open),r={prov:(o.provider&&o.provider.displayName)||"Sportsbook"},ml=o.moneyline;
  if(ml){const h=n((cl(ml.home)||{}).odds),a=n((cl(ml.away)||{}).odds),d=n((cl(ml.draw)||{}).odds!=null?cl(ml.draw).odds:(o.drawOdds||{}).moneyLine);if(h!=null&&a!=null)r.ml={h,a,d}}
  const ps=o.pointSpread;if(ps){const h=cl(ps.home),a=cl(ps.away);if(h&&a&&n(h.line)!=null&&n(h.odds)!=null&&n(a.odds)!=null)r.sp={h:n(h.line),ho:n(h.odds),ao:n(a.odds)}}
  const t=o.total;if(t&&t.over&&t.under){const ov=cl(t.over),un=cl(t.under);if(ov&&un&&n(ov.line)!=null&&n(ov.odds)!=null&&n(un.odds)!=null)r.tot={line:n(ov.line),o:n(ov.odds),u:n(un.odds)}}
  return r.ml||r.sp||r.tot?r:null}
function fromEvent(ev){const c=ev.competitions?ev.competitions[0]:ev.header.competitions[0];const st=ev.status||c.status;
  return {id:ev.id,date:ev.date||c.date,period:st.period,clock:st.clock,outs:c.situation&&c.situation.outs,lastPlay:c.situation&&c.situation.lastPlay&&c.situation.lastPlay.text||"",longDetail:st.type.detail||"",state:st.type.state,completed:st.type.completed,detail:st.type.shortDetail,
    sit:pickSit(c.situation),teams:c.competitors.map(x=>({id:x.team.id||x.id,name:x.team.displayName,abbr:x.team.abbreviation,short:x.team.shortDisplayName,color:x.team.color||"",alt:x.team.alternateColor||"",location:x.team.location,nick:x.team.name,home:x.homeAway==="home",score:x.score&&typeof x.score==="object"?x.score.displayValue:x.score,ls:(x.linescores||[]).map(l=>l.displayValue!=null?l.displayValue:l.value),st:Object.fromEntries((x.statistics||[]).map(q=>[q.name,q.displayValue]))})),odds:pickOdds(c.odds)}}
// keep only the small, flat situation fields (+ batter/pitcher names) from the scoreboard
function pickSit(si){if(!si)return null;const o={};for(const[k,v]of Object.entries(si)){if(v==null||k==="lastPlay")continue;
    if(typeof v!=="object")o[k]=v;else if((k==="batter"||k==="pitcher")&&v.athlete)o[k]={n:v.athlete.shortName||v.athlete.displayName,s:v.summary||""};
    else if(/fouls|bonus/i.test(k))o[k]=v}return o}
const key=m=>m.path+"|"+m.date+"|"+(m.groups||"");
function gameFor(m){if(!m)return null;if(!games[m.id]&&m.snapshot)m.snapshot.id=m.id;return games[m.id]||m.snapshot}
function tfetch(u,o,ms){const ac=new AbortController(),t=setTimeout(()=>ac.abort(),ms||8000);return fetch(u,{...(o||{}),signal:ac.signal}).finally(()=>clearTimeout(t))}
async function getJSON(u){const r=await tfetch(u,{cache:"no-store"});if(!r.ok)throw new Error(r.status);return r.json()}
const CLK={}, RS={};
// ---- game state (running / paused / between periods) tracked across fetches ----
function pauseReason(t){t=String(t||"");
  if(/official timeout|tv timeout|media timeout|commercial/i.test(t))return"TV timeout";
  if(/two[- ]minute warning/i.test(t))return"Two-minute warning";
  let m=t.match(/timeout\s*#?\d*\s*by\s+([A-Z]{2,4})/i);if(m)return`Timeout ${m[1].toUpperCase()}`;
  if(/timeout/i.test(t))return"Timeout";
  if(/review|challenge/i.test(t))return"Review";
  if(/injur/i.test(t))return"Injury";
  if(/penalty/i.test(t))return"Penalty";
  m=t.match(/^(icing|offside|goal|puck out of play|hand pass|high stick|net off|stoppage|video review)/i);if(m)return m[1][0].toUpperCase()+m[1].slice(1).toLowerCase();
  return"Clock stopped"}
function breakLabel(path,d){if(/halftime/i.test(d))return"Halftime";const m=d.match(/end of (\d)(?:st|nd|rd|th)/i);
  if(!m)return null;if(path==="hockey/nhl")return"Intermission";return`End of Q${m[1]}`}
function observeRaw(path,old,nw,moving){
  if(nw.completed)return{kind:"final",label:"Final"};
  if(nw.state!=="in")return null;
  const d=nw.longDetail||nw.detail||"";
  if(path==="baseball/mlb"){
    if(/pitching change|now pitching|relieved|pitching:/i.test(nw.lastPlay||""))return{kind:"mlb",label:"Pitching change"};
    if(/^(mid|end)/i.test(nw.detail||""))return{kind:"mlb",label:"Between innings"};
    return{kind:"mlb",label:`${nw.detail}${typeof nw.outs==="number"?` · ${nw.outs} out`:""}`}}
  if(!CLOCK_SPORTS.has(path))return null;
  const br=breakLabel(path,d)||(/end of|intermission/i.test(nw.detail||"")?"Intermission":null);
  if(br)return{kind:"break",label:br};
  if(!old||old.state!=="in"||old.period!==nw.period)return null; // no comparison possible yet
  return moving?{kind:"run",label:"Running"}:{kind:"pause",label:"Paused",reason:pauseReason(nw.lastPlay)}}
function observe(id,path,old,nw,moving){const o=observeRaw(path,old,nw,moving);if(!o)return;
  const r=RS[id]||(RS[id]={conf:null,cand:null,n:0,candT:0,events:[]}),now=Date.now();
  const same=(a,b)=>a&&b&&a.kind===b.kind&&(a.kind!=="break"||a.label===b.label);
  if(r.conf&&same(o,r.conf)){r.conf.reason=o.reason;r.conf.label=o.label;r.cand=null;r.n=0;return}
  if(r.cand&&same(o,r.cand)){r.n++;r.cand.reason=o.reason}else{r.cand=o;r.n=1;r.candT=now}
  const need=(o.kind==="run"||o.kind==="pause")?2:1; // explicit ESPN states confirm at once; clock-based ones need 2 fetches
  if(r.n>=need){const prev=r.conf;r.conf={...r.cand};r.cand=null;r.n=0;
    if(prev&&o.kind!=="mlb"&&prev.kind!=="mlb"){const ev=o.kind==="run"?(prev.kind==="pause"?"resumed":"restarted"):o.kind==="pause"?"Paused"+(o.reason&&o.reason!=="Clock stopped"?` (${o.reason})`:""):o.label;
      r.events.push({txt:ev,t:r.candT});r.events=r.events.slice(-4)}}}
const tfmt=t=>new Date(t).toLocaleTimeString("en-US",{timeZone:TZ,hour:"numeric",minute:"2-digit"});
function stInfo(g){const r=g&&RS[g.id];if(!r||!r.conf||g.state!=="in")return null;const c=r.conf;
  if(c.kind==="run")return{cls:"run",icon:"▶",txt:"Running"};
  if(c.kind==="pause")return{cls:"pause",icon:"⏸",txt:`Paused · ${c.reason||"Clock stopped"}`};
  if(c.kind==="break")return{cls:"brk",icon:"◼",txt:c.label};
  if(c.kind==="mlb")return{cls:/change|between/i.test(c.label)?"brk":"mlb",icon:/change|between/i.test(c.label)?"◼":"⚾",txt:c.label};
  return null}
function stIcon(g){const i=stInfo(g);return i?`<i class="sti ${i.cls}" title="${esc(i.txt)}">${i.icon}</i>`:""}
function stBadge(g){const i=stInfo(g);if(!i)return"";const r=RS[g.id];
  const evs=(r.events||[]).slice(-2).map((e,k)=>`${k===0?e.txt[0].toUpperCase()+e.txt.slice(1):e.txt} ${tfmt(e.t)}`).join(" · ");
  return`<div class="stb ${i.cls}"><span class="dot"></span>${esc(i.txt)}</div>${evs?`<div class="stn">${esc(evs)}</div>`:""}`}
const PROB_PATHS=new Set(["football/nfl","football/college-football","baseball/mlb","basketball/nba","basketball/wnba","basketball/mens-college-basketball"]);
const probs={}, probCount={}, pregameLive={};
let espnErr=false;const FEED={site:null,core:null,csp:null};
document.addEventListener("securitypolicyviolation",e=>{try{FEED.csp=new URL(e.blockedURI).host||String(e.blockedURI)}catch(_){FEED.csp=String(e.blockedURI||"?")}});

function allMatches(){const ms=[];for(const b of DATA.open){if(b.match)ms.push(b.match);for(const L of b.legs)if(L.match)ms.push(L.match)}return ms}
const etDay=d=>new Date(d).toLocaleDateString("en-CA",{timeZone:TZ});
function isActive(m){const g=gameFor(m);if(!g||g.completed)return false;if(g.state==="in")return true;
  return g.date&&new Date(g.date).getTime()-Date.now()<20*60000}  // live, or starting within 20 min
async function espn(u){if(!/^https:\/\/(site\.api|sports\.core\.api)\.espn\.com\/[\w\/.,&=?%-]*$/.test(u)){FEED.site={bad:"blocked URL"};return null}const fk=/sports\.core\./.test(u)?"core":"site";try{const r=await tfetch(u,{cache:"no-store"});if(r.status===429){espnErr=true;FEED[fk]={bad:"rate limited (HTTP 429), backing off"};return null}   // the only case that slows the 10 s poll
  if(r.status>=500){FEED[fk]={bad:"HTTP "+r.status};return null}
  if(!r.ok){FEED[fk]={bad:"HTTP "+r.status};return null}const j=await r.json();FEED[fk]={ok:Date.now()};return j}catch(e){FEED[fk]={bad:"network/CORS"};return null}}
const corePath=m=>{const[sp,lg]=m.path.split("/");return`https://sports.core.api.espn.com/v2/sports/${sp}/leagues/${lg}/events/${m.id}/competitions/${m.id}`};
// full=true: every unfinished game (60s cycle); full=false: only live / about-to-start games (10s cycle)
async function refreshScores(full){
  const need={};for(const m of allMatches()){const g=gameFor(m);if(g&&g.completed&&!g.bfinal)continue;if(!full&&!isActive(m))continue;need[key(m)]=m}
  await Promise.all(Object.values(need).map(async m=>{
    const d=await espn(`${ESPN}${m.path}/scoreboard?dates=${m.date}`+(m.groups?`&groups=${m.groups}`:""));
    for(const ev of (d&&d.events)||[]){const old=games[ev.id],nw=fromEvent(ev);
      // ESPN's CDN sometimes serves an older copy: same period, clock higher, same score -> ignore it
      if(old&&old.state==="in"&&nw.state==="in"&&old.period===nw.period&&typeof old.clock==="number"&&typeof nw.clock==="number"&&nw.clock>old.clock+0.5&&
         old.teams.map(t=>t.score).join()===nw.teams.map(t=>t.score).join()&&CLOCK_SPORTS.has(m.path))continue;
      if(old&&old.state==="post"&&nw.state!=="post"&&!old.bfinal)continue;
      if(old&&old.backup&&!old.bfinal&&nw.state!=="post"&&advance(old,nw)>0)continue;   // a faster feed is ahead of ESPN: keep it until ESPN catches up
      games[ev.id]=nw;
      // local clock: only run it if the last two fetches showed the clock moving (football clocks stop a lot)
      const moving=!!(old&&old.state==="in"&&nw.state==="in"&&old.period===nw.period&&typeof nw.clock==="number"&&typeof old.clock==="number"&&nw.clock<old.clock&&nw.clock>0&&!/end|half|intermission|delay/i.test(nw.detail||""));
      CLK[ev.id]={clock:nw.clock,t:Date.now(),moving};observe(ev.id,m.path,old,nw,moving);
      const p=ev.competitions[0].situation&&ev.competitions[0].situation.lastPlay&&ev.competitions[0].situation.lastPlay.probability;
      if(p&&p.homeWinPercentage!=null)probs[ev.id]={home:p.homeWinPercentage,away:p.awayWinPercentage,t:Date.now(),src:"sb"}}}));
  const every=[...new Map(allMatches().map(m=>[m.id,m])).values()];   // need{} holds one match per league+day; the backups need every game
  await mlbBackup(every);
  await anBackup(every).catch(()=>{});
  await feedBackup(every).catch(()=>{});
  await sofaBackup(every).catch(()=>{});
  await sofaOdds(every).catch(()=>{});
  // player props need the box score (only in-progress SGPs with a prop leg)
  const sm={};for(const b of DATA.open)for(const L of b.legs){const m=b.match||L.match;if(m)sm[m.id]=m}   // box score + plays for every game on an open bet
  await Promise.all(Object.values(sm).map(async m=>{
    const g=gameFor(m);if(!g||g.state==="pre")return;const S=summaries[m.id];
    if(S&&S.done)return;if(S&&Date.now()-S.t<20000)return;   // live: box score at most every 20s
    const d=await espn(`${ESPN}${m.path}/summary?event=${m.id}`);if(!d||(!d.boxscore&&!d.plays&&!d.drives))return;
    const fin=(S&&S.fin||0)+(g.completed?1:0);summaries[m.id]={d,t:Date.now(),path:m.path,fin,done:fin>=3}}));
}
// How far along game a is compared with game b: >0 a is ahead, <0 behind, 0 same. Order: state, then total score (a score never goes down).
const STATE_RANK={pre:0,in:1,post:2};
const scoreSum=g=>(g&&g.teams||[]).reduce((n,t)=>n+(parseInt(t.score,10)||0),0);
function advance(a,b){const d=(STATE_RANK[a.state]||0)-(STATE_RANK[b.state]||0);if(d)return d;return scoreSum(a)-scoreSum(b)}
// Free backup score source: MLB's own StatsAPI. ESPN sometimes lists an MLB game as "Scheduled" for many minutes after the first pitch
// (or as in-progress after the last out); when MLB says the game is further along, advance the game state. ESPN stays the primary.
const MLB_API="https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore&date=";
const ordn=n=>n+(["th","st","nd","rd"][(n%100>10&&n%100<14)?0:Math.min(n%10,4)%4]||"th");
async function mlbBackup(ms){const list=ms.filter(m=>m.path==="baseball/mlb"),days=[...new Set(list.map(m=>m.date))];if(!list.length)return;
  for(const d of days){let j;try{const r=await tfetch(MLB_API+`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`,{cache:"no-store"});if(!r.ok)throw 0;j=await r.json();FEED.mlb={ok:Date.now()}}catch(e){FEED.mlb={bad:"network/CORS"};continue}
    const mg=[].concat(...(j.dates||[]).map(x=>x.games||[]));
    for(const m of list.filter(x=>x.date===d)){const g=gameFor(m);if(!g||g.completed)continue;
      const hit=mg.find(x=>{const a=x.teams.away.team.name,h=x.teams.home.team.name,t=g.teams;return t.some(y=>!y.home&&y.name===a)&&t.some(y=>y.home&&y.name===h)});if(!hit)continue;
      const st=hit.status.abstractGameState,ls=hit.linescore||{};
      const sc=g.teams.map(y=>{const o=y.home?ls.teams&&ls.teams.home:ls.teams&&ls.teams.away;return{...y,score:o&&o.runs!=null?String(o.runs):y.score}});
      if(st==="Final"&&g.state!=="post"&&hit.status.detailedState==="Final")games[m.id]={...g,state:"post",completed:true,detail:"Final",teams:sc};
      else if(st==="Live"&&g.state==="pre"&&ls.currentInning){const top=ls.inningHalf==="Top",half=ls.isTopInning===true||top?"Top":"Bot";
        games[m.id]={...g,state:"in",completed:false,period:ls.currentInning,outs:ls.outs,detail:`${half} ${ordn(ls.currentInning)}`,teams:sc};CLK[m.id]={clock:null,t:Date.now(),moving:false}}
      else if(st==="Live"&&g.state==="in"&&ls.currentInning&&(scoreSum({teams:sc})>scoreSum(g)||ls.currentInning>(g.period||0))){   // MLB's own feed is ahead of ESPN: take its score and inning
        const top=ls.inningHalf==="Top"||ls.isTopInning===true;games[m.id]={...g,period:ls.currentInning,outs:ls.outs,detail:`${top?"Top":"Bot"} ${ordn(ls.currentInning)} · via MLB`,teams:sc,backup:"MLB StatsAPI"}}}}}
// Backup game status when ESPN is slow to flip a game live: only games past their listed start that ESPN still calls "pre".
// ESPN stays primary (it takes over the moment it reports the game live) and the server never settles on a backup alone.
function lateGames(ms){return ms.filter(m=>{const g=gameFor(m);return g&&!g.completed&&g.state==="pre"&&g.date&&Date.now()>=Date.parse(g.date)-60000&&Date.now()-Date.parse(g.date)<4*3600e3})}
const nmEq=(a,b)=>{const x=norm(a).join(" "),y=norm(b).join(" ");return!!x&&!!y&&(x===y||x.endsWith(" "+y)||y.endsWith(" "+x))};
function teamHit(t,name,abbr){return(abbr&&t.abbr&&String(abbr).toUpperCase()===String(t.abbr).toUpperCase())||nmEq(name,t.name)||nmEq(name,t.location&&t.nick?t.location+" "+t.nick:"")}
function applyBackup(m,g,away,home,detail,src){
  const teams=g.teams.map(y=>({...y,score:String(y.home?home:away)}));
  games[m.id]={...g,state:"in",completed:false,detail:`${detail||"Live"} · via ${src}`,teams,backup:src};CLK[m.id]={clock:null,t:Date.now(),moving:false}}
// 1) Action Network public scoreboard (CORS allowed for this site): NBA, WNBA, NHL, NFL, college football, MLB, soccer
const AN_SB={nba:"basketball/nba",wnba:"basketball/wnba",nhl:"hockey/nhl",nfl:"football/nfl",ncaaf:"football/college-football",mlb:"baseball/mlb"},ANSB={};
async function anBackup(ms){const late=lateGames(ms);if(!late.length)return;
  for(const m of late){const lg=Object.keys(AN_SB).find(k=>AN_SB[k]===m.path)||(SOCCER(m.path)?"soccer":null);if(!lg)continue;
    const key=lg+m.date;let c=ANSB[key];
    if(!c||Date.now()-c.t>12000){try{const r=await tfetch(`https://api.actionnetwork.com/web/v2/scoreboard/${lg}?date=${m.date}`,{cache:"no-store"});if(!r.ok)throw 0;c=ANSB[key]={t:Date.now(),g:(await r.json()).games||[]};FEED.anb={ok:Date.now()}}catch(e){FEED.anb={bad:"network/CORS"};continue}}
    const g=gameFor(m);if(!g||g.state!=="pre")continue;const H=g.teams.find(t=>t.home),A=g.teams.find(t=>!t.home);if(!H||!A)continue;
    const hit=c.g.find(x=>{if(Math.abs(Date.parse(x.start_time)-Date.parse(g.date))>3*3600e3)return false;const tm=id=>(x.teams||[]).find(t=>t.id===id)||{};
      const h=tm(x.home_team_id),a=tm(x.away_team_id);return teamHit(H,h.full_name,h.abbr)&&teamHit(A,a.full_name,a.abbr)});
    if(hit&&hit.status==="inprogress"&&hit.boxscore){const b=hit.boxscore;applyBackup(m,g,b.total_away_points!=null?b.total_away_points:"–",b.total_home_points!=null?b.total_home_points:"–",hit.status_display,"Action Network")}}}
// 2) Official league feeds that block browser requests (NHL api-web.nhle.com): fetched by the GitHub live loop into live_status.json
//    on the live-feed branch (scripts/live_status.py), read here through the contents API only while a game is late.
const LS_URL="https://api.github.com/repos/s-chuch/bet-dashboard/contents/live_status.json?ref=live-feed";let LS={t:0,games:{}},LS_AT=0;
async function feedBackup(ms){const cand=ms.filter(m=>{const g=gameFor(m);if(!g||(g.completed&&!g.bfinal)||g.bfinal)return false;
    if(g.state==="in")return true;return g.state==="pre"&&g.date&&Date.now()>=Date.parse(g.date)-60000&&Date.now()-Date.parse(g.date)<4*3600e3});if(!cand.length)return;
  let tok="";try{tok=localStorage.getItem("bt.gh.settle")||""}catch(e){}
  if(tok==="supabase_session_no_github_token")tok="";
  if(Date.now()-LS_AT>(tok?15000:70000)){LS_AT=Date.now();
    try{const r=await tfetch(LS_URL,{cache:"no-store",headers:{Accept:"application/vnd.github.raw",...(tok?{Authorization:"Bearer "+tok}:{})}});if(!r.ok)throw 0;const j=await r.json();LS={t:Date.parse(j.t)||0,games:j.games||{}};FEED.lsf={ok:Date.now()}}catch(e){FEED.lsf={bad:"no live feed yet"}}}
  if(!LS.t||Date.now()-LS.t>180000)return;
  for(const m of cand){const x=LS.games[m.id],g=gameFor(m);if(!x||!g)continue;
    const away=Number(x.away),home=Number(x.home),src=x.src||"league feed";
    if(x.state==="post"&&g.state!=="post"&&isFinite(away)&&isFinite(home)){   // display only: the server still waits for ESPN's final before settling
      games[m.id]={...g,state:"post",completed:true,bfinal:true,backup:src,detail:`Final · settling (via ${src})`,teams:g.teams.map(y=>({...y,score:String(y.home?home:away)}))};continue}
    if(x.state!=="in")continue;
    if(g.state==="pre")applyBackup(m,g,x.away,x.home,x.detail,src);
    else if(g.state==="in"&&isFinite(away)&&isFinite(home)&&away+home>scoreSum(g))   // the league feed already has a newer score than ESPN
      games[m.id]={...g,teams:g.teams.map(y=>({...y,score:String(y.home?home:away)})),detail:`${x.detail||g.detail} · via ${src}`,backup:src}}}
// Free backup for soccer: SofaScore's public live feed covers leagues ESPN never updates (FA Cup qualifying, lower divisions, ...).
// Unofficial API, so it is only used when ESPN still says "not started" after kickoff, and ESPN takes over as soon as it reports the game live.
const SOFA="https://api.sofascore.com/api/v1/";const SOFA_ID={};let SOFA_LIVE={t:0,ev:[]},SOFA_FIN={};
const sofaToks=n=>norm(n).filter(w=>!["fc","afc","cf","sc","ac","the"].includes(w));
const sameToks=(a,b)=>a.length&&a.length===b.length&&a.every(x=>b.includes(x));
const subToks=(a,b)=>a.length&&b.length&&(a.every(x=>b.includes(x))||b.every(x=>a.includes(x)));
function sofaSide(name,t,exact){const q=sofaToks(name);return[t.name,t.short,t.location,t.nick&&t.location?t.location+" "+t.nick:""].filter(Boolean).some(v=>exact?sameToks(q,sofaToks(v)):subToks(q,sofaToks(v)))}
function sofaPair(e,g,exact){const[a,b]=g.teams;const h=e.homeTeam.name,w=e.awayTeam.name;
  return(sofaSide(h,a,exact)&&sofaSide(w,b,exact))||(sofaSide(h,b,exact)&&sofaSide(w,a,exact))}
function sofaApply(m,g,e,fin){const sc=(side)=>{const o=e[side+"Score"]||{};const v=fin&&o.normaltime!=null?o.normaltime:o.current;return v==null?null:String(v)};
  const teams=g.teams.map(t=>{const hm=sofaSide(e.homeTeam.name,t,true)||(!sofaSide(e.awayTeam.name,t,false)&&sofaSide(e.homeTeam.name,t,false));const v=sc(hm?"home":"away");return{...t,score:v==null?t.score:v}});
  const code=(e.status||{}).code,t0=(e.time||{}).currentPeriodStartTimestamp,ini=(e.time||{}).initial||0;
  if(fin)return{...g,state:"post",completed:true,detail:"FT",teams};
  const per=code===6||code===41?1:code===7||code===42?2:code===31?1:2;
  let clock=null,detail=String((e.status||{}).description||"Live");
  if(code===31||/half ?time/i.test(detail))detail="HT";
  else if(t0){const el=Math.max(0,Math.floor(Date.now()/1000)-t0)+ini;clock=el;detail=`${Math.floor(el/60)+1}'`}
  return{...g,state:"in",completed:false,period:per,clock,detail,teams}}
async function sofaDiscover(m,g){if(SOFA_ID[m.id]||SOFA_DISC[m.id])return SOFA_ID[m.id];SOFA_DISC[m.id]=1;const[A,H]=g.teams;
  try{const r=await tfetch(SOFA+"search/events?page=0&q="+encodeURIComponent(`${H.short||H.name} ${A.short||A.name}`));if(!r.ok)return null;const d=await r.json();
    for(const x of d.results||[]){const e=x.entity;if(!e||!e.homeTeam||!e.awayTeam||Math.abs(e.startTimestamp*1000-Date.parse(g.date))>6*3600e3)continue;
      if(sofaPair(e,g,true)||sofaPair(e,g,false)){SOFA_ID[m.id]=e.id;SOFA_NAMES[id_(e)]={home:e.homeTeam.name,away:e.awayTeam.name};return e.id}}}catch(e){}return null}
const id_=e=>e.id;
async function sofaBackup(ms){const list=ms.filter(m=>SOCCER(m.path));if(!list.length)return;
  const cand=list.filter(m=>{const g=gameFor(m);return g&&!g.completed&&g.state==="pre"&&g.date&&Date.parse(g.date)-Date.now()<-30000||games[m.id]&&games[m.id].sofa});
  if(!cand.length)return;
  if(Date.now()-SOFA_LIVE.t>12000){try{const r=await tfetch(SOFA+"sport/football/events/live",{cache:"no-store"});if(!r.ok)throw 0;SOFA_LIVE={t:Date.now(),ev:(await r.json()).events||[]};FEED.sofa={ok:Date.now()}}catch(e){FEED.sofa={bad:"network/CORS"};return}}
  for(const m of cand){const g=gameFor(m);if(!g||g.completed)continue;
    if(g.state==="in"&&!g.sofa)continue;   // ESPN reports it live: ESPN wins
    let e=SOFA_ID[m.id]&&SOFA_LIVE.ev.find(x=>x.id===SOFA_ID[m.id]);
    if(!e){const hits=SOFA_LIVE.ev.filter(x=>sofaPair(x,g,true));const loose=hits.length?hits:SOFA_LIVE.ev.filter(x=>sofaPair(x,g,false));if(loose.length===1)e=loose[0]}
    if(e){SOFA_ID[m.id]=e.id;games[m.id]={...sofaApply(m,g,e,false),sofa:true};continue}
    const id=SOFA_ID[m.id]||await sofaDiscover(m,g);   // not in the live list: ask for the final (finds the event by search if this page never saw it live)
    if(id&&(!SOFA_FIN[id]||Date.now()-SOFA_FIN[id]>30000)){SOFA_FIN[id]=Date.now();
      try{const r=await tfetch(SOFA+"event/"+id,{cache:"no-store"});if(r.ok){const ev=(await r.json()).event;if(ev&&ev.status&&ev.status.type==="finished")games[m.id]={...sofaApply(m,g,ev,true),sofa:true}}}catch(x){}}}}
// SofaScore bookmaker odds (1X2, in-play too) for soccer moneyline / draw legs: covers games with no ESPN line or Polymarket market
const SOFA_ODDS={},SOFA_NAMES={},SOFA_DISC={},SOFA_OAT={};
const fracDec=f=>{const m=String(f||"").match(/^(\d+)\/(\d+)$/);return m?1+ +m[1]/+m[2]:null};
async function sofaOdds(ms){const want=ms.filter(m=>SOCCER(m.path)&&DATA.open.some(b=>b.legs.some(L=>(L.type==="ml"||L.type==="draw")&&matchOfLeg(b,L)&&matchOfLeg(b,L).id===m.id)));
  for(const m of want){const g=gameFor(m);if(!g||g.completed)continue;const live=g.state==="in";if(!live&&Date.parse(g.date)-Date.now()>3*3600e3)continue;
    let id=SOFA_ID[m.id];
    if(!id)id=await sofaDiscover(m,g);
    if(!id)continue;
    if(Date.now()-(SOFA_OAT[id]||0)<(live?14000:55000))continue;SOFA_OAT[id]=Date.now();
    try{const r=await tfetch(SOFA+`event/${id}/odds/1/featured`,{cache:"no-store"});if(!r.ok)throw 0;const j=await r.json(),mk=j.featured&&(j.featured.fullTime||j.featured.default);
      if(!mk||mk.suspended||!mk.choices)continue;const dec={};for(const c of mk.choices)dec[c.name]=fracDec(c.fractionalValue);
      if(!dec["1"]||!dec["X"]||!dec["2"])continue;const ip3=[1,"X",2].map(k=>1/dec[k]),tot=ip3[0]+ip3[1]+ip3[2];
      SOFA_ODDS[id]={h:ip3[0]/tot,d:ip3[1]/tot,a:ip3[2]/tot,t:Date.now(),live:!!mk.isLive};FEED.sofa=FEED.sofa&&FEED.sofa.bad?FEED.sofa:{ok:Date.now()}}catch(e){}}}
function sofaBar(L,m,g,ctx){if(!m||!g||g.completed||!SOCCER(m.path)||(L.type!=="ml"&&L.type!=="draw"))return"";const id=SOFA_ID[m.id],o=id&&SOFA_ODDS[id],nm=id&&SOFA_NAMES[id];
  if(!o||Date.now()-o.t>180000)return"";let v,what;
  if(L.type==="draw"){v=o.d;what="Draw"}
  else{const pt=pickTeam(g,L);if(!pt)return"";let home=null;if(nm)home=sofaSide(nm.home,pt.T,false)&&!sofaSide(nm.away,pt.T,true);
    if(home==null){const e=SOFA_LIVE.ev.find(x=>x.id===id);if(e)home=sofaSide(e.homeTeam.name,pt.T,false)}
    if(home==null)return"";v=home?o.h:o.a;what=`${esc(pt.T.abbr)} win (not draw)`}
  const age=Math.round((Date.now()-o.t)/1000);
  return bar(`SofaScore odds${ctx||""} · ${what}`,v*100,"sfb",`Bookmaker odds via SofaScore, vig removed · ${o.live?"live":"pregame"} · ${age} s old`)}
// ---- pregame player props: season per-game rate from ESPN's core API (free, same host we already use) -> chance the line is reached ----
const PSTAT={},PSTAT_TRY={};
const SP_PATH={"hockey/nhl":["hockey","nhl"],"basketball/nba":["basketball","nba"],"basketball/wnba":["basketball","wnba"],"football/nfl":["football","nfl"],"baseball/mlb":["baseball","mlb"]};
function seasonYear(path,iso){const d=new Date(iso),y=d.getUTCFullYear(),mo=d.getUTCMonth()+1;
  if(/^soccer/.test(path))return mo>=7?y:y-1;
  if(path==="hockey/nhl"||path==="basketball/nba")return mo>=8?y+1:y;if(path==="football/nfl")return mo<=2?y-1:y;return y}
const SOC_DOM=["eng.1","esp.1","ger.1","ita.1","fra.1","ned.1","por.1","tur.1","sco.1","bel.1"];
async function fetchPStat(L,m,g){const k=m.path+"|"+L.pid;if(PSTAT[k]||PSTAT_TRY[k])return;PSTAT_TRY[k]=1;if(!L.pid||!/^\d+$/.test(String(L.pid)))return;
  if(SOCCER(m.path)){const y=seasonYear(m.path,g.date),lgs=[...new Set([m.path.split("/")[1],...SOC_DOM])];let best=null;
    for(let i=0;i<lgs.length&&!(best&&best.gp>=4);i+=3)   // 3 leagues at a time, stop once a league shows a regular starter
    await Promise.all(lgs.slice(i,i+3).map(async lg=>{const d=await espn(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${lg}/seasons/${y}/types/1/athletes/${L.pid}/statistics`);
      if(!d||!d.splits)return;const flat={};for(const c of d.splits.categories||[])for(const st of c.stats||[])if(flat[st.name]==null&&st.value!=null)flat[st.name]=st.value;
      const ap=flat.appearances;if(ap>=2&&(!best||ap>best.gp))best={flat,gp:ap,y,prev:false}}));
    if(best)PSTAT[k]=best;return}
  const sp=SP_PATH[m.path];if(!sp)return;
  const y0=seasonYear(m.path,g.date);
  for(const y of [y0,y0-1]){const d=await espn(`https://sports.core.api.espn.com/v2/sports/${sp[0]}/leagues/${sp[1]}/seasons/${y}/types/2/athletes/${L.pid}/statistics`);
    if(!d||!d.splits)continue;const flat={};for(const c of d.splits.categories||[])for(const st of c.stats||[])if(flat[st.name]==null&&st.value!=null)flat[st.name]=st.value;
    const gp=flat.gamesPlayed!=null?flat.gamesPlayed:flat.games;if(gp>=(y===y0?4:1)){PSTAT[k]={flat,gp,y,prev:y!==y0};return}}}
function propMean(stat,path,P){const f=P.flat,gp=P.gp,pg=(...ks)=>{for(const x of ks){if(f[x[0]]!=null)return x[1]?f[x[0]]:f[x[0]]/gp}return null};
  const A=(n)=>f[n]!=null?f[n]/gp:null;
  if(path==="hockey/nhl"){if(stat==="sog")return f.avgShots!=null?f.avgShots:A("shotsTotal");if(stat==="goals")return A("goals");if(stat==="assists")return A("assists");
    if(stat==="pts")return f.goals!=null&&f.assists!=null?(f.goals+f.assists)/gp:null;if(stat==="hits")return A("hits");if(stat==="saves")return f.avgSaves!=null?f.avgSaves:A("saves");return null}
  if(/^basketball/.test(path)&&/^(pra|pr|pa|ra|stocks|stl|blk)$/.test(stat)){const P={pts:f.avgPoints!=null?f.avgPoints:A("points"),reb:f.avgRebounds!=null?f.avgRebounds:A("rebounds"),ast:f.avgAssists!=null?f.avgAssists:A("assists"),stl:f.avgSteals!=null?f.avgSteals:A("steals"),blk:f.avgBlocks!=null?f.avgBlocks:A("blocks")};
    const parts={pra:["pts","reb","ast"],pr:["pts","reb"],pa:["pts","ast"],ra:["reb","ast"],stocks:["stl","blk"],stl:["stl"],blk:["blk"]}[stat];if(parts.some(k=>P[k]==null))return null;return parts.reduce((t,k)=>t+P[k],0)}
  if(/^basketball/.test(path)){if(stat==="pts")return f.avgPoints!=null?f.avgPoints:A("points");if(stat==="reb")return f.avgRebounds!=null?f.avgRebounds:A("rebounds");
    if(stat==="assists")return f.avgAssists!=null?f.avgAssists:A("assists");if(stat==="threes")return f.avgThreePointFieldGoalsMade!=null?f.avgThreePointFieldGoalsMade:A("threePointFieldGoalsMade");return null}
  if(path==="football/nfl"){if(stat==="passYds")return f.netPassingYardsPerGame!=null?f.netPassingYardsPerGame:A("passingYards");if(stat==="rushYds")return f.rushingYardsPerGame!=null?f.rushingYardsPerGame:A("rushingYards");
    if(stat==="recYds")return f.receivingYardsPerGame!=null?f.receivingYardsPerGame:A("receivingYards");if(stat==="receptions")return A("receptions");if(stat==="passTD")return A("passingTouchdowns");
    if(stat==="rushRecYds"){const a=f.rushingYardsPerGame!=null?f.rushingYardsPerGame:A("rushingYards"),b=f.receivingYardsPerGame!=null?f.receivingYardsPerGame:A("receivingYards");return a==null&&b==null?null:(a||0)+(b||0)}
    if(stat==="td"){const t=(f.rushingTouchdowns||0)+(f.receivingTouchdowns||0);return f.rushingTouchdowns==null&&f.receivingTouchdowns==null?null:t/gp}return null}
  if(/^soccer/.test(path)){const a=n=>f[n]!=null?f[n]/gp:null;if(stat==="sot")return a("shotsOnTarget");if(stat==="shots")return a("totalShots");if(stat==="goals"||stat==="goal")return a("totalGoals");
    if(stat==="assists")return a("goalAssists");if(stat==="goalOrAssist"){const x=a("totalGoals"),y=a("goalAssists");return x==null&&y==null?null:(x||0)+(y||0)}return null}
  if(path==="baseball/mlb"){if(stat==="hits")return A("hits");if(stat==="tb")return A("totalBases");if(stat==="hr")return A("homeRuns");if(stat==="rbi")return A("RBIs");if(stat==="runs")return A("runs");return null}
  return null}
// chance this prop leg is reached from the season rate alone (null when unknown)
function propPre(L,m){if(L.type!=="prop"||!L.pid||!L.stat||!m)return null;const P=PSTAT[m.path+"|"+L.pid];if(!P)return null;const mu=propMean(L.stat,m.path,P);if(mu==null||!(mu>=0))return null;
  const under=L.op==="under",tgt=under?Math.floor(L.line)+1:(L.op==="over"?Math.floor(L.line)+1:L.min);if(tgt==null||!isFinite(tgt))return null;
  const cont=/Yds$/.test(L.stat)||(/^basketball/.test(m.path)&&L.stat==="pts")||(m.path==="hockey/nhl"&&L.stat==="saves");
  let p;if(!cont&&mu<4)p=poisGE(Math.max(mu,0.02),tgt);else{const sd=/Yds$/.test(L.stat)?0.55*mu+5:L.stat==="pts"?0.32*mu+1.2:L.stat==="saves"?0.22*mu+2:1.15*Math.sqrt(mu)+0.3;p=1-Phi((tgt-0.5-mu)/sd)}
  return Math.max(0.005,Math.min(0.995,under?1-p:p))}
async function refreshPropStats(){const jobs=[];for(const b of DATA.open)for(const L of b.legs){if(L.type!=="prop"||!L.pid)continue;const m=matchOfLeg(b,L),g=gameFor(m);if(!m||!g||g.completed||!(SP_PATH[m.path]||SOCCER(m.path)))continue;jobs.push(fetchPStat(L,m,g))}
  await Promise.all(jobs)}
// live win probability: tiny ESPN core API pages (latest play's probability), only for in-progress games in covered sports
async function refreshProbs(){
  const ids={};for(const b of DATA.open){const m=probMatch(b);if(m)ids[m.id]=m}
  await Promise.all(Object.values(ids).map(async m=>{const g=gameFor(m);
    if(!g||g.state!=="in"||!PROB_PATHS.has(m.path))return;
    if(probs[m.id]&&probs[m.id].src==="sb"&&Date.now()-probs[m.id].t<15000)return; // scoreboard already gave a fresh one
    let page=probCount[m.id]||1;
    let d=await espn(`${corePath(m)}/probabilities?limit=1&page=${page}`);if(!d||d.error)return;
    if(d.count&&d.count!==page){probCount[m.id]=d.count;d=await espn(`${corePath(m)}/probabilities?limit=1&page=${d.count}`);if(!d||d.error)return}
    const it=d.items&&d.items[0];if(it&&it.homeWinPercentage!=null)probs[m.id]={home:it.homeWinPercentage,away:it.awayWinPercentage,t:Date.now(),src:"core"}}));
}
// pregame predictor: refetch only for games starting later today (data.json carries a snapshot for the rest)
async function refreshPregame(){
  const today=etDay(Date.now()),ids={};for(const b of DATA.open){const m=probMatch(b);if(m)ids[m.id]=m}
  await Promise.all(Object.values(ids).map(async m=>{const g=gameFor(m);
    if(!g||g.state!=="pre"||!PROB_PATHS.has(m.path)||etDay(g.date)!==today)return;
    const d=await espn(`${corePath(m)}/predictor`);if(!d||d.error)return;
    const gp=s=>((d[s]||{}).statistics||[]).find(x=>x.name==="gameProjection");const h=gp("homeTeam"),a=gp("awayTeam");
    if(h&&a)pregameLive[m.id]={home:h.value,away:a.value}}));
}
// which game + team a bar can honestly describe
function probTarget(b){
  if(b.multi){if(!b.match)return null;const t=b.legs.filter(L=>L.team&&L.type!=="teamtotal");return t.length===1?{m:b.match,leg:t[0]}:null}
  const L=b.legs[0];if(!L||!L.team||L.type==="teamtotal")return null;return{m:b.match||L.match,leg:L}}
function probMatch(b){const t=probTarget(b);return t&&t.m}
function probFor(b){const t=probTarget(b);if(!t||!t.m)return null;const g=gameFor(t.m);if(!g||g.completed)return null;
  const i=sideIdx(g,t.leg.team);if(i<0)return null;const home=g.teams[i].home,name=g.teams[i].abbr||g.teams[i].name;
  const ml=t.leg.type==="ml"&&!b.multi;
  const lp=g.state==="in"&&probs[t.m.id];
  if(lp){const v=home?lp.home:(lp.away!=null?lp.away:1-lp.home);return{pct:v*100,kind:"live",label:ml?`${name} live win chance`:`${name} team win chance (live)`,ml}}
  const pg=pregameLive[t.m.id]||t.m.pregame;
  if(pg){return{pct:home?pg.home:pg.away,kind:"pregame",label:ml?`${name} win chance · Pregame`:`${name} team win chance · Pregame`,ml}}
  return null}
function wpBar(b){const p=probFor(b);if(!p)return"";const v=Math.max(0,Math.min(100,p.pct));
  const col=v>50?"var(--win)":v<50?"var(--lose)":"var(--push)";
  const note=!p.ml?(b.multi?"Game-win chance for that team only, not the parlay's chance":"Chance to win the game, not to cover"):(p.kind==="pregame"?"ESPN pregame predictor":"ESPN live win probability");
  return`<div class="wp"><div class="lbl"><span>${esc(p.label)}</span><b>${v.toFixed(1)}%</b></div><div class="track"><div class="fill" style="width:${v}%;background:${col}"></div></div><div class="note">${note}</div></div>`}
function sideIdx(g,team){let i=g.teams.findIndex(t=>teamMatch(team,t));if(i<0&&team){const c=String(team).replace(/\([^)]*\)/g," ").replace(/\b(ML|moneyline)\b/ig," ").trim();if(c&&c!==team)i=g.teams.findIndex(t=>teamMatch(c,t))}return i}
function legStatus(L,g,sport,matchId){
  if(!g)return{s:"NO GAME",n:"Live score not found"};
  if(g.state==="pre")return{s:"NOT STARTED",n:""};
  if(g.state==="post"&&!g.completed)return{s:"NOT STARTED",n:g.detail||"postponed"};
  const fin=g.completed, sc=g.teams.map(t=>Number(t.score||0)), W=fin?"WON":"WINNING", Lo=fin?"LOST":"LOSING";
  if(L.type==="draw")return sc[0]===sc[1]?{s:W,n:`level ${sc[0]}–${sc[1]}`}:{s:Lo,n:`${sc[0]}–${sc[1]}, needs an equaliser`};
  if(L.type==="btts"){const both=sc[0]>0&&sc[1]>0;if(L.yes)return both?{s:"WON",n:`${sc[0]}–${sc[1]}, both scored`}:{s:Lo,n:`${sc[0]}–${sc[1]}, needs ${sc[0]===0&&sc[1]===0?"both teams":"the other team"} to score`};
    return both?{s:"LOST",n:`${sc[0]}–${sc[1]}, both scored`}:{s:W,n:`${sc[0]}–${sc[1]}`}}
  if(L.type==="ml"||L.type==="spread"){const i=sideIdx(g,L.team);if(i<0)return{s:"?",n:"team not matched"};
    const m=sc[i]-sc[1-i]+(L.type==="spread"?L.line:0);
    if(m>0)return{s:W,n:L.type==="spread"?`covering by ${m}`:""};
    if(m<0)return{s:Lo,n:L.type==="spread"?`short by ${-m}`:""};
    if(L.type==="ml"&&sport==="Soccer")return{s:Lo,n:"draw loses a 3-way ML"};
    return{s:fin?"PUSH":(L.type==="ml"?"TIED":"PUSH"),n:""}}
  if(L.type==="total"){const t=sc[0]+sc[1],d=t-L.line;
    if(d===0)return{s:"PUSH",n:`total ${t}`,pv:t};
    const over=L.side==="over";
    if(over&&d>0)return{s:"WON",n:`total ${t}, already over`,pv:t};
    if(!over&&d>0)return{s:"LOST",n:`total ${t}, already over`,pv:t};
    return{s:over?Lo:W,n:`total ${t}, ${(-d).toFixed(1)} under the line`,pv:t}}
  if(L.type==="prop")return propStatus(L,g,matchId);
  if(L.type==="teamtotal")return teamTotalStatus(L,g,sport);
  if(L.type==="unknown"&&sport==="Soccer"&&matchId)return soccerStat(L,g,matchId);
  if(L.type==="unknown"){const f=oddLeg(L,g,sport,matchId);if(f)return f}
  return{s:"?",n:L.note||(/outright|to win .*(cup|championship|title|league|finals?)|runner.?up|mvp|relegat|promot|each way|\b20\d\d[\/-]\d\d\b/i.test(L.text||"")?"season-long market, settles when it closes":/strikes|takedown|submission|round|method/i.test(L.text||"")?"fight stats aren't in the live feed, settle by hand":"not tracked live, settle by hand")}}
// markets without a stat parser: first-inning runs (MLB) and the first touchdown of an NFL game
function oddLeg(L,g,sport,matchId){const t=String(L.text||"");
  let m=t.match(/\b(under|over|u|o)\s*(\d+(?:\.\d+)?)\s+(?:1st|first)\s+inning\s+runs?/i);
  if(m&&sport==="MLB"){const over=/^o/i.test(m[1]),line=Number(m[2]),aw=g.teams.find(x=>!x.home),ho=g.teams.find(x=>x.home);
    const r=x=>x&&x.ls&&x.ls[0]!=null&&x.ls[0]!==""?Number(x.ls[0]):null,a=r(aw),h=r(ho),done=a!=null&&h!=null&&(g.period>1||g.completed),sum=(a||0)+(h||0);
    const n=`1st inning: ${a==null?"–":a} / ${h==null?"–":h} runs`;
    if(over){if(sum>line)return{s:"WON",n};return done?{s:"LOST",n}:{s:"LIVE",n}}
    if(sum>line)return{s:"LOST",n};return done?{s:"WON",n}:{s:"LIVE",n:n+" · on track"}}
  if(/\b(1st|first)\s+(td|touchdown)\s+(in|of)\s+(the\s+)?(1st|first)\s+(quarter|qtr)\b/i.test(t)&&sport==="NFL"){
    const S=matchId&&summaries[matchId];if(!S)return{s:"LIVE",n:"loading plays…"};
    const tds=(S.d.scoringPlays||[]).filter(p=>(p.type&&p.type.abbreviation==="TD")||/touchdown/i.test((p.type&&p.type.text)||""));
    const q=p=>p.period&&p.period.number;if(tds.length){const first=q(tds[0]);return first===1?{s:"WON",n:"first TD came in the 1st quarter"}:{s:"LOST",n:`first TD came in quarter ${first}`}}
    if(g.completed||g.period>1)return{s:"LOST",n:"no TD in the 1st quarter"};return{s:"LIVE",n:"no TD yet in the 1st quarter"}}
  return null}
// soccer match-stat totals ("Over 20.5 match shots", "Over 5.5 shots on target", "Over 23.5 free kicks"): graded from ESPN's team box score, both teams added
function soccerStat(L,g,matchId){
  const t=String(L.text||""),mm=t.match(/\b(over|under|o|u)\s*(\d+(?:\.\d+)?)/i);if(!mm)return{s:"?",n:"can't compute"};
  const over=/^o/i.test(mm[1]),line=Number(mm[2]);
  let key,unit,approx=false;
  if(/shots? on (target|goal)|\bsot\b/i.test(t)){key=["shotsOnTarget"];unit="shots on target"}
  else if(/(match|total)\s+shots?|\bshots?\b/i.test(t)){key=["totalShots"];unit="shots"}
  else if(/free kicks?|fouls?/i.test(t)){key=["foulsCommitted"];unit="free kicks (fouls)";approx=true}
  else if(/corners?/i.test(t)){key=["wonCorners"];unit="corners"}
  else return{s:"?",n:"can't compute"};
  const S=summaries[matchId];if(!S)return{s:"LIVE",n:"loading box score…"};
  const tm=(S.d.boxscore&&S.d.boxscore.teams)||[];if(!tm.length)return{s:"LIVE",n:"loading box score…"};
  let v=0,found=false;for(const x of tm)for(const st of x.statistics||[])if(st.name===key[0]){v+=Number(st.value!=null?st.value:st.displayValue)||0;found=true}
  if(!found)return{s:"LIVE",n:"stat not in feed yet"};
  const fin=g.completed,tgt=over?Math.floor(line)+1:line,base={pv:v,pt:tgt,unit};
  const n=`${v}/${tgt} ${unit}${approx?" (approx.)":""}`;
  if(over){if(v>line)return approx&&fin?{s:"?",n:n+" — free kicks aren't in the feed exactly, settle by hand"}:{...base,s:"WON",n};
    if(fin)return approx?{s:"?",n:n+" — free kicks aren't in the feed exactly, settle by hand"}:{...base,s:"LOST",n};
    return{...base,s:"LIVE",n:n+` · needs ${tgt-v} more`}}
  if(v>line)return{...base,s:"LOST",n};
  return{...base,s:fin?"WON":"LIVE",n:fin?n:n+" · on track"}}
// team totals ("Valkyries O78.5 team pts"): graded from that team's own score
const ttUnit=(L,sport)=>({NHL:"goals",MLB:"runs",Soccer:"goals"}[sport]||"pts");
const ttName=(L,g)=>{const i=g?sideIdx(g,L.team):-1;return i<0?L.team:(g.teams[i].nick||g.teams[i].short||g.teams[i].name)};
function teamTotalStatus(L,g,sport){const i=sideIdx(g,L.team);if(i<0)return{s:"?",lbl:"?",n:"team not matched"};
  const v=Number(g.teams[i].score||0),fin=g.completed,u=ttUnit(L,sport),nm=ttName(L,g),ln=L.line;
  const HIT={s:"WON",lbl:"HIT",pv:v},MISS={s:"LOST",lbl:"MISSED",pv:v},LV={s:"LIVE",lbl:"LIVE",pv:v};
  if(v===ln)return fin?{s:"PUSH",lbl:"PUSH",n:`${nm} ${v} ${u} (line ${ln})`}:{...LV,n:`${nm} ${v} ${u} · at the line${L.side==="under"?" (push if it ends here)":", needs 1 more"}`};
  if(L.side==="under"){const n=`${nm} ${v} ${u} (needs under ${ln})`;
    if(v>ln)return{...MISS,n};const sp=Math.ceil(ln)-1-v;return{...(fin?HIT:LV),n:fin?n:`${n} · ${sp} to spare`}}
  const tgt=Math.floor(ln)+1,n=`${nm} ${v}/${tgt} ${u}`;
  if(v>ln)return{...HIT,n};return{...(fin?MISS:LV),n:fin?n:`${n} · needs ${tgt-v} more`}}
// ---------- player props, graded from the ESPN game summary (box score, rosters, plays, scoring plays) ----------
const SFX=new Set(["jr","sr","ii","iii","iv","v"]);
const nameW=s=>norm(s).filter(x=>!SFX.has(x));
function playerMatch(bet,full){const b=nameW(bet),w=nameW(full);if(!b.length||!w.length)return false;const last=b[b.length-1],fi=b.length>1?b[0][0]:null;
  if(b.length===1&&w[0]===last)return true;   // one-word names a book prints ("Allan"): the first name counts
  if(w[w.length-1]!==last&&!w.slice(1).includes(last))return false;return!fi||w[0][0]===fi}
function athletesOf(S){if(S._ath)return S._ath;const d=S.d,by={},list=[];
  const get=(id,name,team)=>{const k=id?"i"+id:name+"|"+team;if(!by[k]){by[k]={id,name,team,s:{},inBox:false};list.push(by[k])}return by[k]};
  for(const tm of (d.boxscore||{}).players||[]){const ta=tm.team&&tm.team.abbreviation;
    for(const cat of tm.statistics||[]){const pre=(cat.type||cat.name)==="pitching"?"p_":"";const keys=cat.keys||[];
      for(const a of cat.athletes||[]){if(!a.athlete)continue;const A=get(a.athlete.id,a.athlete.displayName,ta);A.inBox=true;
        keys.forEach((k,i)=>{const v=String((a.stats||[])[i]??"");const ks=k.split(/[-\/]/),vs=v.split(/[-\/]/);
          if(ks.length>1){if(vs.length===ks.length)ks.forEach((kk,j)=>{if(A.s[pre+kk]==null&&!isNaN(Number(vs[j])))A.s[pre+kk]=Number(vs[j])})}
          else if(A.s[pre+k]==null&&v!==""&&!isNaN(Number(v)))A.s[pre+k]=Number(v)})}}}
  for(const t of d.rosters||[]){const ta=t.team&&t.team.abbreviation;
    for(const r of t.roster||[]){if(!r.athlete)continue;const A=get(r.athlete.id,r.athlete.displayName,ta);
      const st=r.stats||[];if(st.length&&(r.starter||r.subbedIn||st.some(x=>x.name==="appearances"&&x.value>0)))A.inBox=true;
      for(const x of st)if(A.s[x.name]==null&&x.value!=null)A.s[x.name]=Number(x.value)}}
  // MLB: hit types from the play-by-play (the box score has no doubles/triples column)
  const pl=d.plays||[];S._plays=pl.some(p=>p.type&&/play-result|single|double|triple|home-run/.test(p.type.type||""));const seen=new Set();
  for(const p of pl){const at=(p.alternativeType&&p.alternativeType.type)||(p.type&&p.type.type);if(!/^(single|double|triple|home-run)$/.test(at||""))continue;
    const k=(p.atBatId||p.id)+at;if(seen.has(k))continue;seen.add(k);const bt=(p.participants||[]).find(x=>x.type==="batter");if(!bt||!bt.athlete)continue;
    const A=list.find(a=>String(a.id)===String(bt.athlete.id));if(A)A.s["_"+at]=(A.s["_"+at]||0)+1}
  return S._ath=list}
// football TDs from the scoring-play text: "M. Stokes pass to S. Burnside for 76 yds, for a TD", "J. Carter 5 Yd Run", "..., TJ Smith return for 76 yds"
function tdScorer(t){t=String(t||"");let m=t.match(/pass to (.+?) for /i);if(m&&!/intercept/i.test(t))return m[1];
  m=t.match(/(?:intercepted|fumble|blocked|punt|kickoff|kick)[^,]*,\s*([A-Z][\w.'\- ]+?)\s+(?:return|recover|run)/i);if(m)return m[1];
  m=t.match(/^([A-Z][\w.'\-]*(?: [A-Z][\w.'\-]*)*?)\s+(?:\d+\s*y(?:ar)?ds?\s+)?(?:run|rush|pass from|fumble|punt|kick|interception|blocked)/i);return m?m[1]:null}
function tdPlays(S,L){let n=0;for(const p of S.d.scoringPlays||[]){const ty=p.type||{};if(ty.abbreviation!=="TD"&&!/touchdown/i.test(ty.text||""))continue;
    const who=tdScorer(p.text);const ta=p.team&&p.team.abbreviation;if(who&&playerMatch(L.pname||L.player,who)&&(!L.pteam||!ta||ta===L.pteam))n++}return n}
const sumK=(s,...ks)=>{let t=null;for(const k of ks)if(s[k]!=null)t=(t||0)+s[k];return t};
const HOCKEY=p=>p==="hockey/nhl",SOCCER=p=>/^soccer/.test(p||"");
const PROP={ // stat -> [value(stats, ctx), unit]
  td:[(s)=>sumK(s,"rushingTouchdowns","receivingTouchdowns","kickReturnTouchdowns","puntReturnTouchdowns","interceptionTouchdowns"),"TD"],
  passYds:[s=>s.passingYards,"pass yds"],passTD:[s=>s.passingTouchdowns,"pass TD"],rushYds:[s=>s.rushingYards,"rush yds"],rushTD:[s=>s.rushingTouchdowns,"rush TD"],
  recYds:[s=>s.receivingYards,"rec yds"],recTD:[s=>s.receivingTouchdowns,"rec TD"],receptions:[s=>s.receptions,"rec"],rushRecYds:[s=>sumK(s,"rushingYards","receivingYards"),"rush+rec yds"],
  pts:[(s,c)=>HOCKEY(c.path)?sumK(s,"goals","assists"):s.points,"pts"],
  goals:[(s,c)=>SOCCER(c.path)?s.totalGoals:s.goals,"goals"],goal:[s=>s.totalGoals,"goal"],
  assists:[(s,c)=>SOCCER(c.path)?s.goalAssists:s.assists,"ast"],goalOrAssist:[s=>sumK(s,"totalGoals","goalAssists"),"G+A"],
  sog:[(s,c)=>SOCCER(c.path)?s.shotsOnTarget:s.shotsTotal,"SOG"],shots:[(s,c)=>SOCCER(c.path)?s.totalShots:s.shotsTotal,"shots"],sot:[s=>s.shotsOnTarget,"SOT"],
  pra:[s=>sumK(s,"points","rebounds","assists"),"pts+reb+ast"],pr:[s=>sumK(s,"points","rebounds"),"pts+reb"],pa:[s=>sumK(s,"points","assists"),"pts+ast"],
  ra:[s=>sumK(s,"rebounds","assists"),"reb+ast"],stl:[s=>s.steals,"stl"],blk:[s=>s.blocks,"blk"],stocks:[s=>sumK(s,"steals","blocks"),"stl+blk"],
  foulsC:[s=>s.foulsCommitted,"fouls"],foulsD:[s=>s.foulsSuffered,"fouled"],yellow:[s=>s.yellowCards,"YC"],cards:[s=>sumK(s,"yellowCards","redCards"),"cards"],offsides:[s=>s.offsides,"offsides"],
  tackles:[s=>s.totalTackles!=null?s.totalTackles:s.tackles,"tackles"],   // ESPN soccer box score has team tackles only: stays ungraded (no stats) unless a feed ever adds it
  dd:[s=>["points","rebounds","assists","steals","blocks"].filter(k=>(s[k]||0)>=10).length,"categories at 10+"],
  reb:[s=>s.rebounds,"reb"],threes:[s=>s.threePointFieldGoalsMade,"3PM"],saves:[s=>s.saves,"saves"],
  hits:[s=>s.hits,"hits"],hr:[s=>s.homeRuns,"HR"],rbi:[s=>s.RBIs,"RBI"],runs:[s=>s.runs,"runs"],walks:[s=>s.walks,"BB"],sb:[s=>s.stolenBases,"SB"],
  k:[s=>s.p_strikeouts!=null?s.p_strikeouts:s.strikeouts,"K"],hrr:[s=>sumK(s,"hits","runs","RBIs"),"H+R+RBI"],
  doubles:[(s,c)=>s._double!=null?s._double:(c.plays&&s.hits!=null?0:null),"2B"],triples:[(s,c)=>s._triple!=null?s._triple:(c.plays&&s.hits!=null?0:null),"3B"],
  singles:[(s,c)=>s._single!=null?s._single:(c.plays&&s.hits!=null?0:null),"1B"],
  tb:[(s,c)=>c.plays&&s.hits!=null?(s._single||0)+2*(s._double||0)+3*(s._triple||0)+4*(s["_home-run"]||0):null,"TB"]};
const STATRX=[[/fouls?\s*(?:drawn|won|suffered)|was fouled|fouled/i,"foulsD"],[/fouls?(?:\s*(?:committed|conceded))?|free kicks? conceded/i,"foulsC"],
  [/shots?\s*on\s*(?:target|goal)|\bsot\b/i,"sot"],[/(?:total\s+)?shots?/i,"shots"],[/tackles?/i,"tackles"],[/offsides?/i,"offsides"],[/yellow|bookings?|carded|cards?/i,"cards"],
  [/saves?/i,"saves"],[/assists?/i,"assists"],[/goals?/i,"goals"]];
function inferStat(L){const w=String(L.stat_raw||"").trim();if(w){for(const[rx,k]of STATRX)if(rx.test(w))return k}return null}
function propStatus(L,g,matchId){L=L.stat?L:{...L,stat:inferStat(L)};
  if(!L.player)return{s:"?",lbl:"?",n:"stat not found (player not named in the bet log)"};
  const who=(String(L.player).trim().split(/\s+/).pop()||L.player);
  if(!L.stat||!PROP[L.stat])return{s:"?",lbl:"?",n:`stat not found (log doesn't say which ${who} stat${L.stat_raw?": "+L.stat_raw:""})`};
  const S=summaries[matchId];if(!S)return{s:"LIVE",lbl:"LIVE",n:"loading box score…"};
  const ath=athletesOf(S),ctx={path:S.path,plays:S._plays},[fn,unit]=PROP[L.stat];
  let c=L.pid?ath.filter(a=>String(a.id)===String(L.pid)):[];
  if(!c.length)c=ath.filter(a=>playerMatch(L.pname||L.player,a.name)&&(!L.pteam||!a.team||a.team===L.pteam));
  if(c.length>1){const ib=c.filter(a=>a.inBox);if(ib.length)c=ib}
  if(c.length>1){const wv=c.filter(a=>fn(a.s,ctx)!=null);if(wv.length)c=wv}
  if(!c.length){const ln=nameW(L.pname||L.player).slice(-1)[0],u=ath.filter(a=>ln&&ln.length>2&&nameW(a.name).includes(ln)&&(!L.pteam||!a.team||a.team===L.pteam));if(u.length===1)c=u}   // last-name fallback when it is unique on that team
  const A=c[0],supported=ath.some(a=>fn(a.s,ctx)!=null)||(L.stat==="td"&&(S.d.scoringPlays||[]).length>0);
  let v=A?fn(A.s,ctx):null;
  if(L.stat==="td"){const tp=tdPlays(S,L);if(tp>0||v!=null||A||L.pteam)v=Math.max(v||0,tp)}
  if(v==null){const pt1=L.op==="under"?L.line:(L.op==="over"?Math.floor(L.line)+1:L.min);
    if((A||L.pteam)&&supported)v=0;
    else if(L.stat==="tackles")return{s:"?",lbl:"?",n:`${who}: ESPN has no per-player tackles — settle by hand`};
    else return g.completed?{s:"?",lbl:"?",n:`${who}: no stats in the feed (did not play?)`}:{s:"LIVE",lbl:"LIVE",pt:pt1,unit,n:`${who}: no stats yet`}}
  if(SOCCER(S.path)&&g.completed&&(!A||!A.inBox))return{s:"?",lbl:"?",n:`${who}: did not play (not in the squad or unused sub), the book usually voids this — settle by hand`};
  const fin=g.completed,none=!A||!A.inBox?" (no stats yet)":"",pt0=L.op==="under"?L.line:(L.op==="over"?Math.floor(L.line)+1:L.min);
  const HIT={s:"WON",lbl:"HIT",pv:v,pt:pt0,unit},MISS={s:"LOST",lbl:"MISSED",pv:v,pt:pt0,unit},LV={s:"LIVE",lbl:"LIVE",pv:v,pt:pt0,unit};
  if(L.op==="under"){const n=`${who} ${v} ${unit} (needs under ${L.line})`;
    if(v>L.line)return{...MISS,n};return{...(fin?HIT:LV),n:fin?n:n+" · on track"}}
  const tgt=L.op==="over"?Math.floor(L.line)+1:L.min;
  if(L.stat==="td"&&tgt===1){if(v>=1)return{...HIT,n:`${who}: TD scored${v>1?` (${v})`:""}`};return{...(fin?MISS:LV),n:fin?`${who}: no TD`:`${who}: no TD yet`}}
  const n=`${who} ${v}/${tgt} ${unit}${none}`;
  if(v>=tgt)return{...HIT,n};return{...(fin?MISS:LV),n:fin?n:n+` · needs ${tgt-v} more`}}
function combine(st){if(st.some(s=>s==="LOST"))return"LOST";if(st.every(s=>s==="WON"))return"WON";
  if(st.some(s=>s==="LOSING"))return"LOSING";if(st.every(s=>s==="NOT STARTED"))return"NOT STARTED";
  if(st.every(s=>s==="WON"||s==="WINNING"))return"WINNING";if(st.every(s=>s==="WON"||s==="WINNING"||s==="NOT STARTED"))return"WINNING";
  if(st.some(s=>s==="TIED"||s==="PUSH"))return"TIED";return"LIVE"}
const cls=s=>String(s).replace(/\s/g,"_").replace(/[^\w-]/g,"");
function fmtStart(g,raw){if(g&&g.date){const d=new Date(g.date);return d.toLocaleString("en-CA",{timeZone:TZ,weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})+" ET"}return raw}
function scoreBox(g){if(!g)return"";if(LiveUI.scoreBox){try{const h=LiveUI.scoreBox(g);if(h)return h}catch(e){}}const live=g.state==="in";
  const order=[...g.teams].sort((a,b)=>a.home-b.home);
  return `<div class="score">${order.map(t=>`<div class="row"><span>${esc(t.name)}</span><b>${g.state==="pre"?"":esc(t.score)}</b></div>`).join("")}
    <div class="det">${live?'<span class="live">● LIVE</span> ':""}${g.state==="pre"?"Not started":g.completed?esc(g.detail):`<span data-clk="${esc(g.id)}" data-sep=" - ">${esc(clockText(g," - "))}</span>`}</div>${g.completed?"":stBadge(g)}</div>`}

// ===== Our estimate (NOT ESPN, NOT a sportsbook price): Pinnacle pregame no-vig inputs + live score/clock =====
const SD={"football/nfl":[13.5,10],"football/college-football":[15,12],"basketball/nba":[12,18],"basketball/wnba":[11,15]};
const PER={"football/nfl":[4,900],"football/college-football":[4,900],"basketball/nba":[4,720],"basketball/wnba":[4,600],"hockey/nhl":[3,1200]};
function erf(x){const t=1/(1+0.3275911*Math.abs(x)),y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y}
const Phi=x=>0.5*(1+erf(x/Math.SQRT2));
function invPhi(p){p=Math.min(Math.max(p,1e-6),1-1e-6);let lo=-8,hi=8;for(let i=0;i<60;i++){const m=(lo+hi)/2;Phi(m)<p?lo=m:hi=m}return(lo+hi)/2}
function pois(l,n=30){const a=[Math.exp(-l)];for(let k=1;k<=n;k++)a.push(a[k-1]*l/k);return a}
function diffDist(lh,la){const ph=pois(lh),pa=pois(la),d={};ph.forEach((x,i)=>pa.forEach((y,j)=>{d[i-j]=(d[i-j]||0)+x*y}));return d}
function pOverPois(l,need){// P(X > need) with push on equality excluded (conditional)
  const p=pois(l,40);let under=0,eq=0;for(let k=0;k<p.length;k++){if(k<need)under+=p[k];else if(k===need)eq+=p[k]}
  const over=1-under-eq;return Number.isInteger(need)?over/Math.max(1e-9,over+under):over}
function bisect(f,lo,hi,target,inc=true){for(let i=0;i<60;i++){const m=(lo+hi)/2;((f(m)<target)===inc)?lo=m:hi=m}return(lo+hi)/2}
const homeWinPois=(lh,la,m0=0)=>{const d=diffDist(lh,la);let w=0,t=0;for(const k in d){const v=m0+ +k;if(v>0)w+=d[k];else if(v===0)t+=d[k]}return w+0.5*t};
const _mc={};
// no Pinnacle inputs (build only has them for some games): fall back to the sportsbook line ESPN carries, same shape
function pseudoPin(m){const g=gameFor(m),od=g&&g.odds;if(!od||SOCCER(m.path))return null;const nv=(a,b)=>{const x=ip(a),y=ip(b);return x/(x+y)},P={};
  if(od.ml)P.ml_home=nv(od.ml.h,od.ml.a);if(od.sp){P.spread_home_line=od.sp.h;P.spread_home_fair=nv(od.sp.ho,od.sp.ao)}
  if(od.tot){P.total_line=od.tot.line;P.total_over_fair=nv(od.tot.o,od.tot.u)}return Object.keys(P).length?P:null}
function modelFor(m){if(!m)return null;if(_mc[m.id])return _mc[m.id];const P=m.pin||pseudoPin(m);if(!P)return null;const out={};
  if(m.path==="hockey/nhl"||m.path==="baseball/mlb"){
    if(P.total_line!=null&&P.total_over_fair!=null){const need=P.total_line,ln=Number.isInteger(need)?need:Math.floor(need);
      out.T=bisect(T=>Number.isInteger(need)?pOverPois(T,need):pOverPois(T,ln+0.5),0.3,25,P.total_over_fair)}
    if(out.T&&P.ml_home!=null){const r=bisect(r=>homeWinPois(r*out.T,(1-r)*out.T),0.02,0.98,P.ml_home);out.lh=r*out.T;out.la=(1-r)*out.T}
    out.kind="pois"}
  else if(SD[m.path]){const[sdm,sdt]=SD[m.path];out.sdm=sdm;out.sdt=sdt;out.kind="norm";
    if(P.ml_home!=null)out.muML=sdm*invPhi(P.ml_home);
    if(P.spread_home_line!=null&&P.spread_home_fair!=null)out.muSP=sdm*invPhi(P.spread_home_fair)-P.spread_home_line;
    if(P.total_line!=null&&P.total_over_fair!=null)out.muT=P.total_line+sdt*invPhi(P.total_over_fair)}
  else return null;
  return _mc[m.id]=out}
// fraction of the game left (football/basketball/hockey) or remaining innings per team (MLB)
function remaining(m,g){
  if(g.state==="pre")return m.path==="baseball/mlb"?{a:9,h:9}:1;
  if(g.completed)return m.path==="baseball/mlb"?{a:0,h:0}:0;
  if(m.path==="baseball/mlb"){const k=g.period||1,d=String(g.detail||"");
    const left=typeof g.outs==="number"?(3-g.outs)/3:0.5; // share of the current half-inning still to play
    if(/^Top/i.test(d))return{a:Math.max(0,9-k+left),h:Math.max(0,10-k)};
    if(/^Mid/i.test(d))return{a:Math.max(0,9-k),h:Math.max(0,10-k)};
    if(/^Bot/i.test(d))return{a:Math.max(0,9-k),h:Math.max(0,9-k+left)};
    return{a:Math.max(0,9-k),h:Math.max(0,9-k)}}
  const[n,len]=PER[m.path]||[4,900];const p=g.period||1;if(p>n)return 0;
  const c=typeof g.clock==="number"?g.clock:len;return Math.max(0,Math.min(1,((n-p)*len+c)/(n*len)))}
// probability that a leg cashes (or picked team wins for ml). Returns null when inputs are missing.
function estLeg(L,m,g){const M=modelFor(m);if(!M||!g)return null;
  const sc=g.teams.map(t=>Number(t.score||0)),hi=g.teams.findIndex(t=>t.home),ai=1-hi;
  const H=sc[hi],A=sc[ai],S=H+A;
  let pickHome=null;if(L.team){const i=sideIdx(g,L.team);if(i<0)return null;pickHome=g.teams[i].home}
  const f=remaining(m,g);
  if(M.kind==="norm"){
    if(L.type==="ml"||L.type==="spread"){const mu=L.type==="ml"?M.muML:M.muSP;if(mu==null)return null;
      const line=L.type==="spread"?L.line:0, cur=(pickHome?H-A:A-H)+line, mean=(pickHome?mu:-mu)*f, sd=M.sdm*Math.sqrt(f);
      if(sd<1e-6)return cur>0?1:cur<0?0:0.5;return Phi((cur+mean)/sd)}
    if(L.type==="total"){if(M.muT==null)return null;const sd=M.sdt*Math.sqrt(f),need=L.line-S,mean=M.muT*f;
      const po=sd<1e-6?(need<0?1:need>0?0:0.5):1-Phi((need-mean)/sd);return L.side==="over"?po:1-po}
    return null}
  // Poisson (NHL / MLB)
  const fh=typeof f==="object"?f.h/9:f, fa=typeof f==="object"?f.a/9:f;
  if(L.type==="ml"||L.type==="spread"){if(M.lh==null)return null;const line=L.type==="spread"?L.line:0;
    const d=diffDist(M.lh*fh,M.la*fa);let w=0,push=0;const m0=H-A;
    for(const k in d){const v=(pickHome?(m0+ +k):-(m0+ +k))+line;if(v>0)w+=d[k];else if(v===0)push+=d[k]}
    return L.type==="ml"?w+0.5*push:w/Math.max(1e-9,1-push)}
  if(L.type==="total"){if(M.T==null)return null;const lr=M.T*(M.lh!=null?(M.lh*fh+M.la*fa)/M.T:(fh+fa)/2);
    const need=L.line-S;let po;if(need<0)po=1;else po=Number.isInteger(need)?pOverPois(lr,need):pOverPois(lr,Math.floor(need)+0.5);
    return L.side==="over"?po:1-po}
  return null}
const CLOCK_SPORTS=new Set(["football/nfl","football/college-football","basketball/nba","hockey/nhl"]);
// game with its clock run down locally since the last ESPN fetch (only when the clock was seen moving)
function localGame(g,m){if(!g||g.state!=="in"||!m||!CLOCK_SPORTS.has(m.path))return g;const c=CLK[g.id];
  const rs=RS[g.id];if(!c||!c.moving||document.hidden||(rs&&rs.conf&&(rs.conf.kind==="break")))return g;const el=Math.min(25,(Date.now()-c.t)/1000);
  return{...g,clock:Math.max(0,c.clock-el)}}
const fmtClk=sec=>{sec=Math.max(0,Math.ceil(sec));return`${Math.floor(sec/60)}:${String(sec%60).padStart(2,"0")}`};
function clockText(g,sep){const per=String(g.detail||"").split(" - ")[1];const m={path:null};
  const c=CLK[g.id];if(!per||typeof g.clock!=="number")return String(g.detail||"").replace(" - ",sep);
  let v=g.clock;const rs=RS[g.id];if(c&&c.moving&&!document.hidden&&!(rs&&rs.conf&&rs.conf.kind==="break"))v=Math.max(0,c.clock-Math.min(25,(Date.now()-c.t)/1000));
  return`${fmtClk(v)}${sep}${per}`}
function matchOfLeg(b,L){return b.match||L.match}
// ---------- Polymarket (CLOB mid) + Action Network live odds ----------
const PMX={}, PMMID={}, ANG={}, pmTried={};let anAt=0, anOK=null, pmOK=null;
const PM_PATHS=new Set(["football/nfl","football/college-football","hockey/nhl","baseball/mlb","basketball/nba"]);
const pmPath=p=>PM_PATHS.has(p)||/^soccer/.test(p||"")||p==="basketball/wnba";
// Polymarket's names differ from ESPN's ("FC Bayern München" / "Bayern Munich"): also accept a shared distinctive word
const PMSTOP=new Set(["fc","afc","cf","sc","ac","the","de","fk","as","ssc","ud","cd","sk","city","united","utd"]);
const pmToks=n=>norm(n).filter(w=>!PMSTOP.has(w));
function pmLoose(name,T){if(teamMatch(name,T))return true;const q=pmToks(name);
  return[T.name,T.short,T.location,T.nick].filter(Boolean).some(v=>{const t=pmToks(v);return q.some(a=>t.some(b=>(a===b&&a.length>=4)||(a.length>=5&&b.length>=5&&a.slice(0,5)===b.slice(0,5))))})}
const AN_LG={"football/nfl":"nfl","football/college-football":"ncaaf","hockey/nhl":"nhl","baseball/mlb":"mlb","basketball/nba":"nba"};
function pmOf(m){return m&&(m.pm||PMX[m.id])||null}
function pickTeam(g,L){if(!g||!L.team)return null;const i=sideIdx(g,L.team);return i<0?null:{T:g.teams[i],O:g.teams[1-i]}}
function pmIdx(outs,pt){const a=outs.map(o=>teamMatch(o,pt.T)&&!teamMatch(o,pt.O));return a.filter(Boolean).length===1?a.indexOf(true):-1}
// token for the bet's own outcome; spreads/totals only when Polymarket has the exact same line
function pmToken(L,m,g){const pm=pmOf(m);if(!pm||!g)return null;
  if(L.type==="draw"&&pm.soc){const x=pm.soc.find(y=>y.draw);return x?x.yes:null}
  if(L.type==="ml"&&pm.soc){const pt=pickTeam(g,L);if(!pt)return null;const x=pm.soc.find(y=>!y.draw&&pmLoose(y.title,pt.T));return x?x.yes:null}
  if(L.type==="ml"){const pt=pickTeam(g,L);if(!pt||!pm.ml)return null;const i=pmIdx(pm.ml.outcomes,pt);return i<0?null:pm.ml.tokens[i]}
  if(L.type==="spread"){const pt=pickTeam(g,L);if(!pt)return null;
    for(const x of pm.spreads||[]){const i=pmIdx(x.outcomes,pt);if(i===0&&x.line===L.line)return x.tokens[0];if(i===1&&x.line===-L.line)return x.tokens[1]}return null}
  if(L.type==="total"){for(const x of pm.totals||[]){if(x.line!==L.line)continue;const i=x.outcomes.findIndex(o=>o.toLowerCase()===L.side);if(i>=0)return x.tokens[i]}return null}
  return null}
function pmVal(L,m,g){const t=pmToken(L,m,g);const q=t&&PMMID[t];if(!q||Date.now()-q.t>90000)return null;return q}
async function pmLookup(m){pmTried[m.id]=1;const g=gameFor(m);if(!g)return;const A=g.teams.find(t=>!t.home),H=g.teams.find(t=>t.home);
  try{for(const q of [`${A.location} ${H.location}`,`${A.nick} ${H.nick}`,`${A.name} ${H.name}`,...(/^soccer/.test(m.path)?[[A,H].map(t=>pmToks(t.name).sort((x,y)=>y.length-x.length)[0]||t.name).join(" ")]:[])]){
      const d=await getJSON("https://gamma-api.polymarket.com/public-search?limit_per_type=15&events_status=all&q="+encodeURIComponent(q));
      for(const e of d.events||[]){if(!/^[a-z]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/.test(e.slug||"")||!e.startTime)continue;
        if(Math.abs(new Date(e.startTime)-new Date(g.date))>4*3600e3)continue;const pr=String(e.title||"").split(/\s+vs\.?\s+/);if(pr.length!==2)continue;
        const soc=/^soccer/.test(m.path),ok=soc?((pmLoose(pr[0],A)&&pmLoose(pr[1],H))||(pmLoose(pr[0],H)&&pmLoose(pr[1],A))):((teamMatch(pr[0],A)&&teamMatch(pr[1],H))||(teamMatch(pr[0],H)&&teamMatch(pr[1],A)));if(!ok)continue;
        const full=(await getJSON("https://gamma-api.polymarket.com/events?slug="+e.slug))[0]||e;const J=x=>{try{return typeof x==="string"?JSON.parse(x):(x||[])}catch(_){return[]}};
        const pm={slug:e.slug,spreads:[],totals:[]};for(const mk of full.markets||[]){const t=mk.sportsMarketType,tk=J(mk.clobTokenIds),o=J(mk.outcomes);if(tk.length!==2||o.length!==2)continue;
          if(soc&&t==="moneyline"){(pm.soc=pm.soc||[]).push({title:mk.groupItemTitle||"",yes:tk[0],draw:/draw/i.test(mk.groupItemTitle||mk.question||"")});continue}
          if(t==="moneyline"&&!pm.ml)pm.ml={outcomes:o,tokens:tk};else if(t==="spreads"&&mk.line!=null)pm.spreads.push({line:+mk.line,outcomes:o,tokens:tk});else if(t==="totals"&&mk.line!=null)pm.totals.push({line:+mk.line,outcomes:o,tokens:tk})}
        if(pm.ml||pm.soc){PMX[m.id]=pm;return}}}}catch(e){}}
function pmWanted(m,g){return g&&!g.completed&&(g.state==="in"||new Date(g.date)-Date.now()<3*3600e3)}
// ---- futures (outright winner / MVP / relegation ...): Polymarket outcome price, matched by title keywords + the team / player name ----
const PMF={},pmfTried={};const FUT_KW=["relegat","mvp","cup","champion","runner","finals","golden boot","top scorer","promot","rookie","defensive","coach"];
const isFuture=b=>!b.match&&!b.legs.some(L=>L.match);
function futParts(b){const txt=`${b.event} ${b.pick}`.toLowerCase(),kws=FUT_KW.filter(k=>txt.includes(k));
  const ent=String(b.pick||"").replace(/\b(to (win|be|finish|get|reach)\b.*|\d{2}-\d{2}|20\d\d\/?\d*|nba|nfl|nhl|mlb|epl|regular season|mvp|cup|finals?|runner up|champion(ship)?|relegated|outrights?)\b/ig," ").replace(/\s+/g," ").trim();
  return{kws,ent,q:String(b.pick||"").replace(/\bto (win|be)\b/ig," ").replace(/\b\d{2}-\d{2}\b/g," ").replace(/\s+/g," ").trim()}}
async function pmFutLookup(b){const k=cardKey(b);pmfTried[k]=1;const{kws,ent,q}=futParts(b);if(!kws.length||!ent)return;
  try{for(const qq of [q,`${ent} ${kws[0]==="relegat"?"relegated":kws[0]==="promot"?"promoted":kws[0]}`]){let d;try{d=await getJSON("https://gamma-api.polymarket.com/public-search?limit_per_type=10&events_status=active&q="+encodeURIComponent(qq))}catch(_){continue}
    for(const e of d.events||[]){const ti=String(e.title||"").toLowerCase();if(!kws.every(w=>ti.includes(w)))continue;
      if(kws.includes("cup")&&!/nba cup|fa cup|league cup|world cup|champions/.test(ti)&&!ti.includes("cup"))continue;
      const full=(await getJSON("https://gamma-api.polymarket.com/events?slug="+e.slug))[0]||e;const J=x=>{try{return typeof x==="string"?JSON.parse(x):(x||[])}catch(_){return[]}};
      for(const mk of full.markets||[]){const tk=J(mk.clobTokenIds),o=J(mk.outcomes);if(tk.length!==2||o.length!==2||String(o[0]).toLowerCase()!=="yes")continue;
        const nm=mk.groupItemTitle||mk.question||"";if(!pmLoose(ent,{name:nm,short:nm,location:nm,nick:nm}))continue;
        PMF[k]={token:tk[0],title:e.title,q:mk.question||nm,slug:e.slug};return}}}}catch(e){}}
function futBar(b){const f=PMF[cardKey(b)];if(!f)return"";const q=PMMID[f.token];if(!q||Date.now()-q.t>120000)return"";
  return bar(`Polymarket · ${esc(f.q).slice(0,70)}`,q.mid*100,"pmb",`Polymarket mid · ${esc(f.title)} · spread ${q.spread!=null?(q.spread*100).toFixed(1)+"¢":"?"} · futures price, not a live game odds`)}
async function refreshPM(){const toks=new Set();
  for(const b of DATA.open)for(const L of b.legs){const m=matchOfLeg(b,L),g=gameFor(m);if(!m||!pmPath(m.path)||!pmWanted(m,g))continue;
    if(!pmOf(m)&&!pmTried[m.id])await pmLookup(m);const t=pmToken(L,m,g);if(t)toks.add(t)}
  for(const b of DATA.open)if(isFuture(b)){const k=cardKey(b);if(!PMF[k]&&!pmfTried[k])await pmFutLookup(b);if(PMF[k])toks.add(PMF[k].token)}
  if(!toks.size)return;const body=JSON.stringify([...toks].map(t=>({token_id:t})));
  try{const [a,c]=await Promise.all(["midpoints","spreads"].map(e=>tfetch("https://clob.polymarket.com/"+e,{method:"POST",body,cache:"no-store"}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json()})));
    const now=Date.now();for(const t of toks)if(a[t]!=null)PMMID[t]={mid:+a[t],spread:c[t]!=null?+c[t]:null,t:now};pmOK=true}catch(e){pmOK=false}}
async function refreshAN(){if(Date.now()-anAt<29000)return;anAt=Date.now();const ids=new Set();
  for(const m of allMatches()){const g=gameFor(m);if(m.an&&g&&g.state==="in"&&!g.completed)ids.add(m.an.id)}
  await Promise.all([...ids].map(async id=>{try{if(!/^\d+$/.test(String(id)))return;const d=await getJSON(`https://api.actionnetwork.com/web/v2/games/${id}/polling?bookIds=15,30,68,69,71,75,79,123,247`);ANG[id]={mk:d.markets||{},t:Date.now()};anOK=true}catch(e){anOK=false}}))}
const ip=o=>o<0?-o/(-o+100):100/(o+100);
const fmtO=o=>o>0?"+"+o:"−"+Math.abs(o);
const BKN={15:"Consensus",68:"DK",69:"FD",79:"365",123:"CZR"};
function anLive(m){const a=m&&m.an&&ANG[m.an.id];if(!a||Date.now()-a.t>120000)return null;return a.mk}
// live entries for this leg's own side: [{book, odds, value, opp}] ; exact=true keeps only his line
function anSide(L,m,g,book){const mk=anLive(m);if(!mk||!mk[book])return null;const ev=mk[book].event||{};
  let side,arr;if(L.type==="total"){side=L.side;arr=(ev.total||[]).filter(x=>x.is_live)}
  else{const pt=pickTeam(g,L);if(!pt)return null;side=pt.T.home?"home":"away";arr=(ev[L.type==="ml"?"moneyline":"spread"]||[]).filter(x=>x.is_live)}
  const mine=arr.find(x=>x.side===side);if(!mine)return null;const opp=arr.find(x=>x.side!==side&&(L.type==="ml"||Math.abs(x.value)===Math.abs(mine.value)));
  return{odds:mine.odds,value:mine.value,opp:opp&&opp.odds}}
function nv(x){return x&&x.opp!=null?ip(x.odds)/(ip(x.odds)+ip(x.opp)):null}
// Books (no-vig): consensus live line; spreads/totals only at his exact line
function booksP(L,m,g){if(!["ml","spread","total"].includes(L.type))return null;
  const exact=x=>L.type==="ml"||(x&&(L.type==="total"?x.value===L.line:x.value===L.line));
  for(const bk of [15,68,69,123,79]){const x=anSide(L,m,g,bk);if(x&&exact(x)){const v=nv(x);if(v!=null)return{v,book:bk}}}return null}
function anText(L,m,g){if(!["ml","spread","total"].includes(L.type))return"";const parts=[];
  for(const bk of [68,69,79,123,15]){const x=anSide(L,m,g,bk);if(!x)continue;
    const ln=L.type==="ml"?"":L.type==="spread"?fmtLine(x.value)+" ":(L.side==="over"?"O":"U")+x.value+" ";parts.push(`${BKN[bk]} ${ln}${fmtO(x.odds)}`)}
  return parts.length?"Live: "+parts.join(" · "):""}
// ordered probability sources for one leg (first = the one used for pill + payout)
function legSources(b,L){const m=matchOfLeg(b,L),g=gameFor(m);if(!g||g.completed)return[];const out=[],live=g.state==="in";
  const pmq=pmVal(L,m,g);
  const pmOk=pmq&&(pmq.spread==null||pmq.spread<=0.1);
  if(L.type==="ml"){
    if(live&&pmOk)out.push({k:"pm",v:pmq.mid});
    const bp=live&&booksP(L,m,g);if(bp)out.push({k:"books",v:bp.v,book:bp.book});
    const e=estLeg(L,m,localGame(g,m));if(e!=null)out.push({k:"est",v:e});
    if(live&&probs[m.id]){const pt=pickTeam(g,L);if(pt){const pr=probs[m.id];out.push({k:"espn",v:pt.T.home?pr.home:(pr.away!=null?pr.away:1-pr.home)})}}
    if(!live){const pg=pregameLive[m.id]||m.pregame,pt=pickTeam(g,L);if(pg&&pt)out.push({k:"pre",v:(pt.T.home?pg.home:pg.away)/100})}}
  else if(L.type==="spread"||L.type==="total"){
    const bp=live&&booksP(L,m,g);if(bp)out.push({k:"books",v:bp.v,book:bp.book});
    const e=estLeg(L,m,localGame(g,m));if(e!=null)out.push({k:"est",v:e})}
  return out}
const SRC_LBL={pm:"Polymarket",books:"Books (no-vig)",est:"Est.",espn:"ESPN",pre:"ESPN pregame"};
// p for the expected-payout tile: Est., else ESPN (moneylines only), else pregame. null = excluded
function payoutP(b,status){
  if(status==="WON")return 1;if(status==="LOST")return 0;
  if(b.multi)return null; // correlated legs: no honest single number
  const L=b.legs[0];if(!L)return null;const m=matchOfLeg(b,L),g=gameFor(m);if(!g)return null;
  if(g.completed&&status==="PUSH")return "push";
  const src=legSources(b,L);if(src.length)return src[0].v;
  const p=probFor(b);if(p&&p.ml)return p.pct/100;return null}
// implied win probability from the bet's price (boosted if present); American or decimal odds. null = no usable price
function impliedP(b){const r=String(b.boosted_price||b.price||"").trim();if(!r)return null;const n=parseFloat(r.replace("−","-"));if(!isFinite(n)||n===0)return null;
  if(/^[+-]/.test(r.replace("−","-"))||Math.abs(n)>=100){const d=n>0?1+n/100:1+100/-n;return 1/d}return n>1?1/n:null}
const moneyC=v=>v==null?"?":"$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
let LAST_STATUS={};
// ---- bet-level live pill: from the bet's own win probability, not "cashes if it ended now" ----
const SCORE_SUB={WINNING:"cashes at current score",LOSING:"needs more at current score",TIED:"tied at current score",PUSH:"push at current score"};
// ---- approximate leg chance when no market/model number exists: score + clock (+ pace for totals/props) ----
const SDX={"football/nfl":[13.5,10],"football/college-football":[15,12],"basketball/nba":[12,18],"basketball/wnba":[10,14],"basketball/mens-college-basketball":[11,14],"basketball/womens-college-basketball":[11,14],"hockey/nhl":[1.7,1.9],"baseball/mlb":[3.3,3.6]};
const PERX={...PER,"basketball/wnba":[4,600],"basketball/mens-college-basketball":[2,1200],"basketball/womens-college-basketball":[4,600]};
function fracLeft(m,g){if(!g||g.state==="pre")return 1;if(g.completed)return 0;const path=m&&m.path||"";
  if(path==="baseball/mlb"){const r=remaining(m,g);return Math.max(0,Math.min(1,(r.a+r.h)/18))}
  if(SOCCER(path)){if(typeof g.clock==="number"&&g.clock>0)return Math.max(0.01,1-g.clock/5400);return g.period>=2?0.25:0.75}
  const[n,len]=PERX[path]||[4,900],p=g.period||1;if(p>n)return 0.03;const c=typeof g.clock==="number"?g.clock:len;
  if(/half/i.test(g.detail||""))return 0.5;return Math.max(0.005,Math.min(1,((n-p)*len+c)/(n*len)))}
function poisGE(l,k){if(k<=0)return 1;let t=Math.exp(-l),c=t;for(let i=1;i<k;i++){t*=l/i;c+=t}return Math.max(0,1-c)}
// soccer: remaining goals are Poisson (about 1.35 per team per 90 minutes); results are decided by goal difference / total goals
function soccerP(L,g,f){const lam=1.35*f,sc=g.teams.map(t=>Number(t.score||0)),S=sc[0]+sc[1];
  if(L.type==="total"){const need=L.line-S;let po;if(need<0)po=1;else po=pOverPois(2*lam,Number.isInteger(need)?need:Math.floor(need)+0.5);return L.side==="under"?1-po:po}
  if(L.type==="draw"){const d=diffDist(lam,lam);return d[sc[1]-sc[0]]||0}
  if(L.type==="btts"){const p0=Math.exp(-lam),a=sc[0]>0?1:1-p0,b=sc[1]>0?1:1-p0;return L.yes?a*b:1-a*b}   // diff in the remaining goals must exactly undo the current gap
  const pt=pickTeam(g,L);if(!pt)return null;const cur=Number(pt.T.score||0)-Number(pt.O.score||0)+(L.type==="spread"?L.line:0),d=diffDist(lam,lam);let w=0,push=0;
  for(const k in d){const v=cur+ +k;if(v>0)w+=d[k];else if(v===0)push+=d[k]}
  return L.type==="ml"?w:w/Math.max(1e-9,1-push)}
function approxLeg(b,L,x){if(x.s==="WON")return 1;if(x.s==="LOST")return 0;const m=matchOfLeg(b,L),g=x.g||gameFor(m);if(!g||!m)return 0.5;
  if(g.state!=="in"&&L.type==="prop"){const pp=propPre(L,m);if(pp!=null)return pp}
  if(g.state!=="in"){if(L.type==="ml"){const pg=pregameLive[m.id]||m.pregame,pt=pickTeam(g,L);if(pg&&pt)return(pt.T.home?pg.home:pg.away)/100}return 0.5}
  const lg=localGame(g,m),f=fracLeft(m,lg),e=1-f,[sdm,sdt]=SDX[m.path]||[12,14],sc=g.teams.map(t=>Number(t.score||0)),S=sc[0]+sc[1],soc=SOCCER(m.path);
  if(soc&&(L.type==="ml"||L.type==="spread"||L.type==="total"||L.type==="draw"||L.type==="btts")){const v=soccerP(L,lg,f);if(v!=null)return v}
  const w=Math.min(0.75,e); // trust the observed pace more as the game goes on (never fully)
  const overP=(cur,line,sd0)=>{if(f<0.004)return cur>line?1:cur<line?0:0.5;const pace=e>0.02?cur/e:line,rem=f*(w*pace+(1-w)*line),sd=Math.max(0.5,sd0*Math.sqrt(f));return 1-Phi((line-cur-rem)/sd)};
  if(L.type==="ml"||L.type==="spread"){const pt=pickTeam(g,L);if(!pt)return 0.5;const cur=Number(pt.T.score||0)-Number(pt.O.score||0)+(L.type==="spread"?L.line:0);
    let mu=0;const M=modelFor(m);
    if(M&&M.kind==="norm"){const mm=L.type==="ml"?M.muML:M.muSP;if(mm!=null)mu=(pt.T.home?mm:-mm)*f}
    else{const pg=pregameLive[m.id]||m.pregame;if(pg&&!soc){const p0=Math.min(0.97,Math.max(0.03,(pt.T.home?pg.home:pg.away)/100));mu=sdm*invPhi(p0)*f}}
    const adj=soc&&L.type==="ml"?0.5:0,sd=sdm*Math.sqrt(f);if(sd<1e-6)return cur-adj>0?1:cur-adj<0?0:0.5;return Phi((cur-adj+mu)/sd)}
  if(L.type==="total"){const po=overP(S,L.line,sdt);return L.side==="under"?1-po:po}
  if(L.type==="teamtotal"){const pt=pickTeam(g,L);if(!pt)return 0.5;const po=overP(Number(pt.T.score||0),L.line,sdt*0.7);return L.side==="under"?1-po:po}
  if(L.type==="prop"){if(x.pv==null||x.pt==null)return 0.5;const v=x.pv,line=L.op==="under"?L.line:x.pt-0.5;if(f<0.004)return L.op==="under"?(v<=L.line?1:0):(v>=x.pt?1:0);
    const pace=e>0.02?v/e:line,rem=Math.max(0.01,f*(w*pace+(1-w)*line));let po;
    if(x.pt<=15)po=poisGE(rem,L.op==="under"?Math.floor(L.line)+1-v:x.pt-v);   // counts: Poisson on what's left
    else po=1-Phi((line-v-rem)/Math.max(1,0.35*line*Math.sqrt(f)));                 // yards/points: normal on pace
    return L.op==="under"?1-po:po}
  return 0.5}
function legP(b,L,st,x){if(st==="WON")return 1;if(st==="LOST")return 0;const m=matchOfLeg(b,L),g=gameFor(m);if(!g)return null;
  x=x||{L,g,s:st};
  if(L.type==="prop"||L.type==="teamtotal"||st==="?")return approxLeg(b,L,x);
  const src=legSources(b,L).filter(y=>y.k!=="pre");return src.length?src[0].v:approxLeg(b,L,x)}
// ESPN keeps a game "pre" until the real puck drop / tip-off (often 5-20 min after the listed time). A game whose listed
// start has passed (up to 90 min) and is not final counts as started, so its bets move to Live Now instead of sitting in Upcoming.
const STARTING_MS=90*60e3;
function gStarting(g){if(!g||g.state!=="pre"||g.completed||!g.date)return false;const t=Date.parse(g.date);return isFinite(t)&&Date.now()>=t&&Date.now()-t<STARTING_MS}
function gLive(g){return!!g&&(g.state==="in"||gStarting(g))}
function betLive(b,status,legStats){
  const gs=legStats.map(x=>x.g).filter(Boolean);const allFinal=gs.length&&gs.length===b.legs.length&&gs.every(g=>g.completed);
  if(status==="WON"||status==="LOST"||(status==="PUSH"&&allFinal)||allFinal)return{final:true};
  if(!gs.some(g=>g.state==="in"))return gs.some(gStarting)?{upcoming:true,starting:true}:{upcoming:true};
  let p;if(b.multi){p=1;const used=new Set();
    // Over a + Under b on the same game total = one band (a,b): P = P(over a) + P(under b) - 1, not the product
    legStats.forEach((x,i)=>{if(x.L.type!=="total"||x.L.side!=="over"||used.has(i))return;const m=matchOfLeg(b,x.L);
      const j=legStats.findIndex((y,k)=>!used.has(k)&&k!==i&&y.L.type==="total"&&y.L.side==="under"&&y.L.line>x.L.line&&matchOfLeg(b,y.L)===m);if(j<0)return;
      const po=legP(b,x.L,x.s,x),pu=legP(b,legStats[j].L,legStats[j].s,legStats[j]);used.add(i);used.add(j);p*=Math.max(0.005,Math.min(1,(po==null?0.5:po)+(pu==null?0.5:pu)-1))});
    legStats.forEach((x,i)=>{if(used.has(i))return;if(x.s==="PUSH"&&x.g&&x.g.completed)return;const v=legP(b,x.L,x.s,x);p*=v==null?0.5:v})}
  else{const x=legStats[0];p=x?legP(b,x.L,x.s,x):null;if(p==null&&x)p=approxLeg(b,x.L,x)}
  return{p,approx:b.multi,sub:b.multi?null:SCORE_SUB[legStats[0]&&legStats[0].s]||null}}
function pillState(b,status,legStats){const v=betLive(b,status,legStats);
  if(v.final)return{cls:status,txt:status,sub:""};
  if(v.starting)return{cls:"LIVE",txt:"STARTING",sub:"start time passed · waiting for ESPN"};
  if(v.upcoming)return{cls:"NOT_STARTED",txt:"UPCOMING",sub:""};
  const hitTxt=b.multi?legsHit(legStats):"";
  if(v.p==null)return{cls:"LIVE",txt:"LIVE",sub:v.sub||hitTxt};
  const pct=Math.round(v.p*100),k=v.p>=0.55?"WINNING":v.p<=0.45?"LOSING":"NEUTRAL";
  return{cls:k,txt:`${v.approx?"≈":""}${pct}%`,
    sub:v.approx?`${hitTxt} · approx.`:(v.sub||"")}}
function legsHit(ls){const h=ls.filter(x=>x.s==="WON").length,lv=ls.filter(x=>x.s!=="WON"&&x.s!=="LOST").length;
  return`${h}/${ls.length} legs hit${lv&&h<ls.length?` · ${lv} live`:""}`}
function pillHTML(b,status,legStats){const q=pillState(b,status,legStats);
  return`<span class="pillw"><span class="pill ${cls(q.cls)}" data-pill>${esc(q.txt)}</span><small class="psub" data-psub>${esc(q.sub)}</small></span>`}

// ---------- expanded-card live detail (data from the ESPN scoreboard we already poll) ----------
const UNIT={"baseball/mlb":"runs","hockey/nhl":"goals"};
const unitOf=m=>UNIT[m&&m.path]||"pts";
const pl=(n,u)=>`${n} ${n===1?u.replace(/s$/,""):u}`;
function needLine(L,m,g){if(!g||g.state!=="in")return"";const u=unitOf(m),sc=g.teams.map(t=>Number(t.score||0)),tot=sc[0]+sc[1];
  if(L.type==="total"){const d=L.line-tot;
    if(L.side==="under")return d>0?`Under ${L.line}: ${tot} so far, ${+d.toFixed(1)} to spare`:d===0?`Under ${L.line}: ${tot} so far, at the line (push)`:`Under ${L.line}: ${tot} so far, over by ${+(-d).toFixed(1)}`;
    if(d<0)return`Over ${L.line}: ${tot} so far, already over`;const need=Math.floor(d)+1;return`Over ${L.line}: ${tot} so far, needs ${pl(need,u)} more`}
  if(L.type==="teamtotal"){const pt=pickTeam(g,L);if(!pt)return"";const v=Number(pt.T.score||0),nm=pt.T.nick||pt.T.short||pt.T.abbr;
    if(L.side==="under")return v>L.line?`${nm} under ${L.line}: ${v} so far, over by ${+(v-L.line).toFixed(1)}`:`${nm} under ${L.line}: ${v} so far, ${Math.ceil(L.line)-1-v} to spare`;
    return v>L.line?`${nm} over ${L.line}: ${v} so far, already over`:`${nm} over ${L.line}: ${v} so far, needs ${pl(Math.floor(L.line)+1-v,u)} more`}
  const pt=pickTeam(g,L);if(!pt)return"";const mine=Number(pt.T.score||0),th=Number(pt.O.score||0),mg=mine-th,nm=pt.T.abbr||pt.T.short;
  if(L.type==="ml")return`ML: ${mg>0?`${nm} leading by ${mg}`:mg<0?`${nm} trailing by ${-mg}`:"tied"}`;
  if(L.type==="spread"){const ln=L.line,cur=mg+ln,cs=(mg>0?"+":mg<0?"−":"")+Math.abs(mg);
    const cond=ln>0?(Number.isInteger(ln)?`lose by <${ln} or win (${ln} = push)`:`lose by ≤${Math.floor(ln)} or win`):(Number.isInteger(-ln)?`win by ${-ln+1}+ (${-ln} = push)`:`win by ${Math.ceil(-ln)}+`);
    const st=cur>0?`covering by ${+cur.toFixed(1)}`:cur===0?"push right now":`needs ${pl(Math.floor(-cur)+1,u)}`;
    return`Needs ${nm} to ${cond}: currently ${cs} → ${st}`}
  return""}
function lineScore(g){const n=Math.max(...g.teams.map(t=>(t.ls||[]).length));if(!n)return"";const o=[...g.teams].sort((a,b)=>a.home-b.home);
  const hd=Array.from({length:n},(_,i)=>`<th>${i+1}</th>`).join("");
  return`<table class="lsc"><tr><th></th>${hd}<th>T</th></tr>${o.map(t=>`<tr><td>${esc(t.abbr)}</td>${Array.from({length:n},(_,i)=>`<td>${esc(t.ls[i]??"")}</td>`).join("")}<td><b>${esc(t.score)}</b></td></tr>`).join("")}</table>`}
function diamond(si){const f=k=>si[k]?"#f5c542":"none";
  return`<svg class="dia" viewBox="0 0 40 30" width="40" height="30"><g stroke="#aaa" stroke-width="1.5"><rect x="25" y="13" width="8" height="8" transform="rotate(45 29 17)" fill="${f("onFirst")}"/><rect x="16" y="4" width="8" height="8" transform="rotate(45 20 8)" fill="${f("onSecond")}"/><rect x="7" y="13" width="8" height="8" transform="rotate(45 11 17)" fill="${f("onThird")}"/></g></svg>`}
function sportChips(m,g){const si=g.sit||{},T=g.teams,ab=id=>{const t=T.find(t=>String(t.id)===String(id));return t?t.abbr:""};
  const H=T.find(t=>t.home),A=T.find(t=>!t.home),out=[];
  if(/^football/.test(m.path)){
    if(si.possession&&si.down>0)out.push(`<b>${esc(ab(si.possession))} ball</b> · ${esc(si.downDistanceText||si.shortDownDistanceText||"")}`);
    else if(si.possessionText)out.push(esc(si.possessionText));
    if(si.isRedZone&&si.down>0)out.push(`<span class="rz">RED ZONE</span>`);
    if(si.homeTimeouts!=null)out.push(`TOs ${esc(A.abbr)} ${esc(si.awayTimeouts)} · ${esc(H.abbr)} ${esc(si.homeTimeouts)}`)}
  else if(m.path==="baseball/mlb"){
    if(si.balls!=null)out.push(`${diamond(si)}<span class="cnt">${esc(si.balls)}-${esc(si.strikes)}, ${esc(si.outs)} out${si.outs===1?"":"s"}</span>`);
    if(si.batter||si.pitcher)out.push(`<span>AB ${esc(si.batter?si.batter.n:"?")}${si.batter&&si.batter.s?` <small>(${esc(si.batter.s)})</small>`:""} vs P ${esc(si.pitcher?si.pitcher.n:"?")}${si.pitcher&&si.pitcher.s?` <small>(${esc(si.pitcher.s)})</small>`:""}</span>`)}
  else if(m.path==="hockey/nhl"){
    const sog=t=>{const o=T.find(x=>x!==t);const sv=Number((o.st||{}).saves),gl=Number(t.score||0);return isNaN(sv)?null:sv+gl};
    if(sog(A)!=null)out.push(`SOG ${esc(A.abbr)} ${sog(A)} · ${esc(H.abbr)} ${sog(H)}`);
    const pp=Object.entries(si).find(([k,v])=>/power ?play|strength/i.test(k)&&v);const lp=String(g.lastPlay||"");
    if(pp)out.push(`<span class="rz">PP ${esc(typeof pp[1]==="string"?pp[1]:"")}</span>`);else if(/power play/i.test(lp))out.push(`<span class="rz">Power play</span>`);
    if(Object.entries(si).some(([k,v])=>/empty/i.test(k)&&v)||/empty net/i.test(lp))out.push(`<span class="rz">Empty net</span>`)}
  else if(m.path==="basketball/nba"){
    if(si.homeTimeouts!=null)out.push(`TOs ${esc(A.abbr)} ${esc(si.awayTimeouts)} · ${esc(H.abbr)} ${esc(si.homeTimeouts)}`);
    for(const[k,v]of Object.entries(si))if(/fouls|bonus/i.test(k))out.push(esc(`${k.replace(/([A-Z])/g," $1").toLowerCase()}: ${typeof v==="object"?(v.bonusState||v.teamFouls||JSON.stringify(v)):v}`))}
  return out.length?`<div class="chips">${out.map(x=>`<span>${x}</span>`).join("")}</div>`:""}
// ---------- more live fun: your players' stat lines, a play-by-play ticker, win-chance swing, live P&L ----------
const STATLINE={"hockey/nhl":[["goals","G"],["assists","A"],["shotsTotal","SOG"],["hits","HIT"],["plusMinus","+/-"]],
  "basketball/nba":[["points","PTS"],["rebounds","REB"],["assists","AST"],["threePointFieldGoalsMade","3PM"],["steals","STL"],["blocks","BLK"]],
  "basketball/wnba":[["points","PTS"],["rebounds","REB"],["assists","AST"],["threePointFieldGoalsMade","3PM"]],
  "football/nfl":[["passingYards","PASS"],["passingTouchdowns","PTD"],["rushingYards","RUSH"],["rushingTouchdowns","RTD"],["receptions","REC"],["receivingYards","RECYD"],["receivingTouchdowns","RTD"]],
  "football/college-football":[["passingYards","PASS"],["rushingYards","RUSH"],["receptions","REC"],["receivingYards","RECYD"]],
  "baseball/mlb":[["hits","H"],["runs","R"],["RBIs","RBI"],["homeRuns","HR"],["strikeouts","K"],["p_strikeouts","K"]],
  soccer:[["totalGoals","G"],["goalAssists","A"],["totalShots","SH"],["shotsOnTarget","SOT"],["foulsCommitted","FC"],["foulsSuffered","FD"],["saves","SV"],["yellowCards","YC"]]};
function athOf(L,S){const ath=athletesOf(S);let c=L.pid?ath.filter(a=>String(a.id)===String(L.pid)):[];
  if(!c.length)c=ath.filter(a=>playerMatch(L.pname||L.player,a.name)&&(!L.pteam||!a.team||a.team===L.pteam));
  if(c.length>1){const ib=c.filter(a=>a.inBox);if(ib.length)c=ib}return c[0]||null}
const surname=n=>(String(n||"").trim().split(/\s+/).pop()||"").toLowerCase();
// each prop leg's player with the full live stat line, plus "closest to hitting" for parlays
function playersHTML(b,legStats){const rows=[],need=[];
  legStats.forEach(x=>{const L=x.L;if(L.type!=="prop"||!x.g||x.g.state==="pre")return;const m=matchOfLeg(b,L),S=m&&summaries[m.id];if(!S)return;
    const A=athOf(L,S);if(!A)return;const cfg=STATLINE[S.path]||(SOCCER(S.path)?STATLINE.soccer:[]),seen=new Set(),chips=[];
    for(const[k,lab]of cfg){const v=A.s[k];if(v==null||seen.has(lab))continue;seen.add(lab);chips.push(`<span${(x.pt!=null&&PROP[L.stat]&&PROP[L.stat][1]===lab)?' class="hl"':""}>${esc(lab)} <b>${esc(v)}</b></span>`)}
    const st=x.s==="WON"?"✓":x.s==="LOST"?"✗":x.pt!=null&&x.pv!=null?`${Math.max(0,x.pt-x.pv)} to go`:"";
    rows.push(`<div class="pl"><div class="pn">${esc(A.name)}<small> ${esc(A.team||"")}</small><i class="${x.s==="WON"?"pos":x.s==="LOST"?"neg":""}">${esc(st)}</i></div><div class="pc">${chips.join("")||'<span class="pm">no stats yet</span>'}</div></div>`);
    if(x.s!=="WON"&&x.s!=="LOST"&&x.pt!=null&&x.pv!=null)need.push({n:A.name.split(" ").pop(),r:Math.max(0,x.pt-x.pv),f:(x.pv/Math.max(1e-9,x.pt))})});
  if(!rows.length)return"";
  let sum="";if(need.length>1){need.sort((a,c)=>c.f-a.f);const a=need[0],z=need[need.length-1];sum=`<div class="pk">Closest: <b>${esc(a.n)}</b> (${a.r} to go) · Furthest: <b>${esc(z.n)}</b> (${z.r} to go)</div>`}
  return`<div class="plr"><div class="pt">Your players</div>${rows.join("")}${sum}</div>`}
// last plays of every live game on the bet, newest first; plays by your own players are highlighted
function playsOf(d){if(!d)return[];if(Array.isArray(d.plays)&&d.plays.length)return d.plays;
  const dr=d.drives||{},all=[].concat(dr.previous||[],dr.current?[dr.current]:[]);return[].concat(...all.map(x=>x.plays||[]))}
function tickerHTML(b,legStats){const mine=new Set(b.legs.filter(L=>L.type==="prop").map(L=>surname(L.pname||L.player)).filter(Boolean)),seen=new Set(),out=[];
  for(const x of legStats){const m=matchOfLeg(b,x.L),g=x.g;if(!m||!g||g.state!=="in"||seen.has(m.id))continue;seen.add(m.id);const S=summaries[m.id];if(!S)continue;
    const pl=playsOf(S.d).filter(p=>p&&p.text&&!/^(goalie stopped|stoppage|period start|game start)$/i.test(p.text)&&!(p.type&&/^face[ -]?off$/i.test(p.type.text||"")));
    const multi=legStats.some(y=>matchOfLeg(b,y.L)&&matchOfLeg(b,y.L).id!==m.id);
    if(multi)out.push(`<div class="tg">${esc(g.teams.map(t=>t.abbr).join(" @ "))}</div>`);
    for(const p of pl.slice(-6).reverse()){const per=p.period&&(p.period.displayValue||p.period.number)||"",clk=p.clock&&p.clock.displayValue||"";
      const hit=[...mine].some(n=>n&&String(p.text).toLowerCase().includes(n)),sc=p.scoringPlay;
      out.push(`<li class="${hit?"mine":""}${sc?" sc":""}"><time>${esc(per)}${clk?" "+esc(clk):""}</time>${sc?"★ ":""}${esc(p.text)}</li>`)}}
  const li=out.join("");return li?`<div class="tick"><div class="pt">Play by play</div><ul>${li}</ul></div>`:""}
// win-chance swing vs ~5 minutes ago (history only builds while this page is open)
function swingText(k){const h=PHIST[k]||[];if(h.length<2)return"";const now=h[h.length-1];let ref=h[0];for(const x of h)if(x.t<=now.t-300000)ref=x;
  const mins=(now.t-ref.t)/60000;if(mins<0.5)return"";const d=(now.p-ref.p)*100;
  return Math.abs(d)<1?`flat over ${mins<1?"<1":Math.round(mins)} min`:`${d>0?"▲ +":"▼ −"}${Math.abs(d).toFixed(0)} pts in ${mins<1?"<1":Math.round(mins)} min`}
const swingCls=t=>/^▲/.test(t)?"pos":/^▼/.test(t)?"neg":"";
// live P&L over bets that are in progress right now
function livePL(){const el=$("livepl");if(!el||!DATA)return;let n=0,win=0,lose=0,exp=0,tbc=0;
  DATA.open.forEach((b,i)=>{const lv=betLive(b,LAST_STATUS[i]||"?",legStatsFor(b));if(lv.final||lv.upcoming)return;n++;
    const S=b.cash_stake||0,W=b.payout!=null?b.payout-S:null;if(W==null){tbc++;return}
    win+=W;lose+=S;const p=lv.p;if(p==null){tbc++;exp+=0;return}exp+=p*W-(1-p)*S});
  if(!n){el.innerHTML="";return}
  const sg=v=>(v>=0?"+":"−")+money(Math.abs(v));
  el.innerHTML=`<div class="lpl"><div>${n} live bet${n===1?"":"s"}</div><div>If all hit<b class="pos">${sg(win)}</b></div><div>If all bust<b class="neg">${sg(-lose)}</b></div><div>Expected ≈<b class="${exp>=0?"pos":"neg"}">${sg(exp)}</b></div></div>${tbc?`<div class="meta" style="margin:-2px 2px 6px">${tbc} bet${tbc===1?"":"s"} not counted (no payout or win chance yet)</div>`:""}`}
function liveDetail(b,legStats){const seen=new Set(),parts=[];
  const legs=b.legs.map(L=>({L,m:matchOfLeg(b,L)})).filter(x=>x.m);
  const nh=needsHTML(b);if(nh)parts.push(`<div class="need" data-need>${nh}</div>`);
  for(const{m}of legs){const g=gameFor(m);if(!g||g.state!=="in"||seen.has(g.id))continue;seen.add(g.id);
    parts.push(sportChips(m,g)+lineScore(g)+(g.lastPlay?`<div class="lastp">Last: ${esc(g.lastPlay)}</div>`:""))}
  if(parts.length){parts.push(playersHTML(b,legStats));parts.push(tickerHTML(b,legStats))}
  return parts.length?`<div class="ldet">${parts.join("")}</div>`:""}
// p history for the sparkline (client-side, since this page opened)
const PHIST={};
function recordP(k,p){if(p==null||isNaN(p))return;const h=PHIST[k]||(PHIST[k]=[]);const now=Date.now(),last=h[h.length-1];
  if(last&&now-last.t<10000){if(h.length>1)last.p=p;return}h.push({t:now,p});if(h.length>400)h.shift()}
function sparkSVG(k){const h=PHIST[k]||[];if(h.length<2)return`<span class="spk-empty">p history builds while this page is open</span>`;
  const W=150,Hh=26,t0=h[0].t,t1=h[h.length-1].t||t0+1,pts=h.map(x=>`${((x.t-t0)/Math.max(1,t1-t0)*W).toFixed(1)},${((1-x.p)*Hh).toFixed(1)}`).join(" ");
  const last=h[h.length-1].p,col=last>=0.5?"var(--win)":"var(--lose)";const mins=Math.round((t1-t0)/60000);
  return`<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" class="spk"><line x1="0" x2="${W}" y1="${Hh/2}" y2="${Hh/2}" stroke="#555" stroke-dasharray="2 3"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6"/></svg><span class="spk-l">${Math.round(h[0].p*100)}% → ${Math.round(last*100)}% · ${mins?mins+" min":"<1 min"}</span>`}
function legStatsFor(b){return b.legs.map(L=>{const m=b.match||L.match,g=gameFor(m);return{L,g,...legStatus(L,g,b.sport,m&&m.id)}})}
const pcol=p=>p>=0.55?"var(--win)":p<=0.45?"var(--lose)":"var(--push)";
function legBar(b,x,p){const L=x.L,g=x.g;if(!g||g.state==="pre"||(g.state==="post"&&!g.completed))return"";
  const done=x.s==="WON"?1:x.s==="LOST"?0:null,col=done===1?"var(--win)":done===0?"var(--lose)":p!=null?pcol(p):"var(--push)";
  let fill=null,txt="";const under=L.op==="under"||L.side==="under";
  if(L.type==="prop"&&x.pv!=null&&x.pt!=null){fill=under?x.pv/Math.max(1e-9,x.pt):x.pv/x.pt;txt=under?`${x.pv} of max ${Math.ceil(x.pt)-1}`:`${x.pv}/${x.pt}${x.unit?" "+x.unit:""}`}
  else if((L.type==="total"||L.type==="teamtotal")&&x.pv!=null){const tg=under?Math.ceil(L.line)-1:Math.floor(L.line)+1;fill=x.pv/Math.max(1,tg);txt=under?`${x.pv} of max ${tg}`:`${x.pv}/${tg}`}
  else if(p!=null){fill=p;txt=""}
  if(fill==null)return"";fill=Math.max(0,Math.min(1,fill));
  const lab=done===1?"✓":done===0?"✗":p!=null?`${Math.round(p*100)}% to hit`:"";
  return`<div class="lbar" title="${esc(txt)}"><div class="lt"><div class="lf" style="width:${(fill*100).toFixed(1)}%;background:${col}"></div></div><small>${esc(lab)}</small></div>`}
function legChip(b,x){const g=x.g,live=g&&g.state==="in";let lbl=x.lbl||x.s,p=null;
  if(live&&!["WON","LOST"].includes(x.s)){p=legP(b,x.L,x.s,x);if(p!=null&&x.s!=="PUSH")lbl=p>=0.55?"WINNING":p<=0.45?"LOSING":"NEUTRAL"}
  const c=lbl==="HIT"?"WON":lbl==="MISSED"?"LOST":lbl;return{lbl,c,p,txt:p!=null&&["WINNING","LOSING","NEUTRAL"].includes(lbl)?Math.round(p*100)+"%":lbl}}
function legRowInner(b,x){const ch=legChip(b,x);
  return`<span class="lgt">${esc(x.L.text)}${x.n?` <span class="meta">· ${esc(x.n)}</span>`:""}${!b.match&&x.g?`<br><span class="meta">${x.g.teams.map(t=>esc(t.abbr||t.name)+" "+(x.g.state==="pre"?"":esc(t.score))).join(" – ")} · ${esc(x.g.state==="pre"?fmtStart(x.g):x.g.detail)}</span>`:""}${legBar(b,x,ch.p)}</span><span class="pill ${cls(ch.c)}">${esc(ch.txt)}</span>`}
function needsHTML(b){return b.legs.map(L=>{const m=matchOfLeg(b,L);return m?needLine(L,m,gameFor(m)):""}).filter(Boolean).map(esc).join("<br>")}
const setHTML=(el,h)=>{if(el&&el.innerHTML!==h)el.innerHTML=h};
// group cards/rows by book A–Z (case-insensitive, stable within a book) under a 'Book ($staked)' subheader
const bkey=b=>String(b||"?").toLowerCase();
// Book headings A-Z; inside each book the soonest start first, futures (no start time) last.
// splitStarted (Upcoming only): bets whose start time has already passed but have no result yet are listed AFTER the
// upcoming ones under their own label, so "soonest to latest" is not buried under last night's unsettled bets.
function byBook(items,splitStarted){
  const now=Date.now(),started=x=>!!splitStarted&&x.ts!=null&&x.ts<now;
  const s=items.map((x,i)=>({...x,i,st:started(x)})).sort((a,c)=>bkey(a.book).localeCompare(bkey(c.book))||(a.st-c.st)||((a.ts==null)-(c.ts==null))||(a.ts-c.ts)||a.i-c.i),tot={},nst={};
  s.forEach(x=>{const k=bkey(x.book);tot[k]=(tot[k]||0)+(x.stake||0);if(x.st)nst[k]=(nst[k]||0)+1});
  let out="",cur=null,sub=false;
  for(const x of s){const k=bkey(x.book);
    if(k!==cur){cur=k;sub=false;out+=`<div class="bkh">${esc(x.book||"?")} <b>(${money(tot[k])})</b></div>`}
    if(x.st&&!sub){sub=true;out+=`<div class="bkh sub">Started, no result yet <b>(${nst[k]})</b></div>`}
    out+=x.html}
  return out}
// Upcoming: one list, soonest start first, then app/book A-Z (case-insensitive), then original order; no start time last.
// Started-but-no-result bets still follow under their own label (same ordering inside).
function byStart(items){
  const now=Date.now(),cmp=(a,c)=>((a.ts==null)-(c.ts==null))||((a.ts||0)-(c.ts||0))||bkey(a.book).localeCompare(bkey(c.book))||a.i-c.i;
  const s=items.map((x,i)=>({...x,i,st:x.ts!=null&&x.ts<now})),up=s.filter(x=>!x.st).sort(cmp),gone=s.filter(x=>x.st).sort(cmp);
  return up.map(x=>x.html).join("")+(gone.length?`<div class="bkh sub">Started, no result yet <b>(${gone.length})</b></div>`+gone.map(x=>x.html).join(""):"")}
const setStake=s=>s.stake!=null?s.stake:(s.pnl!=null&&s.pnl<0?-s.pnl:0);
// re-render every leg row / status chip / bar / "needs" line of every card (collapsed or open) from the latest data
function refreshLegs(){if(!DATA)return;document.querySelectorAll(".card[data-bi]").forEach(c=>{const b=DATA.open[+c.dataset.bi];if(!b)return;const ls=legStatsFor(b);
  ls.forEach((x,i)=>setHTML(c.querySelector(`.leg[data-li="${i}"]`),legRowInner(b,x)));
  const n1=c.querySelector("[data-n1]");if(n1&&ls[0])setHTML(n1,(ls[0].n?esc(ls[0].n):"")+legBar(b,ls[0],ls[0].g&&ls[0].g.state==="in"?legP(b,ls[0].L,ls[0].s,ls[0]):null));
  const nd=c.querySelector("[data-need]");if(nd)setHTML(nd,needsHTML(b));
  LAST_STATUS[+c.dataset.bi]=b.multi?combine(ls.map(x=>x.s)):(ls[0]?ls[0].s:"?")})}
function tick1s(){if(!DATA||document.hidden)return;refreshLegs();
  document.querySelectorAll(".card[data-bi]").forEach(c=>{const b=DATA.open[+c.dataset.bi];if(!b)return;const ls=legStatsFor(b);
    const st=LAST_STATUS[+c.dataset.bi]||"?",q=pillState(b,st,ls),pe=c.querySelector("[data-pill]");if(!pe)return;
    pe.textContent=q.txt;pe.className="pill "+cls(q.cls);c.querySelector("[data-psub]").textContent=q.sub;
    const lv=betLive(b,st,ls);if(!lv.final&&!lv.upcoming&&lv.p!=null){recordP(c.dataset.k,lv.p);const sp=c.querySelector("[data-spk]");if(sp&&c.classList.contains("open"))sp.innerHTML=sparkSVG(c.dataset.k);const sw=c.querySelector("[data-swing]");if(sw){const t=swingText(c.dataset.k);sw.textContent=t;sw.className="swing "+swingCls(t)}}
    c.classList.remove("WINNING","LOSING","NEUTRAL","LIVE","TIED","PUSH","WON","LOST","NOT_STARTED");c.classList.add(cls(q.cls))});
  document.querySelectorAll("[data-clk]").forEach(el=>{const g=games[el.dataset.clk];if(g)el.textContent=clockText(g,el.dataset.sep||" ")});
  document.querySelectorAll(".card[data-bi]").forEach(c=>{const b=DATA.open[+c.dataset.bi];if(!b)return;let first=null;
    c.querySelectorAll(".wp.est[data-leg]").forEach(w=>{const L=b.legs[+w.dataset.leg],m=matchOfLeg(b,L),g=gameFor(m);if(!g)return;
      const v=estLeg(L,m,localGame(g,m));if(v==null)return;const pct=Math.max(0,Math.min(100,v*100));if(first==null)first=pct;
      const col=pct>50?"var(--win)":pct<50?"var(--lose)":"var(--push)";const f=w.querySelector(".fill");f.style.width=pct+"%";f.style.background=col;
      w.querySelector(".lbl b").textContent=pct.toFixed(1)+"%"});
    if(!b.multi&&b.legs[0]){const src=legSources(b,b.legs[0]);if(src.length)first=src[0].v*100;const se=c.querySelector("[data-src]");if(se&&src.length)se.textContent=SRC_LBL[src[0].k]}
    const pls=c.querySelectorAll(".wp.prp");if(pls.length){const ls=legStatsFor(b),setW=(w,v)=>{const pct=Math.max(0,Math.min(100,v*100)),f=w.querySelector(".fill");f.style.width=pct+"%";f.style.background=pct>50?"var(--win)":pct<50?"var(--lose)":"var(--push)";w.querySelector(".lbl b").textContent=pct.toFixed(1)+"%";return pct};
      pls.forEach(w=>{if(w.dataset.pbet){const lv=betLive(b,LAST_STATUS[+c.dataset.bi]||"?",ls);if(lv&&lv.p!=null){const pct=setW(w,lv.p);if(first==null)first=pct}}
        else{const i=+w.dataset.pleg,x=ls[i];if(!x)return;const v=legP(b,x.L,x.s,x);if(v!=null){const pct=setW(w,v);if(!b.multi&&first==null)first=pct}}})}
    const mini=c.querySelector(".mini");if(mini&&(!b.multi||c.querySelector(".wp.prb"))&&first!=null){mini.style.width=first+"%";mini.style.background=first>50?"var(--win)":first<50?"var(--lose)":"var(--push)"}});
  // probability-weighted payout (estimate): every unsettled bet contributes (implied-price fallback); bets with no payout/price are TBC
  let exp=0,tbc=0;const U=DATA.unsettled||{};
  DATA.open.forEach((b,i)=>{const pay=b.payout;if(pay==null){tbc++;return}
    const cs=b.cash_stake||0;let p=payoutP(b,LAST_STATUS[i]);if(p==null)p=impliedP(b);if(p==null){tbc++;return}
    exp+=p==="push"?cs:pay*p});
  try{livePL()}catch(e){}
  for(const f of LiveUI.tick){try{f()}catch(e){}}   // ui-*.js per-second hooks
  const ep=$("expPay"),el=$("expPL");if(ep){ep.textContent=moneyC(U.max_payout);$("expSub").textContent=`${U.n!=null?U.n:DATA.open.length} bet${(U.n!=null?U.n:DATA.open.length)===1?"":"s"} · expected ≈ ${moneyC(exp)} (est.)${tbc?` · ${tbc} TBC`:""}`}
  if(el){const v=exp-(U.cash_stake||0);el.textContent=(v>=0?"+":"−")+money(Math.abs(v));el.className=v>=0?"pos":"neg"}}
setInterval(tick1s,1000);
function bar(label,v,cls2,note,attr){v=Math.max(0,Math.min(100,v));const col=v>50?"var(--win)":v<50?"var(--lose)":"var(--push)";
  return`<div class="wp ${cls2||""}" ${attr||""}><div class="lbl"><span>${label}</span><b>${v.toFixed(1)}%</b></div><div class="track"><div class="fill" style="width:${v}%;background:${col}"></div></div>${note?`<div class="note">${note}</div>`:""}</div>`}
const EST_NOTE="Est. = our own estimate from Pinnacle pregame no-vig prices + the live score/clock. Not an ESPN or sportsbook number.";
// all bars for a card + the single value used for the collapsed row
function pmBar(L,m,g,ctx){const q=pmVal(L,m,g);if(!q)return"";const live=g.state==="in",wide=q.spread!=null&&q.spread>0.1;
  const what=L.type==="draw"?"Draw":L.type==="ml"?`${esc(pickTeam(g,L).T.abbr)} win`:`${esc(L.text)} (same line)`;
  const note=`Polymarket mid${q.spread!=null?` · spread ${(q.spread*100).toFixed(1)}¢`:""}${wide?" · thin market, not used":""}${!live?" · pregame":""}${L.type!=="ml"&&L.type!=="draw"?" · display only":""}`;
  return bar(`Polymarket${ctx||""} · ${what}`,q.mid*100,"pmb",note)}
// Kalshi (free prediction market) moneyline, pulled server-side at the last build, so pregame only
// live: the GitHub live loop pushes fresh Kalshi prices to the live-feed branch every ~20 s; the page reads them via the contents API
// (needs the saved GitHub token for a 20 s poll; without it the API's anonymous limit allows about one read a minute)
const KLIVE={games:{},t:0},KLIVE_URL="https://api.github.com/repos/s-chuch/bet-dashboard/contents/kalshi.json?ref=live-feed";let KLIVE_AT=0;
async function refreshKalshi(){let tok="";try{tok=localStorage.getItem("bt.gh.settle")||""}catch(e){}
  if(!DATA||Date.now()-KLIVE_AT<(tok?18000:70000))return;
  if(!allMatches().some(m=>{const g=gameFor(m);return g&&g.state==="in"}))return;KLIVE_AT=Date.now();
  try{const r=await tfetch(KLIVE_URL,{cache:"no-store",headers:{Accept:"application/vnd.github.raw",...(tok?{Authorization:"Bearer "+tok}:{})}});if(!r.ok)throw 0;
    const j=await r.json();KLIVE.games=j.games||{};KLIVE.t=Date.parse(j.t)||0;FEED.kal={ok:Date.now()}}catch(e){FEED.kal={bad:"no live feed yet"}}}
function kalBar(L,m,g,ctx){if(L.type!=="ml"||!m||!g)return"";const pt=pickTeam(g,L);if(!pt)return"";
  if(g.state==="in"){const k=KLIVE.games[m.id],age=(Date.now()-KLIVE.t)/1000;if(!k||!KLIVE.t||age>300)return"";const v=pt.T.home?k.home:k.away;if(v==null)return"";
    return bar(`Kalshi${ctx||""} · ${esc(pt.T.abbr)} win`,v*100,"kab",`Kalshi mid price, no-vig · live · ${age<90?Math.round(age)+" s":Math.round(age/60)+" min"} old`)}
  if(g.state!=="pre"||!m.kal)return"";const v=pt.T.home?m.kal.home:m.kal.away;if(v==null)return"";
  return bar(`Kalshi${ctx||""} · ${esc(pt.T.abbr)} win`,v*100,"kab",`Kalshi mid price, no-vig · pregame · as of ${tfmt(m.kal.t)}`)}
// book-line bar (no-vig) for the leg, from ESPN's scoreboard odds; exact line only for spreads / totals
function lineBar(L,m,g,ctx){const od=g&&g.odds;if(!od||g.completed||g.state==="post")return"";const nv=(a,b)=>{const x=ip(a),y=ip(b);return x/(x+y)};let v=null,what="";
  if(L.type==="draw"&&od.ml&&od.ml.d!=null){v=ip(od.ml.d)/(ip(od.ml.h)+ip(od.ml.a)+ip(od.ml.d));what="Draw"}else
  if(L.type==="ml"&&od.ml){const pt=pickTeam(g,L);if(!pt)return"";const mine=pt.T.home?od.ml.h:od.ml.a,opp=pt.T.home?od.ml.a:od.ml.h;
    v=od.ml.d!=null?ip(mine)/(ip(mine)+ip(opp)+ip(od.ml.d)):nv(mine,opp);what=`${esc(pt.T.abbr)} win${od.ml.d!=null?" (not draw)":""}`}
  else if(L.type==="spread"&&od.sp){const pt=pickTeam(g,L);if(!pt)return"";const line=pt.T.home?od.sp.h:-od.sp.h;if(Math.abs(line-L.line)>0.01)return"";
    v=pt.T.home?nv(od.sp.ho,od.sp.ao):nv(od.sp.ao,od.sp.ho);what=`${esc(L.text)} covers`}
  else if(L.type==="total"&&od.tot&&Math.abs(od.tot.line-L.line)<0.01){v=L.side==="under"?nv(od.tot.u,od.tot.o):nv(od.tot.o,od.tot.u);what=`${esc(L.text)} hits`}
  if(v==null)return"";
  return bar(`${esc(od.prov)}${ctx||""} · ${what}`,v*100,"lnb",`${esc(od.prov)} line via ESPN, vig removed${g.state==="in"?" · may be stale once live":""}`)}
function booksBar(L,m,g,ctx){if(g.state!=="in")return"";const bp=booksP(L,m,g);if(!bp)return"";
  const what=L.type==="ml"?`${esc(pickTeam(g,L).T.abbr)} win`:L.type==="spread"?`${esc(L.text)} covers`:`${esc(L.text)} hits`;
  return bar(`Books (no-vig)${ctx||""} · ${what}`,bp.v*100,"bkb",`${bp.book===15?"Action Network consensus":BKN[bp.book]} live line, vig removed${L.type!=="ml"?" · at your exact line":""}`)}
function liveLine(L,m,g){if(!g||g.state!=="in")return"";const t=anText(L,m,g);return t?`<div class="aln">${esc(t)}</div>`:""}
// all bars for a card + the single value used for the collapsed row (top-priority source)
function barsFor(b){const out=[];let mini=null;
  if(isFuture(b)){const fb=futBar(b);return{html:fb,mini:fb?(PMMID[(PMF[cardKey(b)]||{}).token]||{mid:null}).mid*100:null}}
  const p=probFor(b);
  const espnBar=()=>p?bar(`ESPN · ${esc(p.label)}`,p.pct,"",p.ml?(p.kind==="pregame"?"ESPN pregame predictor":"ESPN live win probability"):(b.multi?"ESPN game-win chance for that team only, not the parlay's chance":"ESPN chance to win the game, not to cover")):"";
  const estOf=(L,i,lbl)=>{const m=matchOfLeg(b,L),g=gameFor(m);if(!g||g.completed)return"";const v=estLeg(L,m,localGame(g,m));return v==null?"":bar(lbl,v*100,"est","",`data-leg="${i}"`)};
  if(!b.multi){const L=b.legs[0];if(L){const m=matchOfLeg(b,L),g=gameFor(m);
      if(g&&!g.completed){out.push(liveLine(L,m,g));
        out.push(pmBar(L,m,g));out.push(kalBar(L,m,g));out.push(lineBar(L,m,g));out.push(sofaBar(L,m,g));out.push(booksBar(L,m,g));
        out.push(estOf(L,0,L.type==="ml"?"Est. win":L.type==="spread"?`Est. cover ${esc(L.text)}`:`Est. ${esc(L.text)} hits`));
        const src=legSources(b,L);if(src.length){mini=src[0].v*100;out.push(`<div class="note srcn">Pill &amp; payout use: <b data-src>${SRC_LBL[src[0].k]}</b></div>`)}}}
    if(!out.some(x=>/wp (pmb|bkb|lnb|sfb)/.test(x)))out.push(espnBar())}
  else{b.legs.forEach((L,i)=>{const m=matchOfLeg(b,L),g=gameFor(m);if(!g||g.completed)return;const ctx=` · ${esc(L.text)}`;
      out.push(liveLine(L,m,g));out.push(pmBar(L,m,g,` leg`));out.push(kalBar(L,m,g,` leg`));out.push(lineBar(L,m,g,` leg`));out.push(sofaBar(L,m,g,` leg`));out.push(booksBar(L,m,g,` leg`));
      out.push(estOf(L,i,`Est. leg: ${esc(L.text)}${L.type==="spread"?" covers":L.type==="ml"?" wins":" hits"}`))});
    if(!out.some(x=>/wp (pmb|bkb|lnb|sfb)/.test(x)))out.push(espnBar())}
  // player props / team totals have no market price: pace-based estimate per leg (+ one bar for the whole bet), live games only
  const PRP=new Set(["prop","teamtotal"]);
  if(b.legs.some(L=>PRP.has(L.type))){const ls=legStatsFor(b);let n=0;
    let preAll=[];
    b.legs.forEach((L,i)=>{const g=ls[i].g;if(!PRP.has(L.type)||!g)return;const live=g.state==="in";let v=null,pre=false;
      if(live)v=legP(b,L,ls[i].s,ls[i]);else if(g.state==="pre"&&L.type==="prop"){v=propPre(L,matchOfLeg(b,L));pre=v!=null}
      if(v==null)return;n++;out.push(bar(`Est. leg: ${esc(L.text)}${pre?" · season avg":""}`,v*100,"prp","",`data-pleg="${i}"`))});
    // pregame whole-bet estimate: every leg needs a number (props from season rates, game legs from the book-line model)
    const pregame=b.multi&&ls.every(x=>x.g&&x.g.state==="pre");
    if(pregame&&n){let pp=1;for(let i=0;i<b.legs.length&&pp!=null;i++){const L=b.legs[i],m=matchOfLeg(b,L),g=ls[i].g;let v=null;
        if(L.type==="prop")v=propPre(L,m);else if(L.type==="ml"||L.type==="spread"||L.type==="total"){if(!SOCCER(m.path))v=estLeg(L,m,g)}
        pp=v==null?null:pp*v}
      if(pp!=null){out.push(bar(`Est. whole bet · all ${b.legs.length} legs · pregame`,pp*100,"prp prb","",'data-pbetpre="1"'));if(mini==null)mini=pp*100}}
    if(n&&b.multi&&!pregame){const lv=betLive(b,LAST_STATUS[DATA.open.indexOf(b)]||"?",ls);if(lv&&lv.p!=null){out.push(bar(`Est. whole bet · all ${b.legs.length} legs`,lv.p*100,"prp prb","",'data-pbet="1"'));if(mini==null)mini=lv.p*100}}
    else if(n&&mini==null&&!b.multi){const x=ls[0],v=legP(b,x.L,x.s,x);if(v!=null)mini=v*100}
    if(n)out.push(`<div class="note" style="font-size:11px;color:var(--mut);margin-top:4px">Est. = our own estimate: live from stats so far and time left; pregame from the player's season average per game. No sportsbook prices exist for player props.</div>`)}
  if(out.some(x=>x.includes('wp est')))out.push(`<div class="note" style="font-size:11px;color:var(--mut);margin-top:4px">${EST_NOTE}</div>`);
  if(mini==null&&p)mini=p.pct;
  return{html:out.filter(Boolean).join(""),mini}}
const BOOKS={PointsBet:"PB",Caesars:"CZR",FanDuel:"FD",DraftKings:"DK",bet365:"365",theScore:"SCORE","Hard Rock":"HR",BetMGM:"MGM"};
const bookTag=b=>BOOKS[b]||b;
// CLV chip: price taken vs Pinnacle no-vig close (data/clv.csv via data.json). Hidden until a close was captured.
const clvTag=c=>c&&c.clv_pct!=null?` · <span class="${c.clv_pct>=0?"pos":"neg"}" title="Closing line value vs Pinnacle no-vig close ${esc(c.close_price||"")}">CLV ${c.clv_pct>=0?"+":""}${c.clv_pct.toFixed(1)}%</span>`:"";
const cardKey=b=>[b.date,b.book,b.event,b.pick].join("|");
let OPEN=new Set(), SECS=new Set(), FINSEEN=new Set(), FINAL_BI=new Set();
try{OPEN=new Set(JSON.parse(localStorage.getItem("bd_open")||"[]"));SECS=new Set(JSON.parse(localStorage.getItem("bd_secs")||"[]"));FINSEEN=new Set(JSON.parse(localStorage.getItem("bd_fin")||"[]"))}catch(e){}
const saveUI=()=>{try{localStorage.setItem("bd_open",JSON.stringify([...OPEN]));localStorage.setItem("bd_secs",JSON.stringify([...SECS]));localStorage.setItem("bd_fin",JSON.stringify([...FINSEEN].slice(-200)))}catch(e){}};
const fmtLine=v=>(v>0?"+":"")+v;
function shortLabel(b,g){
  const team=t=>{if(!g)return null;const i=sideIdx(g,t);return i<0?null:g.teams[i]};
  const aw=g&&g.teams.find(t=>!t.home),hm=g&&g.teams.find(t=>t.home), matchup=g?`${aw.abbr}/${hm.abbr}`:"";
  if(b.multi)return b.match?`SGP ${g?aw.abbr+" @ "+hm.abbr:""} · ${b.legs.length} legs`:`${b.legs.length}-leg parlay`;
  const L=b.legs[0];if(!L)return b.pick;
  if(L.type==="ml"){const t=team(L.team);return `${t?(t.nick||t.short||t.name):L.team} ML`}
  if(L.type==="spread"){const t=team(L.team);return `${t?t.abbr:L.team} ${fmtLine(L.line)}`}
  if(L.type==="total")return `${L.side==="under"?"U":"O"} ${L.line} ${matchup}`;
  if(L.type==="teamtotal"){const t=team(L.team);return `${t?t.abbr:L.team} TT ${L.side==="under"?"U":"O"}${L.line}`}
  return b.pick}
// fallback when no ESPN game is linked: show the logged start time ("Sat Oct 17 03:30 PM ET")
function rawStart(raw){if(!raw)return"";const m=String(raw).match(/^(\w{3}) (\w{3}) (\d{1,2}) 0?(\d{1,2}:\d{2}) ?([AP]M)/);
  if(!m)return `${esc(raw)}`;const now=new Date().toLocaleString("en-US",{timeZone:TZ,weekday:"short",month:"short",day:"numeric"});
  const today=now.startsWith(m[1])&&now.includes(m[2]+" "+m[3]);
  return `${today?"":m[1]+" "}${m[4]} ${m[5]}<small>${today?"Today":"Starts"} ET</small>`}
// plain-English "what has to happen for this bet to win"
function unitFor(sport){return {NHL:"goals",MLB:"runs",Soccer:"goals"}[sport]||"points"}
function needLeg(L,sport){if(!L)return"";const u=unitFor(sport),t=L.team;
  if(L.type==="draw")return"Match ends level (draw)";
  if(L.type==="ml")return `${t} win${sport==="Soccer"?" (no draw)":""}`;
  if(L.type==="spread"&&L.line!=null){if(L.line>0){const k=Math.ceil(L.line)-1;return k<=0?`${t} win or tie`:`${t} win, or lose by ${k} or fewer`}
    return `${t} win by ${Math.floor(-L.line)+1}+`}
  if(L.type==="total"&&L.line!=null){return L.side==="under"?`${Math.ceil(L.line)-1} or fewer total ${u}`:`${Math.floor(L.line)+1}+ total ${u}`}
  if(L.type==="teamtotal"&&L.line!=null){const tu=u==="points"?"pts":u;return L.side==="under"?`${t} ${Math.ceil(L.line)-1} or fewer ${tu}`:`${t} ${Math.floor(L.line)+1}+ ${tu}`}
  return L.text||""}
function needLines(b){const ls=b.legs.map(L=>needLeg(L,b.sport)).filter(Boolean);return ls.length?ls:[b.pick]}
function rowScore(b,g,legStats){
  const start=x=>{const d=new Date(x.date),today=etDay(Date.now())===etDay(x.date);
    return d.toLocaleString("en-US",{timeZone:TZ,...(today?{}:{weekday:"short"}),hour:"numeric",minute:"2-digit"})};
  const one=x=>{if(!x)return"";const aw=x.teams.find(t=>!t.home),hm=x.teams.find(t=>t.home);
    if(x.state==="pre")return `${start(x)}<small>${today(x)?"Today":"Starts"} ET</small>`;
    return `${esc(aw.abbr)} ${esc(aw.score)}–${esc(hm.score)} ${esc(hm.abbr)}<small>${x.completed?"Final":`${stIcon(x)}<span data-clk="${esc(x.id)}" data-sep=" ">${esc(clockText(x," "))}</span>`}</small>`};
  const today=x=>etDay(Date.now())===etDay(x.date);
  if(g)return one(g);
  const gs=legStats.map(x=>x.g).filter(Boolean);if(!gs.length)return rawStart(b.start);
  const live=gs.find(x=>x.state==="in");if(live)return one(live);
  const fin=gs.filter(x=>x.completed).length;
  if(fin===gs.length)return `${fin}/${b.legs.length} final<small>${legStats.filter(x=>x.s==="WON").length} won</small>`;
  const nx=gs.filter(x=>x.state==="pre").sort((a,c)=>new Date(a.date)-new Date(c.date))[0];return nx?one(nx):rawStart(b.start)}
function syncUI(){
  document.querySelectorAll(".card[data-k]").forEach(c=>c.classList.toggle("open",OPEN.has(c.dataset.k)));
  document.querySelectorAll(".sec.settled").forEach(s=>s.classList.toggle("open",SECS.has(s.id)));document.querySelectorAll(".sec.fold").forEach(s=>s.classList.toggle("shut",SECS.has("x-"+s.id)));
  document.querySelectorAll(".xall").forEach(bt=>{const cs=[...document.querySelectorAll(`#${bt.dataset.sec} .card[data-k]`)];
    bt.style.display=cs.length?"":"none";bt.textContent=cs.length&&cs.every(c=>OPEN.has(c.dataset.k))?"Collapse all":"Expand all"})}
document.addEventListener("click",e=>{
  const bt=e.target.closest(".xall");if(bt){const cs=[...document.querySelectorAll(`#${bt.dataset.sec} .card[data-k]`)];
    const all=cs.every(c=>OPEN.has(c.dataset.k));cs.forEach(c=>all?OPEN.delete(c.dataset.k):OPEN.add(c.dataset.k));
    if(!all&&bt.closest(".sec.settled"))SECS.add(bt.dataset.sec);saveUI();syncUI();return}
  const sh=e.target.closest(".sechead");if(sh&&sh.closest(".sec.fold")){const k="x-"+sh.dataset.sec;SECS.has(k)?SECS.delete(k):SECS.add(k);saveUI();syncUI();return}if(sh){SECS.has(sh.dataset.sec)?SECS.delete(sh.dataset.sec):SECS.add(sh.dataset.sec);saveUI();syncUI();return}
  const row=e.target.closest(".crow");if(row){const k=row.parentElement.dataset.k;OPEN.has(k)?OPEN.delete(k):OPEN.add(k);saveUI();syncUI()}});

function render(){try{renderReview();renderFeeds()}catch(e){}
  const D=DATA;
  const liveCards=[],upCards=[],wonCards=[],lostCards=[];let lostPending=0,wonPending=0,tonight=0,tonightTBC=0,openN=0;const TODAY=etDay(Date.now());
  FINAL_BI=new Set();
  D.open.forEach(b=>{
    const legStats=legStatsFor(b);
    let status=b.multi?combine(legStats.map(x=>x.s)):(legStats[0]?legStats[0].s:"?");LAST_STATUS[D.open.indexOf(b)]=status;
    const g=b.match?gameFor(b.match):null;
    const price=b.boosted_price&&b.boosted_price!==b.price?`${esc(b.price)} → ${esc(b.boosted_price)}`:esc(b.price);
    const firstG=g||legStats.map(x=>x.g).find(Boolean);
    const k=cardKey(b), isOpen=OPEN.has(k), BR=barsFor(b), mv=BR.mini;
    const mini=mv!=null?`<div class="mini" style="width:${Math.max(0,Math.min(100,mv))}%;background:${mv>50?"var(--win)":mv<50?"var(--lose)":"var(--push)"}"></div>`:"";
    const rs=rowScore(b,g,legStats);
    const crowDef=`${pillHTML(b,status,legStats)}
      <div class="cmid"><div class="clbl">${esc(shortLabel(b,g||firstG))}</div><div class="csub">${esc(bookTag(b.book))} · <b>${money(b.stake)}</b>${b.to_win!=null?` → ${money(b.to_win)}`:""}${clvTag(b.clv)}</div><div class="cneed">🎯 ${needLines(b).map(esc).join(" &nbsp;•&nbsp; ")}</div></div>
      <div class="cright">${rs}</div><span class="chev">›</span>${mini}`;
    const crowHTML=(LiveUI.crow&&(()=>{try{return LiveUI.crow(b,{status,legStats,g,firstG,price,mini,mv,rs,BR,k,def:crowDef})}catch(e){return null}})())||crowDef;
    let html=`<div class="card ${cls(pillState(b,status,legStats).cls)}${isOpen?" open":""}" data-k="${esc(k)}" data-bi="${D.open.indexOf(b)}"><div class="crow">${crowHTML}</div><div class="cbody">
      <div class="top" style="margin-top:8px"><span class="tag">${esc(b.sport||"?")} · ${esc(b.book)}</span></div>
      <div class="ev">${esc(b.event)} · ${esc(b.market)}</div>
      <div class="nums"><span>Price <b>${price}</b></span><span>Stake <b>${money(b.stake)}</b>${b.stake_note?" (unconf.)":""}</span><span>To win <b>${b.to_win==null?"TBC":money(b.to_win)}</b></span><span>Start <b>${esc(fmtStart(firstG,b.start))}</b></span></div>`;
    if(b.multi){html+=`<div class="score">`+legStats.map((x,i)=>`<div class="leg" data-li="${i}">${legRowInner(b,x)}</div>`).join("")+`</div>`;
      if(g)html+=scoreBox(g)}
    else{const x=legStats[0];html+=scoreBox(x&&x.g);if(x)html+=`<div class="meta" style="margin-top:4px" data-n1>${x.n?esc(x.n):""}${legBar(b,x,x.g&&x.g.state==="in"?legP(b,x.L,x.s,x):null)}</div>`}
    const anyLive=legStats.some(x=>x.g&&x.g.state==="in");
    if(anyLive)html+=liveDetail(b,legStats)+`<div class="spkw"><span class="spk-t">Win chance since page opened <b class="swing" data-swing></b></span><div data-spk>${sparkSVG(k)}</div></div>`;
    html+=BR.html+`</div></div>`;
    const gs=(b.match?[gameFor(b.match)]:b.legs.map(L=>gameFor(L.match))).filter(Boolean);
    const t=Math.min(...gs.map(g=>g.date?new Date(g.date).getTime():Infinity),Infinity);
    const allFinal=gs.length&&gs.length===(b.match?1:b.legs.length)&&gs.every(g=>g.completed);
    const graded=status==="WON"||status==="LOST"||(status==="PUSH"&&allFinal);
    // At risk / payout come from DATA.unsettled (all bets still open in the tracker, finals included); FINAL_BI = final-but-unsettled
    if(allFinal)FINAL_BI.add(D.open.indexOf(b));
    if(graded&&b.date===TODAY){if(status==="WON"){if(b.to_win!=null)tonight+=b.to_win;else tonightTBC++}else if(status==="LOST")tonight-=b.stake||0}
    const ts0=b.start_ts?Date.parse(b.start_ts):NaN,ts=isFinite(ts0)?ts0:(isFinite(t)?t:null);const BK={book:b.book,stake:(b.cash_stake!=null?b.cash_stake:(b.stake||0)),ts};const toFinal=()=>{if(!FINSEEN.has(k)){FINSEEN.add(k);if(OPEN.delete(k))html=html.replace(" open\"","\"");saveUI()}};
    if(status==="LOST"){toFinal();lostCards.push({html,...BK});lostPending+=b.stake||0}
    else if(gs.some(gLive))liveCards.push({html,...BK});
    else if(gs.length&&gs.length===(b.match?1:b.legs.length)&&gs.every(g=>g.completed)){toFinal();wonCards.push({html,...BK});if(status==="WON")wonPending+=b.to_win||0}
    else upCards.push({html,t,...BK})});
  // per-book "(wagered)" = cash stake of ALL unsettled bets of that book (bonus bets 0); Total equals the At-risk tile
  const WAG={};for(const x of D.open)WAG[bkey(x.book)]=(WAG[bkey(x.book)]||0)+(x.cash_stake||0);const wagT=Object.values(WAG).reduce((a,v)=>a+v,0);
  setHTML($("bal"),D.balances.map(b=>`<div><span class="bn">${esc(b.book)}</span><span class="bv"><b>${money(b.balance)}</b><i class="wag">(${money(WAG[bkey(b.book)]||0)})</i></span></div>`).join("")+`<div class="tot"><span class="bn">Total</span><span class="bv"><b>${money(D.total)}</b><i class="wag">(${money(wagT)})</i></span></div>`);
  for(const x of D.settled_recent||[])if(x.date===TODAY&&x.pnl!=null)tonight+=x.pnl;
  const sg=v=>(v>=0?"+":"−")+money(Math.abs(v));
  $("sum").innerHTML=`<div>At risk<b>${money(D.unsettled.cash_stake)}</b><small>${D.unsettled.n} unsettled bet${D.unsettled.n===1?"":"s"}${FINAL_BI.size?` · ${FINAL_BI.size} final, awaiting settle`:""}</small></div><div>Tonight so far<b class="${tonight>=0?"pos":"neg"}">${sg(tonight)}</b><small>${tonightTBC?`+ ${tonightTBC} win TBC`:"today's bets, live-graded"}</small></div><div>Potential payout<b id="expPay">…</b><small id="expSub"></small></div><div>Expected P&amp;L (est.)<b id="expPL">…</b><small>probability-weighted, our estimate</small></div><div class="wide">Tracker P&amp;L<b class="${D.pnl_total>=0?"pos":"neg"}">${sg(D.pnl_total)}</b><small>settled, all time</small></div>`;
  const sy=window.scrollY;   // patch only what changed, keep the reader's scroll position
  setHTML($("live"),byBook(liveCards)||'<div class="meta">Nothing live right now.</div>');
  setHTML($("bets"),byStart(upCards)||'<div class="meta">Nothing upcoming.</div>');
  $("liveN").textContent=liveCards.length||"";$("upN").textContent=upCards.length||"";
  $("wonCards").innerHTML=wonCards.length?`<div class="meta" style="margin:0 2px 6px">Final, not settled in the tracker yet</div>`+byBook(wonCards):"";
  const row=s=>`<div class="set"><span>${esc(s.date.slice(5))} ${esc(s.book)} · ${esc(s.pick)}${clvTag(s.clv)}</span><b class="${(s.pnl||0)>=0?"pos":"neg"}">${/void/i.test(s.result)?"Void · stake back":s.pnl==null?esc(s.result):((s.pnl>=0?"+":"−")+money(Math.abs(s.pnl)))}</b></div>`;
  const st=D.settled_recent||[], lostS=st.filter(s=>/lost|loss/i.test(s.result)), wonS=st.filter(s=>!/lost|loss/i.test(s.result));
  const wonSum=wonS.reduce((a,s)=>a+(s.pnl||0),0), lostSum=lostS.reduce((a,s)=>a-(s.pnl||0),0);
  $("won").innerHTML=(wonS.length?`<div class="meta" style="margin:8px 2px 2px">Settled recently</div>`:"")+byBook(wonS.map(s=>({html:row(s),book:s.book,stake:setStake(s)})))||(wonCards.length?"":'<div class="meta">None settled recently.</div>');
  const wonN=wonCards.length+wonS.length,wonAll=wonSum+wonPending;
  $("wonHead").textContent=`Won / Push / Void · ${wonN} · +${money(wonAll)}`;
  $("lostCards").innerHTML=lostCards.length?`<div class="meta" style="margin:0 2px 6px">Graded LOST live, not settled in the tracker yet</div>`+byBook(lostCards):"";
  $("lost").innerHTML=(lostS.length?`<div class="meta" style="margin:8px 2px 2px">Settled recently</div>`:"")+byBook(lostS.map(s=>({html:row(s),book:s.book,stake:setStake(s)})))||(lostCards.length?"":'<div class="meta">None settled recently.</div>');
  const lostTotal=lostSum+lostPending;
  $("lostHead").textContent=`Lost · ${lostCards.length+lostS.length} · −${money(lostTotal)}`;
  $("lostHead").title=lostPending?`incl. ${money(lostPending)} not yet settled in the tracker`:"";
  const now=new Date().toLocaleTimeString("en-CA",{timeZone:TZ,hour:"numeric",minute:"2-digit",second:"2-digit"});
  const gen=D.generated_at?new Date(D.generated_at).toLocaleString("en-CA",{timeZone:TZ,month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"?";
  syncUI();tick1s();if(Math.abs(window.scrollY-sy)>2)window.scrollTo(0,sy);
  $("meta").textContent=`Scores updated ${now} ET · scores every ${FAST/1000|0}s · bets as of ${gen} ET`;
  try{autoSettleCheck()}catch(e){}
  for(const f of LiveUI.afterRender){try{f({DATA:D,games,liveCards:liveCards.length,upCards:upCards.length})}catch(e){}}
}
let FAST=10000, fastTimer=null, loading=false;
async function loadData(){try{const d=await getJSON("data.json?t="+Date.now());if(!d||typeof d!=="object"||!Array.isArray(d.open)||!Array.isArray(d.settled_recent)||!d.balances||typeof d.balances!=="object")throw new Error("bad data");DATA=d}catch(e){if(!DATA){$("meta").textContent="Couldn't load data.json";return false}}return true}
let loadingAt=0;
async function fastTick(full){clearTimeout(fastTimer);if(loading&&Date.now()-loadingAt>30000)loading=false;if(!DATA||loading)return schedule();loading=true;loadingAt=Date.now();espnErr=false;tickCD();
  try{await refreshScores(full);await Promise.all([refreshProbs(),refreshPM().catch(()=>{}),refreshAN().catch(()=>{}),refreshKalshi().catch(()=>{}),refreshPropStats().catch(()=>{})]);if(full)await refreshPregame()}finally{loading=false}
  FAST=espnErr?30000:10000;try{render()}catch(e){console.error(e)}schedule()}
let nextAt=0;
// 10 s period: the next poll starts FAST ms after the previous one STARTED, not after it finished, but never less than 5 s after it
function schedule(){clearTimeout(fastTimer);if(!document.hidden){const wait=Math.max(5000,FAST-(Date.now()-loadingAt));nextAt=Date.now()+wait;fastTimer=setTimeout(()=>fastTick(false),wait)}tickCD()}
function tickCD(){const el=$("cd");if(!el)return;
  if(loading){el.textContent="Updating…";el.className="cd busy";return}
  if(document.hidden||!nextAt){el.textContent="paused";el.className="cd";return}
  const n=Math.max(1,Math.ceil((nextAt-Date.now())/1000));el.textContent=`${n}s`;el.className="cd"+(FAST>10000?" slow":"")}
setInterval(tickCD,250);
async function slowTick(){if(await loadData()){render();if(!document.hidden)fastTick(true)}}
slowTick().then(autoHealth);setInterval(slowTick,60000);           // data.json every 60s
document.addEventListener("visibilitychange",()=>{if(document.hidden)clearTimeout(fastTimer);else{tick1s();fastTick(true)}});

// ---- auto-run health: last GitHub Actions run of autorun.yml (GitHub API; needs the optional token from Logs, else banner stays hidden) + needs_review from data.json
const GH_RUNS="https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/autorun.yml/runs?per_page=10";
let AUTO_RUNS=null,AUTO_AT=0;
function renderFeeds(){const el=$("feeds");if(!el)return;
  const f=(n,ok,bad)=>`<span class="${ok?"fok":"fbad"}" title="${esc(bad||"")}">${ok?"●":"○"} ${n}${!ok&&bad?` <small>${esc(bad)}</small>`:""}</span>`;
  const st=x=>x&&x.ok&&Date.now()-x.ok<120000,bad=x=>x&&x.bad;
  const eBad=bad(FEED.site)||bad(FEED.core),eOK=st(FEED.site)&&!eBad;
  const parts=[f("ESPN",eOK,eBad||(FEED.site?"stale":"no data yet")),f("Polymarket",pmOK!==false,pmOK===false?"request failed":""),f("Odds",anOK!==false,anOK===false?"request failed":"")];
  if(FEED.kal)parts.push(f("Kalshi",!!FEED.kal.ok,FEED.kal.bad||""));
  if(FEED.sofa)parts.push(f("Soccer backup",!!FEED.sofa.ok,FEED.sofa.bad||""));
  if(FEED.mlb)parts.push(f("MLB backup",!!FEED.mlb.ok,FEED.mlb.bad||""));
  if(FEED.anb)parts.push(f("Action Network backup",!!FEED.anb.ok,FEED.anb.bad||""));
  if(FEED.lsf)parts.push(f("League feed backup",!!FEED.lsf.ok,FEED.lsf.bad||""));
  const h=parts.join("")+(FEED.csp?` <span class="fbad">⚠ blocked by page security policy: ${esc(FEED.csp)}</span>`:"");
  if(el._h!==h){el._h=h;el.innerHTML=h}}
function renderReview(){
  const rv=(DATA&&DATA.auto&&DATA.auto.needs_review)||[];
  {const re_=$("review"),h=rv.length?`<a class="rvlink" href="log.html#activity">${rv.length} bet${rv.length>1?"s":""} need your OK (not auto-settled) · settle in Logs ›</a>`:"";if(re_._h!==h){re_._h=h;re_.innerHTML=h}}
}
async function autoHealth(){
  renderReview();
  let tok="";try{tok=localStorage.getItem("bt.gh.settle")||""}catch(e){}
  if(!/^[A-Za-z0-9_\-]{20,255}$/.test(tok)){AUTO_RUNS=null;tok=""}
  else if(!AUTO_RUNS||Date.now()-AUTO_AT>240000){try{
    const r=await tfetch(GH_RUNS,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+tok,"X-GitHub-Api-Version":"2022-11-28"}});
    if(r.status===401||r.status===403||r.status===404)AUTO_RUNS=null; // private repo / no access: stay silent
    else if(r.ok){const j=await r.json();AUTO_RUNS=j.workflow_runs||[];AUTO_AT=Date.now()}
  }catch(e){}}
  const el=$("autoh");if(!el)return;
  const fmt=d=>new Date(d).toLocaleTimeString("en-CA",{timeZone:TZ,hour:"numeric",minute:"2-digit"});
  if(!AUTO_RUNS){el.className="autoh";el.textContent="";return}
  const done=AUTO_RUNS.filter(r=>r.status==="completed"&&r.conclusion!=="cancelled"&&r.conclusion!=="skipped");
  const ok=done.find(r=>r.conclusion==="success"),last=done[0];
  const age=ok?(Date.now()-new Date(ok.updated_at))/60000:1e9;
  let txt=ok?`Auto-updated ${fmt(ok.updated_at)} ET`:"No successful auto-run yet",bad=false;
  if(last&&last.conclusion!=="success"){bad=true;txt=`⚠ Auto-update FAILED at ${fmt(last.updated_at)} ET · `+txt}
  else if(age>30){bad=true;txt=`⚠ Auto-update stale (${Math.round(age)} min) · `+txt}
  el.className="autoh"+(bad?" bad":"");el.textContent=bad?txt:"";
}
setInterval(autoHealth,60000);


// Start an autorun (settle + archive + rebuild) from the page. Needs the optional GitHub token saved on the Logs page.
// GitHub's own cron is best-effort (it can go hours without firing), so the page asks for a run itself when it sees
// a game finish. Rate-limited; returns a short status string, or null when it did not even try.
const AR_DISPATCH="https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/autorun.yml/dispatches";let AR_LAST=0;const AR_DONE=new Set();
async function requestRun(minGap){
  let tok="";try{tok=localStorage.getItem("bt.gh.settle")||""}catch(e){}
  if(!/^[A-Za-z0-9_\-]{20,255}$/.test(tok)||Date.now()-AR_LAST<(minGap||120000))return null;
  try{const r=await tfetch(AR_DISPATCH,{method:"POST",cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",
      headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+tok,"X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:JSON.stringify({ref:"main"})});
    if(r.status===204){AR_LAST=Date.now();return "Update requested"}
    return r.status===401||r.status===403||r.status===404?"Token can't start runs":"Request failed"}catch(e){return "Request failed"}}
// a finished-but-unsettled bet we have not asked about yet -> one run now, then reload the data when it should be done
function autoSettleCheck(){
  if(document.hidden||!DATA||!FINAL_BI.size)return;
  const fresh=[...FINAL_BI].map(i=>DATA.open[i]&&DATA.open[i].bet_id).filter(id=>id&&!AR_DONE.has(id));
  if(!fresh.length)return;
  requestRun(300000).then(msg=>{if(msg==="Update requested"){fresh.forEach(id=>AR_DONE.add(id));setTimeout(slowTick,50000);setTimeout(slowTick,100000)}})}
// manual refresh: reload data.json + force a full live refresh; with a connected GitHub token also request a run
{const btn=$("refresh");
  const label=t=>{const l=btn.querySelector(".rl");if(l)l.textContent=t};
  if(btn)btn.addEventListener("click",async()=>{if(btn.disabled)return;btn.disabled=true;btn.classList.add("busy");
    try{const msg=await requestRun(120000);await slowTick();autoHealth();
      if(msg){label(msg);if(msg==="Update requested"){setTimeout(slowTick,45000);setTimeout(slowTick,90000)}await new Promise(r=>setTimeout(r,2500))}}
    finally{label("Refresh");btn.disabled=false;btn.classList.remove("busy")}})}
