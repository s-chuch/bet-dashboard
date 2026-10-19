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
function fromEvent(ev){const c=ev.competitions?ev.competitions[0]:ev.header.competitions[0];const st=ev.status||c.status;
  return {id:ev.id,date:ev.date||c.date,period:st.period,clock:st.clock,outs:c.situation&&c.situation.outs,lastPlay:c.situation&&c.situation.lastPlay&&c.situation.lastPlay.text||"",longDetail:st.type.detail||"",state:st.type.state,completed:st.type.completed,detail:st.type.shortDetail,
    sit:pickSit(c.situation),teams:c.competitors.map(x=>({id:x.team.id||x.id,name:x.team.displayName,abbr:x.team.abbreviation,short:x.team.shortDisplayName,location:x.team.location,nick:x.team.name,home:x.homeAway==="home",score:x.score&&typeof x.score==="object"?x.score.displayValue:x.score,ls:(x.linescores||[]).map(l=>l.displayValue!=null?l.displayValue:l.value),st:Object.fromEntries((x.statistics||[]).map(q=>[q.name,q.displayValue]))}))}}
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
async function espn(u){if(!/^https:\/\/(site\.api|sports\.core\.api)\.espn\.com\/[\w\/.,&=?%-]*$/.test(u)){FEED.site={bad:"blocked URL"};return null}const fk=/sports\.core\./.test(u)?"core":"site";try{const r=await tfetch(u,{cache:"no-store"});if(r.status===429||r.status>=500){espnErr=true;FEED[fk]={bad:"HTTP "+r.status};return null}
  if(!r.ok){FEED[fk]={bad:"HTTP "+r.status};return null}const j=await r.json();FEED[fk]={ok:Date.now()};return j}catch(e){espnErr=true;FEED[fk]={bad:"network/CORS"};return null}}
const corePath=m=>{const[sp,lg]=m.path.split("/");return`https://sports.core.api.espn.com/v2/sports/${sp}/leagues/${lg}/events/${m.id}/competitions/${m.id}`};
// full=true: every unfinished game (60s cycle); full=false: only live / about-to-start games (10s cycle)
async function refreshScores(full){
  const need={};for(const m of allMatches()){const g=gameFor(m);if(g&&g.completed)continue;if(!full&&!isActive(m))continue;need[key(m)]=m}
  await Promise.all(Object.values(need).map(async m=>{
    const d=await espn(`${ESPN}${m.path}/scoreboard?dates=${m.date}`+(m.groups?`&groups=${m.groups}`:""));
    for(const ev of (d&&d.events)||[]){const old=games[ev.id],nw=fromEvent(ev);
      // ESPN's CDN sometimes serves an older copy: same period, clock higher, same score -> ignore it
      if(old&&old.state==="in"&&nw.state==="in"&&old.period===nw.period&&typeof old.clock==="number"&&typeof nw.clock==="number"&&nw.clock>old.clock+0.5&&
         old.teams.map(t=>t.score).join()===nw.teams.map(t=>t.score).join()&&CLOCK_SPORTS.has(m.path))continue;
      if(old&&old.state==="post"&&nw.state!=="post")continue;
      games[ev.id]=nw;
      // local clock: only run it if the last two fetches showed the clock moving (football clocks stop a lot)
      const moving=!!(old&&old.state==="in"&&nw.state==="in"&&old.period===nw.period&&typeof nw.clock==="number"&&typeof old.clock==="number"&&nw.clock<old.clock&&nw.clock>0&&!/end|half|intermission|delay/i.test(nw.detail||""));
      CLK[ev.id]={clock:nw.clock,t:Date.now(),moving};observe(ev.id,m.path,old,nw,moving);
      const p=ev.competitions[0].situation&&ev.competitions[0].situation.lastPlay&&ev.competitions[0].situation.lastPlay.probability;
      if(p&&p.homeWinPercentage!=null)probs[ev.id]={home:p.homeWinPercentage,away:p.awayWinPercentage,t:Date.now(),src:"sb"}}}));
  // player props need the box score (only in-progress SGPs with a prop leg)
  const sm={};for(const b of DATA.open)for(const L of b.legs){const m=b.match||L.match;if(m&&L.type==="prop")sm[m.id]=m}
  await Promise.all(Object.values(sm).map(async m=>{
    const g=gameFor(m);if(!g||g.state==="pre")return;const S=summaries[m.id];
    if(S&&S.done)return;if(S&&Date.now()-S.t<20000)return;   // live: box score at most every 20s
    const d=await espn(`${ESPN}${m.path}/summary?event=${m.id}`);if(!d||!d.boxscore)return;
    const fin=(S&&S.fin||0)+(g.completed?1:0);summaries[m.id]={d,t:Date.now(),path:m.path,fin,done:fin>=3}}));
}
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
  return{s:"?",n:"can't compute"}}
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
  reb:[s=>s.rebounds,"reb"],threes:[s=>s.threePointFieldGoalsMade,"3PM"],saves:[s=>s.saves,"saves"],
  hits:[s=>s.hits,"hits"],hr:[s=>s.homeRuns,"HR"],rbi:[s=>s.RBIs,"RBI"],runs:[s=>s.runs,"runs"],walks:[s=>s.walks,"BB"],sb:[s=>s.stolenBases,"SB"],
  k:[s=>s.p_strikeouts!=null?s.p_strikeouts:s.strikeouts,"K"],hrr:[s=>sumK(s,"hits","runs","RBIs"),"H+R+RBI"],
  doubles:[(s,c)=>s._double!=null?s._double:(c.plays&&s.hits!=null?0:null),"2B"],triples:[(s,c)=>s._triple!=null?s._triple:(c.plays&&s.hits!=null?0:null),"3B"],
  singles:[(s,c)=>s._single!=null?s._single:(c.plays&&s.hits!=null?0:null),"1B"],
  tb:[(s,c)=>c.plays&&s.hits!=null?(s._single||0)+2*(s._double||0)+3*(s._triple||0)+4*(s["_home-run"]||0):null,"TB"]};
function propStatus(L,g,matchId){
  if(!L.player)return{s:"?",lbl:"?",n:"stat not found (player not named in the bet log)"};
  const who=(String(L.player).trim().split(/\s+/).pop()||L.player);
  if(!L.stat||!PROP[L.stat])return{s:"?",lbl:"?",n:`stat not found (log doesn't say which ${who} stat${L.stat_raw?": "+L.stat_raw:""})`};
  const S=summaries[matchId];if(!S)return{s:"LIVE",lbl:"LIVE",n:"loading box score…"};
  const ath=athletesOf(S),ctx={path:S.path,plays:S._plays},[fn,unit]=PROP[L.stat];
  let c=L.pid?ath.filter(a=>String(a.id)===String(L.pid)):[];
  if(!c.length)c=ath.filter(a=>playerMatch(L.pname||L.player,a.name)&&(!L.pteam||!a.team||a.team===L.pteam));
  if(c.length>1){const ib=c.filter(a=>a.inBox);if(ib.length)c=ib}
  if(c.length>1){const wv=c.filter(a=>fn(a.s,ctx)!=null);if(wv.length)c=wv}
  const A=c[0],supported=ath.some(a=>fn(a.s,ctx)!=null)||(L.stat==="td"&&(S.d.scoringPlays||[]).length>0);
  let v=A?fn(A.s,ctx):null;
  if(L.stat==="td"){const tp=tdPlays(S,L);if(tp>0||v!=null||A||L.pteam)v=Math.max(v||0,tp)}
  if(v==null){if((A||L.pteam)&&supported)v=0;else return{s:"?",lbl:"?",n:`stat not found (${who} ${unit})`}}
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
function scoreBox(g){if(!g)return"";const live=g.state==="in";
  const order=[...g.teams].sort((a,b)=>a.home-b.home);
  return `<div class="score">${order.map(t=>`<div class="row"><span>${esc(t.name)}</span><b>${g.state==="pre"?"":esc(t.score)}</b></div>`).join("")}
    <div class="det">${live?'<span class="live">● LIVE</span> ':""}${g.state==="pre"?"Not started":g.completed?esc(g.detail):`<span data-clk="${esc(g.id)}" data-sep=" - ">${esc(clockText(g," - "))}</span>`}</div>${g.completed?"":stBadge(g)}</div>`}

// ===== Our estimate (NOT ESPN, NOT a sportsbook price): Pinnacle pregame no-vig inputs + live score/clock =====
const SD={"football/nfl":[13.5,10],"football/college-football":[15,12],"basketball/nba":[12,18]};
const PER={"football/nfl":[4,900],"football/college-football":[4,900],"basketball/nba":[4,720],"hockey/nhl":[3,1200]};
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
function modelFor(m){if(!m||!m.pin)return null;if(_mc[m.id])return _mc[m.id];const P=m.pin,out={};
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
const AN_LG={"football/nfl":"nfl","football/college-football":"ncaaf","hockey/nhl":"nhl","baseball/mlb":"mlb","basketball/nba":"nba"};
function pmOf(m){return m&&(m.pm||PMX[m.id])||null}
function pickTeam(g,L){if(!g||!L.team)return null;const i=sideIdx(g,L.team);return i<0?null:{T:g.teams[i],O:g.teams[1-i]}}
function pmIdx(outs,pt){const a=outs.map(o=>teamMatch(o,pt.T)&&!teamMatch(o,pt.O));return a.filter(Boolean).length===1?a.indexOf(true):-1}
// token for the bet's own outcome; spreads/totals only when Polymarket has the exact same line
function pmToken(L,m,g){const pm=pmOf(m);if(!pm||!g)return null;
  if(L.type==="ml"){const pt=pickTeam(g,L);if(!pt||!pm.ml)return null;const i=pmIdx(pm.ml.outcomes,pt);return i<0?null:pm.ml.tokens[i]}
  if(L.type==="spread"){const pt=pickTeam(g,L);if(!pt)return null;
    for(const x of pm.spreads||[]){const i=pmIdx(x.outcomes,pt);if(i===0&&x.line===L.line)return x.tokens[0];if(i===1&&x.line===-L.line)return x.tokens[1]}return null}
  if(L.type==="total"){for(const x of pm.totals||[]){if(x.line!==L.line)continue;const i=x.outcomes.findIndex(o=>o.toLowerCase()===L.side);if(i>=0)return x.tokens[i]}return null}
  return null}
function pmVal(L,m,g){const t=pmToken(L,m,g);const q=t&&PMMID[t];if(!q||Date.now()-q.t>90000)return null;return q}
async function pmLookup(m){pmTried[m.id]=1;const g=gameFor(m);if(!g)return;const A=g.teams.find(t=>!t.home),H=g.teams.find(t=>t.home);
  try{for(const q of [`${A.location} ${H.location}`,`${A.nick} ${H.nick}`]){
      const d=await getJSON("https://gamma-api.polymarket.com/public-search?limit_per_type=15&events_status=all&q="+encodeURIComponent(q));
      for(const e of d.events||[]){if(!/^[a-z]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/.test(e.slug||"")||!e.startTime)continue;
        if(Math.abs(new Date(e.startTime)-new Date(g.date))>4*3600e3)continue;const pr=String(e.title||"").split(/\s+vs\.?\s+/);if(pr.length!==2)continue;
        const ok=(teamMatch(pr[0],A)&&teamMatch(pr[1],H))||(teamMatch(pr[0],H)&&teamMatch(pr[1],A));if(!ok)continue;
        const full=(await getJSON("https://gamma-api.polymarket.com/events?slug="+e.slug))[0]||e;const J=x=>{try{return typeof x==="string"?JSON.parse(x):(x||[])}catch(_){return[]}};
        const pm={slug:e.slug,spreads:[],totals:[]};for(const mk of full.markets||[]){const t=mk.sportsMarketType,tk=J(mk.clobTokenIds),o=J(mk.outcomes);if(tk.length!==2||o.length!==2)continue;
          if(t==="moneyline"&&!pm.ml)pm.ml={outcomes:o,tokens:tk};else if(t==="spreads"&&mk.line!=null)pm.spreads.push({line:+mk.line,outcomes:o,tokens:tk});else if(t==="totals"&&mk.line!=null)pm.totals.push({line:+mk.line,outcomes:o,tokens:tk})}
        if(pm.ml){PMX[m.id]=pm;return}}}}catch(e){}}
function pmWanted(m,g){return g&&!g.completed&&(g.state==="in"||new Date(g.date)-Date.now()<3*3600e3)}
async function refreshPM(){const toks=new Set();
  for(const b of DATA.open)for(const L of b.legs){const m=matchOfLeg(b,L),g=gameFor(m);if(!m||!PM_PATHS.has(m.path)||!pmWanted(m,g))continue;
    if(!pmOf(m)&&!pmTried[m.id])await pmLookup(m);const t=pmToken(L,m,g);if(t)toks.add(t)}
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
function approxLeg(b,L,x){if(x.s==="WON")return 1;if(x.s==="LOST")return 0;const m=matchOfLeg(b,L),g=x.g||gameFor(m);if(!g||!m)return 0.5;
  if(g.state!=="in"){if(L.type==="ml"){const pg=pregameLive[m.id]||m.pregame,pt=pickTeam(g,L);if(pg&&pt)return(pt.T.home?pg.home:pg.away)/100}return 0.5}
  const lg=localGame(g,m),f=fracLeft(m,lg),e=1-f,[sdm,sdt]=SDX[m.path]||[12,14],sc=g.teams.map(t=>Number(t.score||0)),S=sc[0]+sc[1],soc=SOCCER(m.path);
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
function betLive(b,status,legStats){
  const gs=legStats.map(x=>x.g).filter(Boolean);const allFinal=gs.length&&gs.length===b.legs.length&&gs.every(g=>g.completed);
  if(status==="WON"||status==="LOST"||(status==="PUSH"&&allFinal)||allFinal)return{final:true};
  if(!gs.some(g=>g.state==="in"))return{upcoming:true};
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
  if(v.upcoming)return{cls:"NOT_STARTED",txt:"UPCOMING",sub:""};
  const hitTxt=b.multi?legsHit(legStats):"";
  if(v.p==null)return{cls:"LIVE",txt:"LIVE",sub:v.sub||hitTxt};
  const pct=Math.round(v.p*100),k=v.p>=0.55?"WINNING":v.p<=0.45?"LOSING":"NEUTRAL";
  return{cls:k,txt:`${k} ${v.approx?"≈":""}${pct}%`,
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
function liveDetail(b,legStats){const seen=new Set(),parts=[];
  const legs=b.legs.map(L=>({L,m:matchOfLeg(b,L)})).filter(x=>x.m);
  const nh=needsHTML(b);if(nh)parts.push(`<div class="need" data-need>${nh}</div>`);
  for(const{m}of legs){const g=gameFor(m);if(!g||g.state!=="in"||seen.has(g.id))continue;seen.add(g.id);
    parts.push(sportChips(m,g)+lineScore(g)+(g.lastPlay?`<div class="lastp">Last: ${esc(g.lastPlay)}</div>`:""))}
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
  const c=lbl==="HIT"?"WON":lbl==="MISSED"?"LOST":lbl;return{lbl,c,p}}
function legRowInner(b,x){const ch=legChip(b,x);
  return`<span class="lgt">${esc(x.L.text)}${x.n?` <span class="meta">· ${esc(x.n)}</span>`:""}${!b.match&&x.g?`<br><span class="meta">${x.g.teams.map(t=>esc(t.abbr||t.name)+" "+(x.g.state==="pre"?"":esc(t.score))).join(" – ")} · ${esc(x.g.state==="pre"?fmtStart(x.g):x.g.detail)}</span>`:""}${legBar(b,x,ch.p)}</span><span class="pill ${cls(ch.c)}">${esc(ch.lbl)}</span>`}
function needsHTML(b){return b.legs.map(L=>{const m=matchOfLeg(b,L);return m?needLine(L,m,gameFor(m)):""}).filter(Boolean).map(esc).join("<br>")}
const setHTML=(el,h)=>{if(el&&el.innerHTML!==h)el.innerHTML=h};
// group cards/rows by book A–Z (case-insensitive, stable within a book) under a 'Book ($staked)' subheader
const bkey=b=>String(b||"?").toLowerCase();
function byBook(items){const s=items.map((x,i)=>({...x,i})).sort((a,c)=>bkey(a.book).localeCompare(bkey(c.book))||a.i-c.i),tot={};
  s.forEach(x=>{tot[bkey(x.book)]=(tot[bkey(x.book)]||0)+(x.stake||0)});let out="",cur=null;
  for(const x of s){if(bkey(x.book)!==cur){cur=bkey(x.book);out+=`<div class="bkh">${esc(x.book||"?")} <b>(${money(tot[cur])})</b></div>`}out+=x.html}return out}
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
    const lv=betLive(b,st,ls);if(!lv.final&&!lv.upcoming&&lv.p!=null){recordP(c.dataset.k,lv.p);const sp=c.querySelector("[data-spk]");if(sp&&c.classList.contains("open"))sp.innerHTML=sparkSVG(c.dataset.k)}
    c.classList.remove("WINNING","LOSING","NEUTRAL","LIVE","TIED","PUSH","WON","LOST","NOT_STARTED");c.classList.add(cls(q.cls))});
  document.querySelectorAll("[data-clk]").forEach(el=>{const g=games[el.dataset.clk];if(g)el.textContent=clockText(g,el.dataset.sep||" ")});
  document.querySelectorAll(".card[data-bi]").forEach(c=>{const b=DATA.open[+c.dataset.bi];if(!b)return;let first=null;
    c.querySelectorAll(".wp.est[data-leg]").forEach(w=>{const L=b.legs[+w.dataset.leg],m=matchOfLeg(b,L),g=gameFor(m);if(!g)return;
      const v=estLeg(L,m,localGame(g,m));if(v==null)return;const pct=Math.max(0,Math.min(100,v*100));if(first==null)first=pct;
      const col=pct>50?"var(--win)":pct<50?"var(--lose)":"var(--push)";const f=w.querySelector(".fill");f.style.width=pct+"%";f.style.background=col;
      w.querySelector(".lbl b").textContent=pct.toFixed(1)+"%"});
    if(!b.multi&&b.legs[0]){const src=legSources(b,b.legs[0]);first=src.length?src[0].v*100:null;const se=c.querySelector("[data-src]");if(se&&src.length)se.textContent=SRC_LBL[src[0].k]}
    const mini=c.querySelector(".mini");if(mini&&!b.multi&&first!=null){mini.style.width=first+"%";mini.style.background=first>50?"var(--win)":first<50?"var(--lose)":"var(--push)"}});
  // probability-weighted payout (estimate): every unsettled bet contributes (implied-price fallback); bets with no payout/price are TBC
  let exp=0,tbc=0;const U=DATA.unsettled||{};
  DATA.open.forEach((b,i)=>{const pay=b.payout;if(pay==null){tbc++;return}
    const cs=b.cash_stake||0;let p=payoutP(b,LAST_STATUS[i]);if(p==null)p=impliedP(b);if(p==null){tbc++;return}
    exp+=p==="push"?cs:pay*p});
  const ep=$("expPay"),el=$("expPL");if(ep){ep.textContent=moneyC(U.max_payout);$("expSub").textContent=`${U.n!=null?U.n:DATA.open.length} bet${(U.n!=null?U.n:DATA.open.length)===1?"":"s"} · expected ≈ ${moneyC(exp)} (est.)${tbc?` · ${tbc} TBC`:""}`}
  if(el){const v=exp-(U.cash_stake||0);el.textContent=(v>=0?"+":"−")+money(Math.abs(v));el.className=v>=0?"pos":"neg"}}
setInterval(tick1s,1000);
function bar(label,v,cls2,note,attr){v=Math.max(0,Math.min(100,v));const col=v>50?"var(--win)":v<50?"var(--lose)":"var(--push)";
  return`<div class="wp ${cls2||""}" ${attr||""}><div class="lbl"><span>${label}</span><b>${v.toFixed(1)}%</b></div><div class="track"><div class="fill" style="width:${v}%;background:${col}"></div></div>${note?`<div class="note">${note}</div>`:""}</div>`}
const EST_NOTE="Est. = our own estimate from Pinnacle pregame no-vig prices + the live score/clock. Not an ESPN or sportsbook number.";
// all bars for a card + the single value used for the collapsed row
function pmBar(L,m,g,ctx){const q=pmVal(L,m,g);if(!q)return"";const live=g.state==="in",wide=q.spread!=null&&q.spread>0.1;
  const what=L.type==="ml"?`${esc(pickTeam(g,L).T.abbr)} win`:`${esc(L.text)} (same line)`;
  const note=`Polymarket mid${q.spread!=null?` · spread ${(q.spread*100).toFixed(1)}¢`:""}${wide?" · thin market, not used":""}${!live?" · pregame":""}${L.type!=="ml"?" · display only":""}`;
  return bar(`Polymarket${ctx||""} · ${what}`,q.mid*100,"pmb",note)}
function booksBar(L,m,g,ctx){if(g.state!=="in")return"";const bp=booksP(L,m,g);if(!bp)return"";
  const what=L.type==="ml"?`${esc(pickTeam(g,L).T.abbr)} win`:L.type==="spread"?`${esc(L.text)} covers`:`${esc(L.text)} hits`;
  return bar(`Books (no-vig)${ctx||""} · ${what}`,bp.v*100,"bkb",`${bp.book===15?"Action Network consensus":BKN[bp.book]} live line, vig removed${L.type!=="ml"?" · at your exact line":""}`)}
function liveLine(L,m,g){if(!g||g.state!=="in")return"";const t=anText(L,m,g);return t?`<div class="aln">${esc(t)}</div>`:""}
// all bars for a card + the single value used for the collapsed row (top-priority source)
function barsFor(b){const out=[];let mini=null;
  const p=probFor(b);
  const espnBar=()=>p?bar(`ESPN · ${esc(p.label)}`,p.pct,"",p.ml?(p.kind==="pregame"?"ESPN pregame predictor":"ESPN live win probability"):(b.multi?"ESPN game-win chance for that team only, not the parlay's chance":"ESPN chance to win the game, not to cover")):"";
  const estOf=(L,i,lbl)=>{const m=matchOfLeg(b,L),g=gameFor(m);if(!g||g.completed)return"";const v=estLeg(L,m,localGame(g,m));return v==null?"":bar(lbl,v*100,"est","",`data-leg="${i}"`)};
  if(!b.multi){const L=b.legs[0];if(L){const m=matchOfLeg(b,L),g=gameFor(m);
      if(g&&!g.completed){out.push(liveLine(L,m,g));
        out.push(pmBar(L,m,g));out.push(booksBar(L,m,g));
        out.push(estOf(L,0,L.type==="ml"?"Est. win":L.type==="spread"?`Est. cover ${esc(L.text)}`:`Est. ${esc(L.text)} hits`));
        const src=legSources(b,L);if(src.length){mini=src[0].v*100;out.push(`<div class="note srcn">Pill &amp; payout use: <b data-src>${SRC_LBL[src[0].k]}</b></div>`)}}}
    if(!out.some(x=>/wp (pmb|bkb)/.test(x)))out.push(espnBar())}
  else{b.legs.forEach((L,i)=>{const m=matchOfLeg(b,L),g=gameFor(m);if(!g||g.completed)return;const ctx=` · ${esc(L.text)}`;
      out.push(liveLine(L,m,g));out.push(pmBar(L,m,g,` leg`));out.push(booksBar(L,m,g,` leg`));
      out.push(estOf(L,i,`Est. leg: ${esc(L.text)}${L.type==="spread"?" covers":L.type==="ml"?" wins":" hits"}`))});
    if(!out.some(x=>/wp (pmb|bkb)/.test(x)))out.push(espnBar())}
  if(out.some(x=>x.includes('wp est')))out.push(`<div class="note" style="font-size:11px;color:var(--mut);margin-top:4px">${EST_NOTE}</div>`);
  if(mini==null&&p)mini=p.pct;
  return{html:out.filter(Boolean).join(""),mini}}
const BOOKS={PointsBet:"PB",Caesars:"CZR",FanDuel:"FD",DraftKings:"DK",bet365:"365",theScore:"SCORE","Hard Rock":"HR",BetMGM:"MGM"};
const bookTag=b=>BOOKS[b]||b;
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
    let html=`<div class="card ${cls(pillState(b,status,legStats).cls)}${isOpen?" open":""}" data-k="${esc(k)}" data-bi="${D.open.indexOf(b)}"><div class="crow">${pillHTML(b,status,legStats)}
      <div class="cmid"><div class="clbl">${esc(shortLabel(b,g||firstG))}</div><div class="csub">${esc(bookTag(b.book))} · <b>${money(b.stake)}</b>${b.to_win!=null?` → ${money(b.to_win)}`:""}</div><div class="cneed">🎯 ${needLines(b).map(esc).join(" &nbsp;•&nbsp; ")}</div></div>
      <div class="cright">${rs}</div><span class="chev">›</span>${mini}</div><div class="cbody">
      <div class="top" style="margin-top:8px"><span class="tag">${esc(b.sport||"?")} · ${esc(b.book)}</span></div>
      <div class="ev">${esc(b.event)} · ${esc(b.market)}</div>
      <div class="nums"><span>Price <b>${price}</b></span><span>Stake <b>${money(b.stake)}</b>${b.stake_note?" (unconf.)":""}</span><span>To win <b>${b.to_win==null?"TBC":money(b.to_win)}</b></span><span>Start <b>${esc(fmtStart(firstG,b.start))}</b></span></div>`;
    if(b.multi){html+=`<div class="score">`+legStats.map((x,i)=>`<div class="leg" data-li="${i}">${legRowInner(b,x)}</div>`).join("")+`</div>`;
      if(g)html+=scoreBox(g)}
    else{const x=legStats[0];html+=scoreBox(x&&x.g);if(x)html+=`<div class="meta" style="margin-top:4px" data-n1>${x.n?esc(x.n):""}${legBar(b,x,x.g&&x.g.state==="in"?legP(b,x.L,x.s,x):null)}</div>`}
    const anyLive=legStats.some(x=>x.g&&x.g.state==="in");
    if(anyLive)html+=liveDetail(b,legStats)+`<div class="spkw"><span class="spk-t">Win chance since page opened</span><div data-spk>${sparkSVG(k)}</div></div>`;
    html+=BR.html+`</div></div>`;
    const gs=(b.match?[gameFor(b.match)]:b.legs.map(L=>gameFor(L.match))).filter(Boolean);
    const t=Math.min(...gs.map(g=>g.date?new Date(g.date).getTime():Infinity),Infinity);
    const allFinal=gs.length&&gs.length===(b.match?1:b.legs.length)&&gs.every(g=>g.completed);
    const graded=status==="WON"||status==="LOST"||(status==="PUSH"&&allFinal);
    // At risk / payout come from DATA.unsettled (all bets still open in the tracker, finals included); FINAL_BI = final-but-unsettled
    if(allFinal)FINAL_BI.add(D.open.indexOf(b));
    if(graded&&b.date===TODAY){if(status==="WON"){if(b.to_win!=null)tonight+=b.to_win;else tonightTBC++}else if(status==="LOST")tonight-=b.stake||0}
    const BK={book:b.book,stake:b.stake||0};const toFinal=()=>{if(!FINSEEN.has(k)){FINSEEN.add(k);if(OPEN.delete(k))html=html.replace(" open\"","\"");saveUI()}};
    if(status==="LOST"){toFinal();lostCards.push({html,...BK});lostPending+=b.stake||0}
    else if(gs.some(g=>g.state==="in"))liveCards.push({html,...BK});
    else if(gs.length&&gs.length===(b.match?1:b.legs.length)&&gs.every(g=>g.completed)){toFinal();wonCards.push({html,...BK});if(status==="WON")wonPending+=b.to_win||0}
    else upCards.push({html,t,...BK})});
  upCards.sort((a,b)=>a.t-b.t);
  // per-book "(wagered)" = cash stake of ALL unsettled bets of that book (bonus bets 0); Total equals the At-risk tile
  const WAG={};for(const x of D.open)WAG[bkey(x.book)]=(WAG[bkey(x.book)]||0)+(x.cash_stake||0);const wagT=Object.values(WAG).reduce((a,v)=>a+v,0);
  setHTML($("bal"),D.balances.map(b=>`<div><span class="bn">${esc(b.book)}</span><span class="bv"><b>${money(b.balance)}</b><i class="wag">(${money(WAG[bkey(b.book)]||0)})</i></span></div>`).join("")+`<div class="tot"><span class="bn">Total</span><span class="bv"><b>${money(D.total)}</b><i class="wag">(${money(wagT)})</i></span></div>`);
  for(const x of D.settled_recent||[])if(x.date===TODAY&&x.pnl!=null)tonight+=x.pnl;
  const sg=v=>(v>=0?"+":"−")+money(Math.abs(v));
  $("sum").innerHTML=`<div>At risk<b>${money(D.unsettled.cash_stake)}</b><small>${D.unsettled.n} unsettled bet${D.unsettled.n===1?"":"s"}${FINAL_BI.size?` · ${FINAL_BI.size} final, awaiting settle`:""}</small></div><div>Tonight so far<b class="${tonight>=0?"pos":"neg"}">${sg(tonight)}</b><small>${tonightTBC?`+ ${tonightTBC} win TBC`:"today's bets, live-graded"}</small></div><div>Potential payout<b id="expPay">…</b><small id="expSub"></small></div><div>Expected P&amp;L (est.)<b id="expPL">…</b><small>probability-weighted, our estimate</small></div><div class="wide">Tracker P&amp;L<b class="${D.pnl_total>=0?"pos":"neg"}">${sg(D.pnl_total)}</b><small>settled, all time</small></div>`;
  const sy=window.scrollY;   // patch only what changed, keep the reader's scroll position
  setHTML($("live"),byBook(liveCards)||'<div class="meta">Nothing live right now.</div>');
  setHTML($("bets"),byBook(upCards)||'<div class="meta">Nothing upcoming.</div>');
  $("liveN").textContent=liveCards.length||"";$("upN").textContent=upCards.length||"";
  $("wonCards").innerHTML=wonCards.length?`<div class="meta" style="margin:0 2px 6px">Final, not settled in the tracker yet</div>`+byBook(wonCards):"";
  const row=s=>`<div class="set"><span>${esc(s.date.slice(5))} ${esc(s.book)} · ${esc(s.pick)}</span><b class="${(s.pnl||0)>=0?"pos":"neg"}">${/void/i.test(s.result)?"Void · stake back":s.pnl==null?esc(s.result):((s.pnl>=0?"+":"−")+money(Math.abs(s.pnl)))}</b></div>`;
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
}
let FAST=10000, fastTimer=null, loading=false;
async function loadData(){try{const d=await getJSON("data.json?t="+Date.now());if(!d||typeof d!=="object"||!Array.isArray(d.open)||!Array.isArray(d.settled_recent)||!d.balances||typeof d.balances!=="object")throw new Error("bad data");DATA=d}catch(e){if(!DATA){$("meta").textContent="Couldn't load data.json";return false}}return true}
let loadingAt=0;
async function fastTick(full){clearTimeout(fastTimer);if(loading&&Date.now()-loadingAt>30000)loading=false;if(!DATA||loading)return schedule();loading=true;loadingAt=Date.now();espnErr=false;tickCD();
  try{await refreshScores(full);await Promise.all([refreshProbs(),refreshPM().catch(()=>{}),refreshAN().catch(()=>{})]);if(full)await refreshPregame()}finally{loading=false}
  FAST=espnErr?30000:10000;try{render()}catch(e){console.error(e)}schedule()}
let nextAt=0;
function schedule(){clearTimeout(fastTimer);if(!document.hidden){nextAt=Date.now()+FAST;fastTimer=setTimeout(()=>fastTick(false),FAST)}tickCD()}
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
