(function(){
'use strict';
var TZ='America/Toronto', PAGE=50, REFRESH=60000, RUNS_REFRESH=300000;
var RUNS_URL='https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/autorun.yml/runs?per_page=30';
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){var n=typeof v==='number'?v:parseFloat(v);return isFinite(n)?n:0}
function money(n,sign){n=num(n);var a=Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
  var s=n<0?'\u2212':(sign&&n>0?'+':'');return s+'$'+a}
function cls(n){return n>0?'pos':n<0?'neg':'muted'}
function arr(v){return Array.isArray(v)?v:[]}
function safeGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function safeSet(k,v){try{localStorage.setItem(k,v);return true}catch(e){return false}}
function safeDel(k){try{localStorage.removeItem(k)}catch(e){}}

var dtf=new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
var dayf=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
var dayLabel=new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'long',month:'short',day:'numeric',year:'numeric'});
var timef=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'});
var etf=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'});
function etOffset(ms){var o={};etf.formatToParts(new Date(ms)).forEach(function(p){o[p.type]=+p.value});return Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute,o.second)-Math.floor(ms/1000)*1000}
function pd(ts){if(ts==null||ts==='')return null;var m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*E[SD]?T)?$/.exec(String(ts).trim());
  if(m){/* naive timestamp = Eastern wall clock */var g=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));var d=new Date(g-etOffset(g));d=new Date(g-etOffset(d.getTime()));return isNaN(d)?null:d}
  var d2=new Date(ts);return isNaN(d2)?null:d2}
function fmtDT(ts){var d=pd(ts);return d?dtf.format(d)+' ET':'\u2014'}
function fmtTime(ts){var d=pd(ts);return d?timef.format(d):''}
function dayKey(ts){var d=pd(ts);return d?dayf.format(d):'unknown'}
function ago(ts){var d=pd(ts);if(!d)return '';var s=Math.max(0,(Date.now()-d)/1000);
  if(s<90)return 'just now';var m=s/60;if(m<90)return Math.round(m)+' min ago';var h=m/60;if(h<36)return Math.round(h)+' h ago';return Math.round(h/24)+' d ago'}
var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],MONL=['January','February','March','April','May','June','July','August','September','October','November','December'];
function ymLabel(ym){var m=/^(\d{4})-(\d{2})/.exec(ym||'');return m?MONL[+m[2]-1]+' '+m[1]:(ym||'Unknown')}
function fmtDate(d){var m=/^(\d{4})-(\d{2})-(\d{2})/.exec(d||'');return m?MON[+m[2]-1]+' '+(+m[3]):(d||'')}

/* ---------- state ---------- */
var S={tab:'archive',arch:null,log:null,bets:[],q:'',book:'all',res:'all',month:'all',sort:'new',shown:PAGE,
  collapsed:{},types:Object.create(null),archErr:null,logErr:null,runs:null,runsErr:null,runsAt:0,rawA:'',rawL:'',rawD:'',recs:null,recOpen:Object.create(null),filtered:[],open:[],openLoaded:false,dataErr:null,st:Object.create(null),token:'',tokenBad:false,tokenDraft:'',tokenMsg:''};
var TABS=['archive','activity','picks','runs'];

/* ---------- tabs ---------- */
function setTab(t,focus){if(TABS.indexOf(t)<0)t='archive';S.tab=t;
  TABS.forEach(function(x){var on=x===t,b=$('tab-'+x);b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1;$('pane-'+x).hidden=!on;if(on&&focus)b.focus()});
  try{history.replaceState(null,'','#'+t)}catch(e){location.hash=t}
  if(t==='runs')loadRuns(false)}
document.querySelector('[role=tablist]').addEventListener('click',function(e){var b=e.target.closest('[data-tab]');if(b)setTab(b.dataset.tab)});
document.querySelector('[role=tablist]').addEventListener('keydown',function(e){
  var i=TABS.indexOf(S.tab),k=e.key;
  if(k==='ArrowRight')i=(i+1)%TABS.length;else if(k==='ArrowLeft')i=(i+TABS.length-1)%TABS.length;else if(k==='Home')i=0;else if(k==='End')i=TABS.length-1;else return;
  e.preventDefault();setTab(TABS[i],true)});
window.addEventListener('hashchange',function(){var t=location.hash.slice(1);if(TABS.indexOf(t)>=0&&t!==S.tab)setTab(t)});

/* ---------- data ---------- */
function getJSON(url){return fetch(url+'?t='+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text()})}
function loadAll(){
  var pa=getJSON('archive.json').then(function(t){S.archErr=null;if(t!==S.rawA){var j=JSON.parse(t);S.rawA=t;S.arch=j&&typeof j==='object'?j:{};prepBets();return true}return false}).catch(function(e){S.archErr=e.message||'error';return true});
  var pl=getJSON('log.json').then(function(t){S.logErr=null;if(t!==S.rawL){var j=JSON.parse(t);S.rawL=t;S.log=j&&typeof j==='object'?j:{};return true}return false}).catch(function(e){S.logErr=e.message||'error';return true});
  var pd_=getJSON('data.json').then(function(t){S.dataErr=null;if(t!==S.rawD){var j=JSON.parse(t);S.rawD=t;prepOpen(j&&typeof j==='object'?j:{});return true}return false}).catch(function(e){S.dataErr=e.message||'error';return !S.openLoaded});
  return Promise.all([pa,pl,pd_]).then(function(r){if(r[0]){buildArchiveControls();renderArchive()}if(r[1])renderActivity();if(r[2]){renderSettle();renderPicks()}reconcile();renderSub()})}
function prepBets(){
  S.bets=arr(S.arch&&S.arch.bets).map(function(b,i){b=b||{};var res=String(b.result||'').toLowerCase();
    if(res==='push'||res==='voided'||res==='void')res='void';else if(res==='win')res='won';else if(res==='loss')res='lost';
    var d=String(b.date||'');
    return {i:i,id:String(b.bet_id||''),date:d,ym:d.slice(0,7),book:String(b.book||''),event:String(b.event||''),market:String(b.market||''),pick:String(b.pick||''),
      price:b.price,bprice:b.boosted_price,stake:num(b.stake),to_win:num(b.to_win),result:res,pnl:num(b.pnl),settled_at:b.settled_at||'',settled_by:b.settled_by||'',
      hay:(String(b.pick||'')+' '+(b.event||'')+' '+(b.book||'')+' '+(b.market||'')).toLowerCase()}})}
function renderSub(){var a=S.arch,l=S.log,bits=[];
  if(a&&a.generated_at)bits.push('Archive updated '+ago(a.generated_at));
  if(l&&l.generated_at)bits.push('log updated '+ago(l.generated_at));
  $('sub').textContent=bits.length?bits.join(' \u00b7 '):'Bets older than '+((a&&a.cutoff_days)||5)+' days are archived here.';
  $('foot').textContent='Times in Eastern (Toronto). Auto-refreshes every minute.'}

/* ---------- archive ---------- */
function opt(v,t){var o=document.createElement('option');o.value=v;o.textContent=t;return o}
function fillSelect(sel,items,allLabel){var cur=sel.value||'all';sel.textContent='';sel.appendChild(opt('all',allLabel));
  items.forEach(function(x){sel.appendChild(opt(x[0],x[1]))});
  var has=Array.prototype.some.call(sel.options,function(o){return o.value===cur});sel.value=has?cur:'all';return sel.value}
function buildArchiveControls(){
  var books={},months={};S.bets.forEach(function(b){if(b.book)books[b.book]=1;if(b.ym)months[b.ym]=1});
  var ml=arr(S.arch&&S.arch.months).filter(function(m){return typeof m==='string'});Object.keys(months).forEach(function(m){if(ml.indexOf(m)<0)ml.push(m)});
  ml.sort().reverse();
  S.book=fillSelect($('fbook'),Object.keys(books).sort().map(function(b){return [b,b]}),'All books');
  S.month=fillSelect($('fmonth'),ml.map(function(m){return [m,ymLabel(m)]}),'All months')}
function applyFilters(){
  var q=S.q.trim().toLowerCase(),terms=q?q.split(/\s+/):[];
  var r=S.bets.filter(function(b){
    if(S.book!=='all'&&b.book!==S.book)return false;
    if(S.res!=='all'&&b.result!==S.res)return false;
    if(S.month!=='all'&&b.ym!==S.month)return false;
    for(var i=0;i<terms.length;i++)if(b.hay.indexOf(terms[i])<0)return false;return true});
  var key=function(b){return b.date+'|'+(b.settled_at||'')+'|'+String(100000-b.i)};
  var s=S.sort;
  r.sort(function(a,b){
    if(s==='win')return b.pnl-a.pnl||a.i-b.i;if(s==='loss')return a.pnl-b.pnl||a.i-b.i;
    var ka=a.date,kb=b.date;if(ka!==kb)return s==='old'?(ka<kb?-1:1):(ka<kb?1:-1);
    return s==='old'?b.i-a.i:a.i-b.i});
  return r}
function stats(list){var w=0,l=0,v=0,st=0,p=0;list.forEach(function(b){if(b.result==='won')w++;else if(b.result==='lost')l++;else v++;
  if(b.result!=='void')st+=b.stake;p+=b.pnl});return {n:list.length,w:w,l:l,v:v,staked:st,pnl:p,roi:st>0?p/st*100:null}}
function rec(s){return s.w+'-'+s.l+(s.v?'-'+s.v:'')}
function renderSummary(s){
  var tiles=[['Bets',String(s.n),''],['Record',rec(s),s.n?((s.w+s.l)?Math.round(s.w/(s.w+s.l)*100)+'% win':''):''],['Staked',money(s.staked),''],
    ['P&L',money(s.pnl,true),'','c'+cls(s.pnl)],['ROI',s.roi==null?'\u2014':(s.roi>0?'+':s.roi<0?'\u2212':'')+Math.abs(s.roi).toFixed(1)+'%','','c'+cls(s.roi||0)]];
  $('sum').innerHTML=tiles.map(function(t){var c=t[3]?' '+t[3].slice(1):'';return '<div class="kpi"><div class="l">'+esc(t[0])+'</div><div class="v'+c+'">'+esc(t[1])+'</div>'+(t[2]?'<div class="s">'+esc(t[2])+'</div>':'')+'</div>'}).join('')}
function priceHtml(b){var p=b.price,bp=b.bprice,fmt=function(x){if(x==null||x==='')return '';if(typeof x==='number'||/^-?\d+(\.\d+)?$/.test(String(x))){var n=num(x);return Math.abs(n)>=100?(n>0?'+':'')+n:String(x)}return String(x)};
  var a=fmt(p),c=fmt(bp);if(c&&c!==a)return '<span class="px"><b>'+esc(c)+'</b> <s>'+esc(a)+'</s></span>';return '<span class="px">'+esc(a||'\u2014')+'</span>'}
function chipHtml(r){var t=r==='won'?'W':r==='lost'?'L':r==='void'?'Void':(r||'\u2014');return '<span class="chip '+esc(r==='won'||r==='lost'||r==='void'?r:'')+'">'+esc(t)+'</span>'}
function pnlHtml(b){return '<span class="pnl '+cls(b.pnl)+'">'+esc(b.result==='void'&&!b.pnl?'$0.00':money(b.pnl,true))+'</span>'}
function cardHtml(b){return '<article class="bcard"><div class="l1"><span class="pick">'+esc(b.pick||'(no pick)')+'</span>'+pnlHtml(b)+'</div>'+
  '<div class="ev">'+esc(b.event)+(b.market?' \u00b7 '+esc(b.market):'')+'</div>'+
  '<div class="l3"><span>'+esc(fmtDate(b.date))+' \u00b7 '+esc(b.book)+' \u00b7 '+priceHtml(b)+' \u00b7 '+esc(money(b.stake))+'</span>'+chipHtml(b.result)+'</div></article>'}
function tableHtml(list){return '<div class="tbl-wrap wide"><table class="tbl"><thead><tr><th>Date</th><th>Book</th><th>Pick</th><th class="r">Odds</th><th class="r">Stake</th><th class="r">To win</th><th>Result</th><th class="r">P&amp;L</th></tr></thead><tbody>'+
  list.map(function(b){return '<tr><td class="num" style="white-space:nowrap">'+esc(fmtDate(b.date))+'</td><td>'+esc(b.book)+'</td><td class="pk"><div>'+esc(b.pick||'(no pick)')+'</div><div class="ev">'+esc(b.event)+'</div>'+(b.market?'<div class="mk">'+esc(b.market)+'</div>':'')+'</td><td class="r">'+priceHtml(b)+'</td><td class="r">'+esc(money(b.stake))+'</td><td class="r">'+esc(money(b.to_win))+'</td><td>'+chipHtml(b.result)+'</td><td class="r">'+pnlHtml(b)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function renderArchive(){
  var box=$('arch-list');
  if(S.archErr&&!S.arch){box.innerHTML='<div class="panel empty">Archive unavailable ('+esc(S.archErr)+'). It will appear once the first archive run completes.</div>';$('sum').innerHTML='';$('more').hidden=true;S.filtered=[];return}
  if(!S.bets.length){box.innerHTML='<div class="panel empty">No archived bets yet. Bets older than '+esc((S.arch&&S.arch.cutoff_days)||5)+' days will show up here.</div>';$('sum').innerHTML='';$('more').hidden=true;S.filtered=[];return}
  var f=applyFilters();S.filtered=f;renderSummary(stats(f));
  if(!f.length){box.innerHTML='<div class="panel empty">No bets match these filters.</div>';$('more').hidden=true;return}
  var vis=f.slice(0,S.shown),html='';
  if(S.sort==='new'||S.sort==='old'){
    var order=[],all={},seen={};
    f.forEach(function(b){var k=b.ym||'unknown';(all[k]=all[k]||[]).push(b)});
    vis.forEach(function(b){var k=b.ym||'unknown';if(!seen[k]){seen[k]=[];order.push(k)}seen[k].push(b)});
    order.forEach(function(k){var s=stats(all[k]),open=!S.collapsed[k],id='m-'+k;
      html+='<section class="mgroup"><button type="button" class="mhead" data-m="'+esc(k)+'" aria-expanded="'+open+'" aria-controls="'+esc(id)+'"><span class="caret" aria-hidden="true"></span><span class="mname">'+esc(ymLabel(k))+'</span>'+
        '<span class="mmeta"><span>'+s.n+' bet'+(s.n===1?'':'s')+'</span><span>'+esc(rec(s))+'</span><span class="mpnl '+cls(s.pnl)+'">'+esc(money(s.pnl,true))+'</span></span></button>'+
        '<div class="mbody" id="'+esc(id)+'"'+(open?'':' hidden')+'><div class="cards">'+seen[k].map(cardHtml).join('')+'</div>'+tableHtml(seen[k])+'</div></section>'})
  }else{
    html='<div class="ranked">Ranked by '+(S.sort==='win'?'biggest win':'biggest loss')+'</div><section class="mgroup"><div class="mbody" style="border-top:1px solid var(--line);border-radius:var(--r)"><div class="cards">'+vis.map(cardHtml).join('')+'</div>'+tableHtml(vis)+'</div></section>'}
  box.innerHTML=html;
  var more=$('more');more.hidden=f.length<=vis.length;more.textContent='Load more ('+(f.length-vis.length)+' left)'}
$('arch-list').addEventListener('click',function(e){var h=e.target.closest('.mhead');if(!h)return;var k=h.dataset.m,open=h.getAttribute('aria-expanded')==='true';
  S.collapsed[k]=open;h.setAttribute('aria-expanded',!open);var b=$(('m-'+k));if(b)b.hidden=open});
$('more').addEventListener('click',function(){S.shown+=PAGE;renderArchive()});
var qt;$('q').addEventListener('input',function(){clearTimeout(qt);qt=setTimeout(function(){S.q=$('q').value;S.shown=PAGE;renderArchive()},120)});
[['fbook','book'],['fres','res'],['fmonth','month'],['fsort','sort']].forEach(function(p){$(p[0]).addEventListener('change',function(){S[p[1]]=this.value;S.shown=PAGE;renderArchive()})});
$('reset').addEventListener('click',function(){S.q='';S.book=S.res=S.month='all';S.sort='new';S.shown=PAGE;$('q').value='';$('fbook').value=$('fres').value=$('fmonth').value='all';$('fsort').value='new';renderArchive()});
function csvCell(v){var s=String(v==null?'':v);if(typeof v!=='number'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
$('csv').addEventListener('click',function(){
  var f=S.filtered;if(!f.length){return}
  var head=['bet_id','date','book','event','market','pick','price','boosted_price','stake','to_win','result','pnl','settled_at','settled_by'];
  var raw=arr(S.arch&&S.arch.bets);
  var lines=[head.join(',')];f.forEach(function(b){var o=raw[b.i]||{};lines.push(head.map(function(h){return csvCell(h==='result'?b.result:o[h])}).join(','))});
  var blob=new Blob(['\ufeff'+lines.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'});
  var u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='bet-archive-'+dayf.format(new Date())+'.csv';
  document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},4000)});

/* ---------- activity ---------- */
var TYPE_NAMES={stake:'Stakes','return':'Returns',anchor:'Anchors',adjust:'Adjustments',adjustment:'Adjustments',settle:'Settles',settled:'Settled',archive:'Archive runs'};
function typeName(t){return Object.prototype.hasOwnProperty.call(TYPE_NAMES,t)?TYPE_NAMES[t]:(t?t.charAt(0).toUpperCase()+t.slice(1):'Other')}
function safeCls(t){return String(t||'').toLowerCase().replace(/[^a-z0-9_-]/g,'')}
function renderActivity(){
  var l=S.log,ab=$('auto-box'),rb=$('runs-box');
  if(!l){var m=S.logErr?'Activity log unavailable ('+esc(S.logErr)+').':'Loading\u2026';ab.innerHTML='<div class="panel empty">'+m+'</div>';rb.innerHTML='';$('type-chips').innerHTML='';$('ev-list').innerHTML='';return}
  var a=l.auto||{},ls=arr(a.last_settled),errs=arr(a.errors),nr=num(a.needs_review_count);
  var st=errs.length?'bad':nr?'warn':'ok';
  ab.innerHTML='<div class="panel note-panel"><span class="dot '+st+'" aria-hidden="true"></span><div class="grow"><h3 style="margin:0">Auto-settle</h3>'+
    '<div class="kv"><div><div class="l">Last change</div><div class="v">'+esc(a.last_change_at?fmtDT(a.last_change_at):'\u2014')+'</div>'+(a.last_change_at?'<div class="muted" style="font-size:11.5px">'+esc(ago(a.last_change_at))+'</div>':'')+'</div>'+
    '<div><div class="l">Needs review</div><div class="v '+(nr?'':'')+'">'+nr+'</div></div>'+
    '<div><div class="l">Last settled</div><div class="v">'+ls.length+'</div></div>'+
    '<div><div class="l">Errors</div><div class="v '+(errs.length?'neg':'')+'">'+errs.length+'</div></div></div>'+
    (errs.length?'<ul class="errs">'+errs.slice(0,5).map(function(x){return '<li>'+esc(typeof x==='string'?x:JSON.stringify(x))+'</li>'}).join('')+'</ul>':'')+'</div></div>';
  var runs=arr(l.archive_runs).filter(function(r){return r&&r.ts});
  if(runs.length){rb.innerHTML='<div class="panel"><h3>Archive runs</h3><ul class="tl">'+runs.slice(0,5).map(function(r){var n=num(r.moved);
    return '<li class="t-archive"><div class="top"><span class="chip">archive</span><span class="tm">'+esc(fmtDT(r.ts))+'</span></div><div class="nt">Archived '+n+' bet'+(n===1?'':'s')+' older than '+esc(num(S.arch&&S.arch.cutoff_days)||5)+' days</div></li>'}).join('')+'</ul></div>'}else rb.innerHTML='';
  var evs=arr(l.events).filter(function(e){return e&&typeof e==='object'});
  var types=Object.create(null);evs.forEach(function(e){var t=String(e.type||'other');types[t]=(types[t]||0)+1});
  var tk=Object.keys(types).sort();
  $('type-chips').innerHTML=tk.map(function(t){var on=S.types[t]!==false;return '<button type="button" class="chip" data-t="'+esc(t)+'" aria-pressed="'+on+'">'+esc(typeName(t))+' '+types[t]+'</button>'}).join('');
  var list=evs.filter(function(e){return S.types[String(e.type||'other')]!==false});
  var el=$('ev-list');
  if(!evs.length){el.innerHTML='<div class="panel empty">No ledger events yet.</div>';return}
  if(!list.length){el.innerHTML='<div class="panel empty">All event types are hidden. Tap a chip above.</div>';return}
  var days=[],g={};list.slice(0,400).forEach(function(e){var k=dayKey(e.ts);if(!g[k]){g[k]=[];days.push(k)}g[k].push(e)});
  el.innerHTML=days.map(function(k){var d=pd(g[k][0].ts);return '<h2 class="day">'+esc(d?dayLabel.format(d):'Unknown date')+'</h2><ul class="tl">'+g[k].map(function(e){
    var t=String(e.type||'other'),amt=num(e.amount),has=e.amount!=null&&e.amount!==''&&isFinite(amt)&&amt!==0;
    return '<li class="t-'+safeCls(t)+'"><div class="top"><span class="chip">'+esc(typeName(t).replace(/s$/,''))+'</span>'+(e.book?'<span class="bk">'+esc(e.book)+'</span>':'')+'<span class="tm">'+esc(fmtTime(e.ts))+'</span>'+
      (has?'<span class="amt '+cls(amt)+'">'+esc(money(amt,true))+'</span>':'')+'</div>'+(e.label||e.note?'<div class="nt">'+esc([e.label,e.note].filter(Boolean).join(' \u2014 '))+'</div>':'')+'</li>'}).join('')+'</ul>'}).join('')}
$('type-chips').addEventListener('click',function(e){var b=e.target.closest('[data-t]');if(!b)return;var t=b.dataset.t;S.types[t]=S.types[t]===false;renderActivity();
  Array.prototype.some.call($('type-chips').querySelectorAll('[data-t]'),function(n){if(n.dataset.t===t){n.focus();return true}})});

/* ---------- awaiting result (manual settle) ---------- */
var REPO_API='https://api.github.com/repos/s-chuch/bet-dashboard/actions/workflows/manual-settle.yml';
var TOKEN_KEY='bt.gh.settle',ID_RE=/^[0-9a-f]{8}(-[0-9]{1,3})?$/,PROFIT_RE=/^[0-9]+(\.[0-9]{1,2})?$/,TOKEN_RE=/^[A-Za-z0-9_\-]{20,255}$/;
var POLL_MS=8000,POLL_MAX=240000,RES_API={win:'won',void:'void',loss:'lost'},RES_LBL={win:'WIN',void:'VOID',loss:'LOSS'};
S.token=safeGet(TOKEN_KEY)||'';if(!TOKEN_RE.test(S.token))S.token='';
function startMs(b){var m=/(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(b.start||'');if(!m)return Infinity;
  var mi=MON.indexOf(m[1].charAt(0).toUpperCase()+m[1].slice(1).toLowerCase());if(mi<0)return Infinity;
  var dm=/^(\d{4})-(\d{2})/.exec(b.date||''),y=dm?+dm[1]:new Date().getFullYear();if(dm&&mi<+dm[2]-1)y++;
  var h=+m[3]%12+(/p/i.test(m[5])?12:0);return Date.UTC(y,mi,+m[2],h,+m[4])}
function revKey(b){return [b.book,b.event,b.pick,num(b.stake).toFixed(2)].join('|')}
function prepOpen(d){
  S.recs=d.recs&&typeof d.recs==='object'?d.recs:null;
  var nr=arr(d.auto&&d.auto.needs_review).filter(function(x){return x&&typeof x==='object'}),byId={},byKey={};
  nr.forEach(function(x){if(x.bet_id)byId[x.bet_id]=x;byKey[revKey(x)]=x});
  S.open=arr(d.open).filter(function(b){return b&&typeof b==='object'}).map(function(b,i){
    var id=ID_RE.test(String(b.bet_id||''))?String(b.bet_id):'';
    var r=(id&&byId[id])||byKey[revKey(b)]||null;
    return {i:i,id:id,book:String(b.book||''),event:String(b.event||''),market:String(b.market||''),pick:String(b.pick||''),stake:num(b.stake),
      toWin:(typeof b.to_win==='number'&&b.to_win>0)?b.to_win:null,price:b.price,bprice:b.boosted_price,start:String(b.start||''),sk:startMs(b),
      review:!!r,reason:r?String(r.reason||'Needs review'):''}});
  S.open.sort(function(a,b){return (b.review-a.review)||(a.sk===b.sk?a.i-b.i:a.sk<b.sk?-1:1)});
  S.openLoaded=true}
function betById(id){for(var i=0;i<S.open.length;i++)if(S.open[i].id===id)return S.open[i];return null}
function stOf(id){return S.st[id]||(S.st[id]={mode:'idle'})}
function busy(st){return st&&(st.mode==='sending'||st.mode==='queued')}
function focusKey(el){return el?(el.id||((el.dataset.act||'')+'|'+(el.dataset.id||''))):''}
function stateLine(st){
  if(st.mode==='sending')return ['run','Sending to GitHub…'];
  if(st.mode==='queued'){var t=st.runState==='in_progress'?'Running…':st.runState==='success'?'Run finished — waiting for the site to update…':st.runState==='queued'?'Queued — updating…':'Queued — updating…';return ['run',t]}
  if(st.mode==='done')return ['ok','Settled'];return null}
function actionsHtml(b,st,off){
  var dis=off?' disabled':'';
  return '<div class="sact">'+['win','void','loss'].map(function(k){var l=k==='win'?'Win':k==='void'?'Void':'Loss';
    return '<button type="button" class="sbtn '+k+'" data-act="pick" data-r="'+k+'" data-id="'+esc(b.id)+'" aria-label="Mark '+l+': '+esc(b.pick)+'"'+dis+'>'+l+'</button>'}).join('')+'</div>'}
function confirmHtml(b,st){
  var needP=st.result==='win'&&b.toWin==null,id=esc(b.id);
  return '<div class="sconf" role="group" aria-label="Confirm result">'+
    '<div class="q">Mark <b class="r-'+esc(st.result)+'">'+esc(RES_LBL[st.result])+'</b> for '+esc(b.pick)+' ('+esc(money(b.stake))+')?</div>'+
    (needP?'<label class="pf"><span class="lbl">Profit ($)</span><input type="text" inputmode="decimal" id="pf-'+id+'" data-profit="'+id+'" value="'+esc(st.profit||'')+'" placeholder="e.g. 12.50" autocomplete="off" required aria-required="true"'+(st.perr?' aria-invalid="true"':'')+'></label>'+
      (st.perr?'<div class="serr" role="alert">'+esc(st.perr)+'</div>':'<div class="shint">This bet has no known to-win amount, so enter the profit (net winnings, not the payout).</div>'):'')+
    '<div class="srow"><button type="button" class="btn sgo '+esc(st.result)+'" data-act="confirm" data-id="'+id+'">Confirm</button><button type="button" class="btn" data-act="cancel" data-id="'+id+'">Cancel</button></div></div>'}
function settleCard(b){
  var st=S.st[b.id]||{mode:'idle'},bits=[];
  bits.push('<span><span class="k">Stake</span> '+esc(money(b.stake))+'</span>');
  bits.push('<span><span class="k">To win</span> '+(b.toWin!=null?esc(money(b.toWin)):'—')+'</span>');
  bits.push('<span class="k2">'+priceHtml({price:b.price,bprice:b.bprice})+'</span>');
  if(b.start)bits.push('<span><span class="k">Start</span> '+esc(b.start)+'</span>');
  var h='<article class="scard'+(b.review?' review':'')+(st.mode==='done'?' done':'')+'" data-card="'+esc(b.id||('i'+b.i))+'"><div class="l1"><span class="pick">'+esc(b.pick||'(no pick)')+'</span>'+(b.review?'<span class="chip warn">Needs review</span>':'')+'</div>'+
    '<div class="ev">'+esc(b.book)+(b.event?' · '+esc(b.event):'')+(b.market?' · '+esc(b.market):'')+'</div><div class="smeta">'+bits.join('')+'</div>'+
    (b.review?'<div class="sreason">'+esc(b.reason)+'</div>':'');
  if(!b.id){return h+'<div class="snote">Settle buttons unavailable: this bet has no id in data.json yet. It appears after the next build.</div></article>'}
  var sl=stateLine(st);
  if(sl)h+='<div class="sstat '+sl[0]+'" role="status"><span class="dot '+sl[0]+'" aria-hidden="true"></span><span>'+esc(sl[1])+'</span></div>';
  if(st.mode==='confirm')h+=confirmHtml(b,st);
  else if(st.mode!=='done'){
    if(st.err)h+='<div class="serr" role="alert">'+esc(st.err)+(st.runId?' <a href="https://github.com/s-chuch/bet-dashboard/actions/runs/'+esc(st.runId)+'" target="_blank" rel="noopener noreferrer">View run</a>':'')+'</div>';
    h+=actionsHtml(b,st,busy(st)||!S.token)}
  return h+'</article>'}
function connectHtml(){
  var bad=S.tokenBad;
  return '<div class="sconnect"><div class="ct">'+(bad?'GitHub token rejected':'Connect GitHub')+'</div>'+
    (bad?'<div class="serr" role="alert">'+esc(S.tokenMsg||'The saved token was rejected (bad or expired). Paste a new one.')+'</div>':'<p class="muted" style="margin:4px 0 8px;font-size:13px">One-time setup so the Win / Void / Loss buttons can run the settle workflow.</p>')+
    '<ol><li>On GitHub: Settings → Developer settings → Fine-grained tokens → Generate new token.</li>'+
    '<li>Repository access: <b>Only select repositories</b> → s-chuch/bet-dashboard. Permissions: <b>Actions: Read and write</b> and <b>Metadata: Read-only</b>, nothing else.</li>'+
    '<li>Paste the token here. It stays in this browser only and is sent only to api.github.com.</li></ol>'+
    '<div class="trow"><input type="password" id="tok-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" aria-label="GitHub fine-grained token" value="'+esc(S.tokenDraft)+'"><button type="button" class="btn pri" data-act="savetok">Save</button></div>'+
    (S.tokenMsg&&!bad?'<div class="serr" role="alert">'+esc(S.tokenMsg)+'</div>':'')+'</div>'}
function renderSettle(){
  var box=$('settle-box');if(!box)return;
  var ae=document.activeElement,fk=ae&&box.contains(ae)?focusKey(ae):'',ss=null,se=null;
  if(fk&&ae.tagName==='INPUT'){try{ss=ae.selectionStart;se=ae.selectionEnd}catch(e){}}
  var h='<section class="panel settle" aria-labelledby="settle-h"><div class="shead"><h3 id="settle-h">Awaiting result'+(S.openLoaded?' <span class="chip">'+S.open.length+'</span>':'')+'</h3>'+
    (S.token?'<button type="button" class="btn sm" data-act="disconnect">Disconnect</button>':'')+'</div>';
  if(!S.token||S.tokenBad)h+=connectHtml();
  if(!S.openLoaded)h+=S.dataErr?'<div class="empty">Open bets unavailable ('+esc(S.dataErr)+').</div>':'<div class="skeleton" style="height:70px"></div>';
  else{var list=S.open.slice();Object.keys(S.st).forEach(function(id){var q=S.st[id];if(q.mode==='done'&&q.bet&&!betById(id))list.push(q.bet)});
    if(!list.length)h+='<div class="empty">No unsettled bets \ud83c\udf89</div>';else h+='<div class="slist">'+list.map(settleCard).join('')+'</div>'}
  box.innerHTML=h+'</section>';
  if(fk){var els=box.querySelectorAll('button,input'),i,t=null;for(i=0;i<els.length;i++)if(focusKey(els[i])===fk){t=els[i];break}
    if(t&&!t.disabled){t.focus();if(ss!=null){try{t.setSelectionRange(ss,se)}catch(e){}}}}}
function focusEl(sel){var e=$('settle-box').querySelector(sel);if(e)e.focus()}
function reconcile(){
  var changed=false;
  Object.keys(S.st).forEach(function(id){var st=S.st[id],here=!!betById(id);
    if(!here&&S.openLoaded){if(st.mode==='queued'||st.mode==='sending'){if(st.mode==='queued'){st.mode='done';changed=true;setTimeout(function(){delete S.st[id];renderSettle()},2500)}}
      else if(st.mode!=='done'){delete S.st[id];changed=true}}});
  if(changed)renderSettle()}
function ghHeaders(){return {'Authorization':'Bearer '+S.token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}
function apiMsg(r,fallback){return r.json().then(function(j){return j&&typeof j.message==='string'?j.message:fallback},function(){return fallback})}
function sendSettle(id){
  var st=stOf(id),b=betById(id);
  if(!b||busy(st))return;
  if(!ID_RE.test(id)){st.mode='idle';st.err='Invalid bet id; not sent.';renderSettle();return}
  if(!S.token){st.mode='idle';st.err='Connect GitHub first.';renderSettle();return}
  var profit='';
  if(st.result==='win'&&b.toWin==null){profit=String(st.profit||'').trim();
    if(!PROFIT_RE.test(profit)||!(parseFloat(profit)>0)){st.perr='Enter the profit as a positive amount, like 12 or 12.50.';renderSettle();focusEl('#pf-'+id);return}}
  st.bet=b;st.perr='';st.err='';st.runId='';st.runState='';st.mode='sending';renderSettle();
  var body=JSON.stringify({ref:'main',inputs:{bet_id:id,result:RES_API[st.result],profit:profit}});
  fetch(REPO_API+'/dispatches',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ghHeaders()),body:body,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}).then(function(r){
    if(r.status===204){st.mode='queued';st.at=Date.now();st.deadline=st.at+POLL_MAX;st.runState='queued';renderSettle();startPoll();return}
    return apiMsg(r,'HTTP '+r.status).then(function(m){
      st.mode='idle';
      if(r.status===401){S.tokenBad=true;S.tokenMsg='GitHub rejected the token (bad or expired). Paste a new one below.';st.err='Not sent: token rejected.'}
      else if(r.status===403){st.err=/rate limit/i.test(m)?'GitHub rate limit reached. Try again in a few minutes.':'Not allowed: the token lacks permission. It needs Actions: Read and write on s-chuch/bet-dashboard.'}
      else if(r.status===404)st.err='GitHub could not find the workflow, or the token has no access to s-chuch/bet-dashboard.';
      else if(r.status===422)st.err='GitHub rejected the request (422): '+m;
      else st.err='GitHub returned HTTP '+r.status+': '+m;
      renderSettle()})
  }).catch(function(){st.mode='idle';st.err='Network error: could not reach GitHub. Nothing was sent.';renderSettle()})}
var pollT=0,polling=false;
function startPoll(){if(!pollT)pollT=setInterval(tick,POLL_MS)}
function tracked(){return Object.keys(S.st).filter(function(id){return S.st[id].mode==='queued'})}
function tick(){
  if(document.hidden||polling)return;
  var ids=tracked();if(!ids.length){clearInterval(pollT);pollT=0;return}
  polling=true;var now=Date.now(),dirty=false;
  ids.forEach(function(id){var st=S.st[id];if(now>st.deadline&&st.runState!=='success'||now>st.deadline+POLL_MAX){st.mode='idle';st.err='Still not settled after 4 minutes. Check the run on GitHub, then refresh.';dirty=true}});
  var p=S.token?fetch(REPO_API+'/runs?per_page=5',{headers:ghHeaders(),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}).then(function(r){if(!r.ok){if(r.status===401){S.tokenBad=true;S.tokenMsg='GitHub rejected the token while checking the run.';dirty=true}return null}return r.json()}).catch(function(){return null}):Promise.resolve(null);
  p.then(function(j){
    var runs=arr(j&&j.workflow_runs).filter(function(r){return r&&/^\d+$/.test(String(r.id))&&r.event==='workflow_dispatch'}).sort(function(a,b){return Date.parse(a.created_at)-Date.parse(b.created_at)});
    var claimed={};ids.forEach(function(id){if(S.st[id].runId)claimed[S.st[id].runId]=1});
    ids.sort(function(a,b){return S.st[a].at-S.st[b].at}).forEach(function(id){var st=S.st[id];if(st.mode!=='queued')return;
      if(!st.runId){var r=runs.filter(function(r){return !claimed[r.id]&&Date.parse(r.created_at)>=st.at-60000})[0];if(r){st.runId=String(r.id);claimed[r.id]=1}}
      var run=st.runId&&runs.filter(function(r){return String(r.id)===st.runId})[0];
      if(run){var ns=run.status==='completed'?(run.conclusion==='success'?'success':'failed'):(run.status==='in_progress'?'in_progress':'queued');
        if(ns!==st.runState){st.runState=ns;dirty=true}
        if(ns==='failed'){st.mode='idle';st.err='The settle run failed ('+String(run.conclusion||'error')+'). The bet was not settled.';dirty=true}}});
    if(dirty)renderSettle();
    return loadAll()}).then(function(){polling=false},function(){polling=false})}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&tracked().length)tick()});
$('settle-box').addEventListener('click',function(e){
  var t=e.target.closest('[data-act]');if(!t||t.disabled)return;var a=t.dataset.act,id=t.dataset.id;
  if(a==='pick'){var st=stOf(id);if(busy(st))return;st.mode='confirm';st.result=t.dataset.r;st.err='';st.perr='';st.runId='';renderSettle();
    focusEl(st.result==='win'&&betById(id)&&betById(id).toWin==null?'#pf-'+id:'[data-act=confirm][data-id="'+id+'"]')}
  else if(a==='cancel'){var s2=stOf(id);s2.mode='idle';s2.perr='';renderSettle();focusEl('[data-act=pick][data-id="'+id+'"]')}
  else if(a==='confirm')sendSettle(id);
  else if(a==='savetok'){var v=($('tok-in').value||'').trim();
    if(!TOKEN_RE.test(v)){S.tokenDraft=v;S.tokenMsg='That does not look like a GitHub token. Paste the whole token.';renderSettle();focusEl('#tok-in');return}
    S.token=v;S.tokenDraft='';S.tokenBad=false;S.tokenMsg='';S.runs=null;S.runsErr=null;S.runsAuth=null;S.runsAt=0;if(!safeSet(TOKEN_KEY,v))S.tokenMsg='';renderSettle()}
  else if(a==='disconnect'){S.token='';S.tokenBad=false;S.tokenMsg='';S.tokenDraft='';S.runs=null;S.runsErr=null;S.runsAuth=null;S.runsAt=0;safeDel(TOKEN_KEY);renderSettle()}});
$('settle-box').addEventListener('input',function(e){var t=e.target;
  if(t.dataset&&t.dataset.profit){var st=stOf(t.dataset.profit);st.profit=t.value;if(st.perr){st.perr='';t.removeAttribute('aria-invalid');var er=t.closest('.sconf').querySelector('.serr');if(er)er.remove()}}
  else if(t.id==='tok-in')S.tokenDraft=t.value});
$('settle-box').addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='tok-in'){e.preventDefault();var b=$('settle-box').querySelector('[data-act=savetok]');if(b)b.click()}
  else if(e.key==='Enter'&&e.target.dataset&&e.target.dataset.profit){e.preventDefault();sendSettle(e.target.dataset.profit)}
  else if(e.key==='Escape'){var c=e.target.closest&&e.target.closest('.sconf');if(c){var cb=c.querySelector('[data-act=cancel]');if(cb)cb.click()}}});
renderSettle();

/* ---------- picks (recommendation log) ---------- */
function pct(v){v=parseFloat(v);return isFinite(v)?(v>0?'+':v<0?'−':'')+Math.abs(v).toFixed(1)+'%':'–'}
function recRec(a){a=a||{};return (+a.w||0)+'–'+(+a.l||0)+(a.p?'–'+(+a.p||0):'')}
function splitHtml(obj){return Object.keys(obj||{}).filter(function(k){var a=obj[k]||{};return (+a.w||0)+(+a.l||0)>0}).sort(function(x,y){var a=obj[x],b=obj[y];return ((+b.w||0)+(+b.l||0))-((+a.w||0)+(+a.l||0))}).map(function(k){var a=obj[k];
  return '<span class="sp"><span>'+esc(k)+'</span> <b>'+esc(recRec(a))+'</b>'+(a.roi_pct!=null?' <span class="muted">('+esc(pct(a.roi_pct))+')</span>':'')+'</span>'}).join('')}
function recRow(r){
  var res=String(r.result||'pending').toLowerCase(),k='rec|'+r.rec_id,open=!!S.recOpen[k],id='rb-'+safeCls(r.rec_id)+'-'+r.__i;
  var lab=res==='won'?'W':res==='lost'?'L':res==='pending'?'Pending':res==='void'||res==='push'?'Void':res;
  var cc=res==='won'?'won':res==='lost'?'lost':res==='pending'?'':'void';
  var un=r.units==null?'':num(r.units),u=un===''?'':(un>=0?'+':'−')+Math.abs(un).toFixed(2)+'u';
  var sel=String(r.selection||''),ev=String(r.event||'').replace(/\s*\([^)]*\)/g,'');
  var px=r.eff_price&&r.eff_price!==r.rec_price?esc(r.rec_price)+' → '+esc(r.eff_price):esc(r.rec_price||'?');
  return '<div class="rrow'+(open?' open':'')+'"><button type="button" class="rhead" data-rk="'+esc(k)+'" aria-expanded="'+open+'" aria-controls="'+esc(id)+'">'+
    '<span class="rl"><span class="chip '+cc+'">'+esc(lab)+'</span><span class="rd">'+esc(String(r.rec_date||'').slice(5))+'</span></span>'+
    '<span class="rm"><span class="rt">'+esc(/^(Draw|Over|Under)\b/i.test(sel)?sel+' · '+ev:sel)+'</span>'+
    '<span class="rs">'+esc(r.sport||'?')+' · '+esc(r.book||'')+' · <b>'+px+'</b>'+(r.ev_pct?' · EV '+esc(r.ev_pct)+'%':'')+(r.placed==='yes'?' · placed':'')+'</span></span>'+
    '<span class="rr">'+(u?'<b class="'+(un>=0?'pos':'neg')+'">'+esc(u)+'</b>':'')+'<small>'+esc(r.promo||'')+'</small></span><span class="caret" aria-hidden="true"></span></button>'+
    '<div class="rbody" id="'+esc(id)+'"'+(open?'':' hidden')+'><div class="ev">'+esc(r.event)+' · '+esc(r.market)+'</div>'+
    '<div class="rnums"><span>Rec <b>'+esc(r.rec_date)+' '+esc(r.rec_time_et||'')+'</b></span><span>Fair <b>'+(r.fair_pct?esc(r.fair_pct)+'%':'–')+'</b></span><span>Stake <b>'+esc(r.stake||'–')+'</b></span><span>Placed <b>'+esc(r.placed||'')+'</b></span>'+(r.friend==='yes'?'<span><b>Friend</b></span>':'')+'</div>'+
    (r.final_score?'<div class="rn">Final: '+esc(r.final_score)+'</div>':'')+(r.notes?'<div class="rn">'+esc(r.notes)+'</div>':'')+'<div class="rn">Source: '+esc(r.source||'')+'</div></div></div>'}
function renderPicks(){
  var box=$('picks-box'),R=S.recs;if(!box)return;
  if(!S.openLoaded){box.innerHTML=S.dataErr?'<div class="panel empty">Picks unavailable ('+esc(S.dataErr)+').</div>':'<div class="skeleton" style="height:120px"></div>';return}
  var recent=arr(R&&R.recent).filter(function(r){return r&&typeof r==='object'});
  if(!R||!R.stats||!R.stats.overall||!recent.length&&!num(R.stats.overall.n)){box.innerHTML='<div class="panel empty">No picks logged yet</div>';return}
  var o=R.stats.overall,pl=R.stats.by_placed||{},y=pl.yes||{},n=pl.no||{};
  var tiles=[['Win rate',o.win_pct==null?'–':(+o.win_pct||0)+'%',(+o.pending||0)+' pending',''],
    ['ROI, flat $1',pct(o.roi_pct),(num(o.units)>=0?'+':'−')+Math.abs(num(o.units)).toFixed(2)+'u on '+(+o.roi_n||0)+' picks',num(o.roi_pct)>=0?'pos':'neg'],
    ['Expected ROI (EV)',pct(o.exp_roi_pct),'what the prices promised',''],
    ['Wins vs expected',(o.wins_with_fair==null?'–':String(o.wins_with_fair))+' vs '+(o.exp_wins==null?'–':String(o.exp_wins)),'from Pinnacle fair %','']];
  var h='<div class="kpis psum">'+tiles.map(function(t){return '<div class="kpi"><div class="l">'+esc(t[0])+'</div><div class="v '+t[3]+'">'+esc(t[1])+'</div><div class="s">'+esc(t[2])+'</div></div>'}).join('')+'</div>';
  h+='<div class="panel psplit"><div class="srow2"><span class="sp"><span>Placed</span> <b>'+esc(recRec(y))+'</b> <span class="muted">('+esc(pct(y.roi_pct))+')</span></span><span class="sp"><span>Not placed</span> <b>'+esc(recRec(n))+'</b> <span class="muted">('+esc(pct(n.roi_pct))+')</span></span></div>'+
    '<div class="srow2">'+splitHtml(R.stats.by_promo)+'</div><div class="srow2">'+splitHtml(R.stats.by_sport)+'</div>'+
    '<div class="rn">Small sample ('+((+o.w||0)+(+o.l||0))+' graded): compare actual with expected. ROI excludes bonus bets.</div></div>';
  var shown=recent.slice(0,25);shown.forEach(function(r,i){r.__i=i});
  h+='<h2 class="day">Recent picks</h2><div class="rlist">'+shown.map(recRow).join('')+'</div>';
  if(recent.length>25)h+='<p class="foot">Showing the latest 25 of '+recent.length+'. Full log: recommendations.csv</p>';
  var ae=document.activeElement,fk=ae&&box.contains(ae)?ae.dataset.rk:'';
  box.innerHTML=h;
  if(fk){var els=box.querySelectorAll('[data-rk]');for(var i=0;i<els.length;i++)if(els[i].dataset.rk===fk){els[i].focus();break}}}
$('picks-box').addEventListener('click',function(e){var b=e.target.closest('[data-rk]');if(!b)return;var k=b.dataset.rk,open=b.getAttribute('aria-expanded')==='true';
  S.recOpen[k]=!open;b.setAttribute('aria-expanded',!open);b.parentNode.classList.toggle('open',!open);var body=$(b.getAttribute('aria-controls'));if(body)body.hidden=open});
renderPicks();

/* ---------- runs ---------- */
function loadRuns(force){
  if(!S.token){S.runs=null;S.runsErr=null;S.runsAuth='none';renderRuns();return}
  if(!force&&S.runsAt&&Date.now()-S.runsAt<RUNS_REFRESH)return;
  if(!S.runs&&!S.runsErr&&!S.runsAuth)$('run-list').innerHTML='<div class="skeleton" style="height:140px"></div>';
  S.runsAt=Date.now();
  fetch(RUNS_URL,{cache:'no-store',headers:ghHeaders(),credentials:'omit',referrerPolicy:'no-referrer'}).then(function(r){
    if(r.status===401||r.status===403||r.status===404){var e=new Error('auth');e.auth=r.status;throw e}
    if(r.status===429)throw new Error('GitHub rate limit reached. Try again in a few minutes.');
    if(!r.ok)throw new Error('GitHub API returned HTTP '+r.status);return r.json()}).then(function(j){S.runs=arr(j&&j.workflow_runs);S.runsErr=null;S.runsAuth=null;renderRuns()}).catch(function(e){
    if(e&&e.auth){S.runs=null;S.runsErr=null;S.runsAuth=e.auth;S.runsAt=Date.now()-RUNS_REFRESH+30000;renderRuns();return}
    S.runsErr=(e&&e.message&&e.message.indexOf('GitHub')===0)?e.message:'Could not reach GitHub.';S.runsAt=Date.now()-RUNS_REFRESH+30000;renderRuns()})}
function runsAuthHtml(code){
  var why=code==='none'?'Auto-run history is read from the GitHub Actions API, which needs your GitHub token because the repository is private.':
    code===404?'GitHub could not find the workflow with this token. The token must have access to s-chuch/bet-dashboard with <b>Actions: Read</b> (and Metadata: Read) permission.':
    'GitHub rejected the saved token (HTTP '+code+'). It may be expired or lack <b>Actions: Read</b> access to s-chuch/bet-dashboard.';
  return '<div class="sconnect" id="runs-connect"><div class="ct">Connect GitHub to see runs</div><p class="muted" style="margin:4px 0 8px;font-size:13px">'+why+'</p>'+
    '<a class="btn pri" href="#activity" data-go="activity">'+(code==='none'?'Connect GitHub':'Update token')+' in Activity \u203a</a></div>'}
function dur(a,b){var s=Math.round((pd(b)-pd(a))/1000);if(!isFinite(s)||s<0)return '';return s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'}
function renderRuns(){
  var h=$('health'),rl=$('run-list');
  if(!S.runs&&S.runsAuth){h.innerHTML='';rl.innerHTML=runsAuthHtml(S.runsAuth);return}
  if(!S.runs){h.innerHTML='';rl.innerHTML='<div class="errbox"><strong>Runs unavailable.</strong><div class="muted" style="margin-top:4px">'+esc(S.runsErr||'')+'</div><p><button class="btn" id="retry" type="button">Retry</button></p></div>';return}
  var runs=S.runs.filter(function(r){return r&&/^\d+$/.test(String(r.id))});
  if(!runs.length){h.innerHTML='';rl.innerHTML='<div class="panel empty">No runs found.</div>';return}
  var done=runs.filter(function(r){return r.status==='completed'}),ok=done.filter(function(r){return r.conclusion==='success'});
  var lastOk=ok[0],age=lastOk?(Date.now()-pd(lastOk.updated_at||lastOk.created_at))/60000:Infinity,good=age<30;
  var rate=done.length?Math.round(ok.length/done.length*100):null;
  h.innerHTML='<div class="health '+(good?'ok':'bad')+'" role="status"><span class="dot '+(good?'ok':'bad')+'" style="margin:0" aria-hidden="true"></span><div><div class="big">'+(good?'Healthy':'Stale or failing')+'</div><div class="muted" style="font-size:12.5px">'+
    (lastOk?'Last success '+esc(ago(lastOk.updated_at||lastOk.created_at))+' ('+esc(fmtDT(lastOk.updated_at||lastOk.created_at))+')':'No successful run in the last '+runs.length)+'</div></div>'+
    '<div class="rate"><div class="l kv" style="display:block"><div class="l">Success rate (last '+done.length+')</div></div><div class="v '+(rate==null?'':rate>=90?'pos':rate>=60?'':'neg')+'">'+(rate==null?'\u2014':rate+'%')+'</div></div></div>'+
    (S.runsErr?'<div class="muted" style="font-size:12px;margin:-4px 2px 8px">Refresh failed: '+esc(S.runsErr)+' Showing last data.</div>':'');
  rl.innerHTML='<div class="runlist">'+runs.map(function(r){
    var st=r.status==='completed'?(r.conclusion==='success'?'ok':r.conclusion==='cancelled'||r.conclusion==='skipped'?'warn':'bad'):'run';
    var label=r.status==='completed'?String(r.conclusion||'completed'):String(r.status||'unknown').replace(/_/g,' ');
    var d=r.status==='completed'?dur(r.run_started_at||r.created_at,r.updated_at):'';
    var sha=String(r.head_sha||'').slice(0,7);
    return '<div class="runrow"><span class="dot '+st+'" aria-hidden="true"></span><div class="main"><div class="t1"><a href="https://github.com/s-chuch/bet-dashboard/actions/runs/'+r.id+'" target="_blank" rel="noopener noreferrer">Run #'+esc(r.run_number!=null?r.run_number:r.id)+'</a> <span class="chip '+(st==='ok'?'won':st==='bad'?'lost':'')+'">'+esc(label)+'</span></div>'+
      '<div class="t2">'+esc(fmtDT(r.created_at))+(d?' \u00b7 '+esc(d):'')+(sha&&/^[0-9a-f]+$/i.test(sha)?' \u00b7 <span class="mono">'+esc(sha)+'</span>':'')+'</div></div><div class="side">'+esc(r.event||'')+'<br>'+esc(ago(r.created_at))+'</div></div>'}).join('')+'</div>'}
$('run-list').addEventListener('click',function(e){if(e.target.id==='retry'){S.runsErr=null;loadRuns(true)}
  var g=e.target.closest&&e.target.closest('[data-go]');if(g){e.preventDefault();setTab(g.dataset.go);var sb=$('settle-box');if(sb&&sb.scrollIntoView)sb.scrollIntoView({block:'start'})}});

/* ---------- boot ---------- */
setTab(TABS.indexOf(location.hash.slice(1))>=0?location.hash.slice(1):(function(){var v=safeGet('log.tab');return TABS.indexOf(v)>=0?v:'archive'})());
loadAll();
setInterval(function(){if(document.hidden)return;loadAll();if(S.tab==='runs')loadRuns(false)},REFRESH);
document.addEventListener('visibilitychange',function(){if(!document.hidden)loadAll()});
})();
