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
  collapsed:{},types:Object.create(null),archErr:null,logErr:null,runs:null,runsErr:null,runsAt:0,rawA:'',rawL:'',filtered:[]};
var TABS=['archive','activity','runs'];

/* ---------- tabs ---------- */
function setTab(t,focus){if(TABS.indexOf(t)<0)t='archive';S.tab=t;
  TABS.forEach(function(x){var on=x===t,b=$('tab-'+x);b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1;$('pane-'+x).hidden=!on;if(on&&focus)b.focus()});
  try{history.replaceState(null,'','#'+t)}catch(e){location.hash=t}
  if(t==='runs')loadRuns(false)}
document.querySelector('[role=tablist]').addEventListener('click',function(e){var b=e.target.closest('[data-tab]');if(b)setTab(b.dataset.tab)});
document.querySelector('[role=tablist]').addEventListener('keydown',function(e){
  var i=TABS.indexOf(S.tab),k=e.key;
  if(k==='ArrowRight')i=(i+1)%3;else if(k==='ArrowLeft')i=(i+2)%3;else if(k==='Home')i=0;else if(k==='End')i=2;else return;
  e.preventDefault();setTab(TABS[i],true)});
window.addEventListener('hashchange',function(){var t=location.hash.slice(1);if(TABS.indexOf(t)>=0&&t!==S.tab)setTab(t)});

/* ---------- data ---------- */
function getJSON(url){return fetch(url+'?t='+Date.now(),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text()})}
function loadAll(){
  var pa=getJSON('archive.json').then(function(t){S.archErr=null;if(t!==S.rawA){var j=JSON.parse(t);S.rawA=t;S.arch=j&&typeof j==='object'?j:{};prepBets();return true}return false}).catch(function(e){S.archErr=e.message||'error';return true});
  var pl=getJSON('log.json').then(function(t){S.logErr=null;if(t!==S.rawL){var j=JSON.parse(t);S.rawL=t;S.log=j&&typeof j==='object'?j:{};return true}return false}).catch(function(e){S.logErr=e.message||'error';return true});
  return Promise.all([pa,pl]).then(function(r){if(r[0]){buildArchiveControls();renderArchive()}if(r[1])renderActivity();renderSub()})}
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

/* ---------- runs ---------- */
function loadRuns(force){
  if(!force&&S.runsAt&&Date.now()-S.runsAt<RUNS_REFRESH)return;
  if(!S.runs&&!S.runsErr)$('run-list').innerHTML='<div class="skeleton" style="height:140px"></div>';
  S.runsAt=Date.now();
  fetch(RUNS_URL,{cache:'no-store',headers:{'Accept':'application/vnd.github+json'}}).then(function(r){
    if(r.status===403||r.status===429)throw new Error('GitHub rate limit reached. Try again in a few minutes.');
    if(!r.ok)throw new Error('GitHub API returned HTTP '+r.status);return r.json()}).then(function(j){S.runs=arr(j&&j.workflow_runs);S.runsErr=null;renderRuns()}).catch(function(e){
    S.runsErr=(e&&e.message&&e.message.indexOf('GitHub')===0)?e.message:'Could not reach GitHub.';S.runsAt=Date.now()-RUNS_REFRESH+30000;renderRuns()})}
function dur(a,b){var s=Math.round((pd(b)-pd(a))/1000);if(!isFinite(s)||s<0)return '';return s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'}
function renderRuns(){
  var h=$('health'),rl=$('run-list');
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
$('run-list').addEventListener('click',function(e){if(e.target.id==='retry'){S.runsErr=null;loadRuns(true)}});

/* ---------- boot ---------- */
setTab(TABS.indexOf(location.hash.slice(1))>=0?location.hash.slice(1):(function(){var v=safeGet('log.tab');return TABS.indexOf(v)>=0?v:'archive'})());
loadAll();
setInterval(function(){if(document.hidden)return;loadAll();if(S.tab==='runs')loadRuns(false)},REFRESH);
document.addEventListener('visibilitychange',function(){if(!document.hidden)loadAll()});
})();
