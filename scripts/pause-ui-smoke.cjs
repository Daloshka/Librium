const {JSDOM}=require('jsdom');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(readFileSync('ui/index.html','utf8'),{runScripts:'outside-only',url:'http://localhost/'});
const {window}=dom,$=id=>window.document.getElementById(id);
const summary={id:1,method:'GET',url:'wss://pause.example.test/',status:101,size:0,time:0};
const payload={headers:[],text:'',base64:'',size:0,complete:false,truncated:false};
const exchange={summary,request:payload,response:payload};
const stats=count=>({count,bytes:count,stored_bytes:count,truncated:0});
const snapshot=count=>({id:1,summary,state:'open',close:null,error:null,sent:stats(count),received:stats(0),total:stats(count),kinds:[{direction:'sent',kind:'TEXT',stats:stats(count),intervals:{count:count-1,backwards:0,zero:0,min_ms:12.5,mean_ms:12.5,max_ms:12.5,longest:{before:1,after:2}}}],first_time:0,last_time:0,measured_at:0});
const page=rows=>({rows,total:rows.length,matched:rows.length,newest:rows[0]?.id||0});
const messages=text=>({total:1,matched:1,older:false,messages:[{id:1,time:0,direction:'received',kind:'TEXT',text,base64:Buffer.from(text).toString('base64'),size:text.length,truncated:false}]});
let handler,ws=messages('baseline'),calls=[];
window.librium={request:async route=>{
  calls.push(route);
  if(handler){const result=handler(route);if(result!==undefined)return result;}
  if(route.startsWith('traffic-page?'))return page([summary]);
  if(route.includes('/ws?'))return ws;
  if(route==='traffic/1')return exchange;
  if(route==='traffic/1/ws-summary')return snapshot(2);
  if(/^traffic\/1\/ws\/[12]$/.test(route)){const id=Number(route.at(-1)),text=id===1?'before':'after';return {id,time:0,direction:'sent',kind:'TEXT',text,base64:Buffer.from(text).toString('base64'),size:text.length,truncated:false};}
  throw Error('Unexpected route '+route);
}};
window.setTimeout=()=>0;
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
for(const file of ['filters.js','ws-analysis.js','ws-export.js','ws-message.js','ws-fields.js','ws-signatures.js','app.js'])window.eval(readFileSync('ui/'+file,'utf8')+(file==='app.js'?'\nwindow.pauseTest={choose,refresh,loadWs,epoch:()=>refreshEpoch};':''));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const content=()=>window.document.querySelectorAll('.pane .content')[1].textContent;
function defer(match){let resolve,reject,seen=false;const promise=new Promise((a,b)=>{resolve=a;reject=b;});handler=route=>{if(match(route)){seen=true;return promise;}};return {resolve,reject,get seen(){return seen;}};}
async function reach(pending){for(let n=0;n<10&&!pending.seen;n++)await flush();assert.equal(pending.seen,true,'request must be in flight');}
(async()=>{
  await flush();await window.pauseTest.choose(1);assert.match(content(),/baseline/);
  // A late list reply must neither change rows nor start the next stage.
  let pending=defer(route=>route.startsWith('traffic-page?'));
  let job=window.pauseTest.refresh();await reach(pending);$('pause').click();const count=calls.length;
  pending.resolve(page([{...summary,id:2}]));await job;
  assert.equal($('rows').querySelector('tr').dataset.id,'1');assert.equal(calls.length,count);
  assert.equal($('pause').getAttribute('aria-pressed'),'true');assert.equal($('connection').textContent,'Просмотр на паузе');
  handler=null;calls=[];await window.pauseTest.refresh();assert.equal(calls.length,0,'paused timer does no network work');
  // Manual navigation/filter requests remain usable while paused.
  ws=messages('manual update');await window.pauseTest.loadWs();assert.match(content(),/manual update/);
  $('pause').click();
  // An old 404 must not remove the selected exchange after pausing.
  pending=defer(route=>route==='traffic/1');job=window.pauseTest.refresh();await reach(pending);$('pause').click();pending.reject(Error('API: 404'));await job;
  assert.doesNotMatch($('selection').textContent,/удалён/);assert.match(content(),/manual update/);
  handler=null;$('pause').click();
  // A WS response from before a rapid pause/resume cannot overwrite a fresh one.
  pending=defer(route=>route.includes('/ws?'));job=window.pauseTest.refresh();await reach(pending);$('pause').click();$('pause').click();
  handler=null;ws=messages('fresh after resume');await window.pauseTest.refresh();assert.match(content(),/fresh after resume/);
  pending.resolve(messages('stale before pause'));await job;assert.match(content(),/fresh after resume/);assert.doesNotMatch(content(),/stale before pause/);
  // Late transport failure must not replace the pause indicator with an error.
  pending=defer(route=>route.startsWith('traffic-page?'));job=window.pauseTest.refresh();await reach(pending);$('pause').click();pending.reject(Error('late failure'));await job;
  assert.equal($('connection').textContent,'Просмотр на паузе');assert.doesNotMatch(window.document.body.textContent,/late failure/);
  // Summary is manual even while paused; old replies cannot replace a reopened dialog.
  pending=defer(route=>route.endsWith('/ws-summary'));$('ws-summary').click();await reach(pending);$('ws-summary-close').click();
  handler=null;$('ws-summary').click();await flush();
  const summaryCount=()=>$('ws-summary-content').querySelector('tbody tr:last-child td').textContent;
  assert.deepEqual(Array.from($('ws-summary-content').querySelectorAll('.ws-summary-timing tbody td'),cell=>cell.firstChild.textContent),['1','12,5','12,5','12,5','0','0']);
  assert.equal(summaryCount(),'2');pending.resolve(snapshot(99));await flush();assert.equal(summaryCount(),'2');
  $('ws-summary-close').click();handler=route=>{if(route.endsWith('/ws-summary'))throw Error('API: 404');};$('ws-summary').click();await flush();
  assert.match($('ws-summary-error').textContent,/удалено/);handler=null;$('ws-summary-refresh').click();await flush();assert.equal($('ws-summary-error').hidden,true);assert.equal(summaryCount(),'2');$('ws-summary-close').click();
  console.log('PASS: pause ignores in-flight list/detail/WS responses and errors, resume rejects old generations, manual inspection remains available');
  $('ws-summary').click();await flush();const oldGap=$('ws-summary-content').querySelector('.ws-summary-gap-before');$('ws-summary-close').click();$('ws-summary').click();await flush();oldGap.click();await flush();assert.equal($('ws-inspector-dialog').open,false);
  handler=route=>{if(route.endsWith('/ws-summary'))throw Error('refresh offline');};$('ws-summary-refresh').click();await flush();assert.match($('ws-summary-error').textContent,/refresh offline/);handler=null;
  $('ws-summary-content').querySelector('.ws-summary-gap-before').click();await flush();assert.equal($('ws-summary-dialog').open,false);assert.match($('ws-inspector-title').textContent,/#1$/);assert.match($('ws-inspector-content').textContent,/before/);$('ws-inspector-close').click();
  $('ws-summary').click();await flush();$('ws-summary-content').querySelector('.ws-summary-gap-after').click();await flush();assert.match($('ws-inspector-title').textContent,/#2$/);assert.match($('ws-inspector-content').textContent,/after/);$('ws-inspector-close').click();
  handler=route=>{if(route==='traffic/1/ws/1')throw Error('API: 404');};$('ws-summary').click();await flush();$('ws-summary-content').querySelector('.ws-summary-gap-before').click();await flush();assert.match($('ws-inspector-error').textContent,/удалено/);assert.equal($('ws-inspector-retry').hidden,false);$('ws-inspector-close').click();handler=null;
  console.log('PASS: longest interval opens both archived endpoints, closes summary, rejects detached old actions and reports deleted-message errors');
  console.log('PASS: manual WS summary while paused, stale response after reopening, deleted-history error and retry');
  // Browser download fetches the authoritative raw record, not formatted text.
  const native=window.librium;window.librium=undefined;window.token='owned-test';window.Blob=Blob;let downloaded,blob;
  window.URL.createObjectURL=value=>{blob=value;return 'blob:owned-payload';};window.URL.revokeObjectURL=()=>{};
  window.HTMLAnchorElement.prototype.click=function(){downloaded=this.download;};
  window.fetch=async(route,options)=>{assert.equal(route,'/api/traffic/1/ws/1');assert.equal(options.headers['x-librium-token'],'owned-test');return {ok:true,json:async()=>({id:1,kind:'BINARY',direction:'received',base64:'AP8=',size:2,truncated:false})};};
  window.document.querySelector('.ws-message-save').click();await flush();await flush();assert.match(downloaded,/1-1-received\.bin$/);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from([0,255]));window.librium=native;
  console.log('PASS: browser saves exact per-message bytes through the authenticated API');
  handler=null;ws={total:2,matched:2,older:false,messages:[1,2].map(id=>({id,time:0,direction:'received',kind:'TEXT',text:'line\n'.repeat(2000),base64:'',size:10000,truncated:false}))};
  await window.pauseTest.loadWs();assert.equal(window.document.querySelectorAll('.pane .content .code-line').length,3000);assert.equal(window.document.querySelectorAll('.ws-message-save').length,2);
  $('find').value='#1';$('find').dispatchEvent(new window.Event('input'));await flush();assert.equal(window.document.querySelectorAll('.ws-message-actions mark').length,1);
  console.log('PASS: message cards retain a shared 3000-line preview limit, byte-save actions and header search highlighting');
  $('find').value='';ws={total:3,matched:3,older:false,messages:[{id:1,time:300,direction:'sent',text:'request one'},{id:2,time:100,direction:'received',text:'reply two'},{id:3,time:200,direction:'sent',text:'request three'}].map(row=>({...row,kind:'TEXT',base64:Buffer.from(row.text).toString('base64'),size:row.text.length,truncated:false}))};
  await window.pauseTest.loadWs();
  const cards=()=>[...window.document.querySelector('.pane .content').querySelectorAll('.ws-message')].map(row=>Number(row.dataset.messageId));
  assert.deepEqual(cards(),[1,3]);$('ws-layout').value='timeline';$('ws-layout').dispatchEvent(new window.Event('change'));await flush();
  assert.deepEqual(cards(),[1,2,3],'merged view must preserve record order even if event times go backwards');assert.equal(window.document.querySelectorAll('.pane .content')[1].textContent,'');
  assert.equal(window.localStorage.getItem('librium-ws-layout-v1'),'timeline');assert.match(window.document.querySelector('.pane h2').textContent,/Сообщения WS/);assert.match(window.document.querySelector('.pane .content').textContent,/Получено/);
  let copied;window.librium.copy=async value=>{copied=value;};window.document.querySelector('.pane .pane-title button').click();await flush();assert.match(copied,/request one[\s\S]*reply two[\s\S]*request three/);
  window.document.querySelector('.pane [data-mode="headers"]').click();await flush();assert.equal($('ws-layout').value,'split');assert.equal($('panes').classList.contains('ws-timeline'),false);
  console.log('PASS: merged WS record order, both directions, copy, persisted layout and handshake-tab transition');
  $('ws-filter').value='f';$('ws-search-format').value='hex';calls=[];$('ws-search-format').dispatchEvent(new window.Event('change'));await flush();assert.equal($('ws-filter').getAttribute('aria-invalid'),'true');assert.equal($('ws-filter-error').hidden,false);assert.equal(calls.filter(route=>route.includes('/ws?')).length,0);
  $('ws-filter').value='00 FF';$('ws-filter').dispatchEvent(new window.Event('input'));await flush();assert.equal($('ws-filter-error').hidden,true);assert.equal($('ws-filter').getAttribute('aria-invalid'),'false');assert.ok(calls.some(route=>route.includes('/ws?')));assert.equal(window.document.querySelector('.ws-format').value,'hex');
  console.log('PASS: byte search validates locally, skips invalid requests, clears errors on correction and selects Hex view');
  $('ws-filter').value='f?';$('ws-search-format').value='hex_mask';calls=[];$('ws-search-format').dispatchEvent(new window.Event('change'));await flush();assert.equal($('ws-filter').getAttribute('aria-invalid'),'true');assert.equal(calls.filter(route=>route.includes('/ws?')).length,0);$('ws-filter').value='@12: 01 ??';$('ws-filter').dispatchEvent(new window.Event('input'));await flush();assert.equal($('ws-filter-error').hidden,true);assert.equal(window.document.querySelector('.ws-format').value,'hex');assert.ok(calls.some(route=>route.includes('hex_mask')));
  $('ws-signatures').click();assert.equal($('ws-signatures-pattern').value,'@12: 01 ??');$('ws-signatures-name').value='Session signature';$('ws-signatures-form').dispatchEvent(new window.Event('submit',{cancelable:true}));const signaturesSaved=window.localStorage.getItem('librium-ws-signatures-v1');assert.equal(JSON.parse(signaturesSaved).presets.length,1);$('ws-signatures-close').click();$('ws-signatures').click();$('ws-signatures-presets').value='Session signature';$('ws-signatures-presets').dispatchEvent(new window.Event('change'));$('ws-signatures-kind').value='BINARY';$('ws-signatures-direction').value='received';$('ws-signatures-apply').click();await flush();assert.equal($('ws-signatures-dialog').open,false);assert.equal($('ws-filter').value,'@12:01??');assert.equal($('ws-kind').value,'BINARY');assert.equal($('ws-direction').value,'received');assert.equal(window.localStorage.getItem('librium-ws-signatures-v1'),signaturesSaved);$('ws-kind').value='';$('ws-direction').value='';
  console.log('PASS: signature dialog captures byte query, saves explicitly, reapplies canonical mask / kind / direction without changing saved data');
  $('ws-filter').value='';$('ws-search-format').value='text';$('ws-search-format').dispatchEvent(new window.Event('change'));await flush();
  calls=[];pending=defer(route=>route.includes('/ws?'));const sharedManual=window.pauseTest.loadWs(),sharedTimer=window.pauseTest.loadWs(window.pauseTest.epoch());await reach(pending);
  assert.equal(calls.filter(route=>route.includes('/ws?')).length,1,'manual and timer reads must share the same pending query');pending.resolve(messages('one shared response'));await Promise.all([sharedManual,sharedTimer]);assert.match(content(),/one shared response/);
  handler=null;ws=messages('next live update');await window.pauseTest.loadWs();assert.equal(calls.filter(route=>route.includes('/ws?')).length,2,'completed query must not become a stale cache');assert.match(content(),/next live update/);
  pending=defer(route=>route.includes('/ws?'));const oldQuery=window.pauseTest.loadWs();await reach(pending);handler=null;ws=messages('new filter result');$('ws-filter').value='new';$('ws-filter').dispatchEvent(new window.Event('input'));await flush();
  pending.reject(Error('old query failed'));await oldQuery;assert.match(content(),/new filter result/);assert.doesNotMatch($('error').textContent,/old query failed/);
  pending=defer(route=>route.includes('/ws?'));const failing=window.pauseTest.loadWs();await reach(pending);pending.reject(Error('current query failed'));await assert.rejects(failing,/current query failed/);
  handler=null;ws=messages('retry after failure');await window.pauseTest.loadWs();assert.match(content(),/retry after failure/);
  console.log('PASS: one in-flight WS query shared by timer / manual refresh, fresh reads after completion, stale-error rejection and retry after failure');
  const held=new Map();calls=[];handler=route=>{if(route.includes('/ws?')){const query=JSON.parse(decodeURIComponent(route.split('?q=')[1]));return new Promise((resolve,reject)=>held.set(query.search,{resolve,reject}));}};
  const begin=search=>{$('ws-filter').value=search;return window.pauseTest.loadWs();};
  const burst=[begin('slow-a'),begin('slow-b')];for(let n=0;n<30;n++)burst.push(begin('typed-'+n));const queuedTwin=window.pauseTest.loadWs(window.pauseTest.epoch());
  assert.equal(calls.filter(route=>route.includes('/ws?')).length,2,'typing must not queue every intermediate request in the core');
  assert.deepEqual([...held.keys()],['slow-a','slow-b']);
  held.get('slow-a').resolve(messages('stale slow-a'));await burst[0];await flush();assert.deepEqual([...held.keys()],['slow-a','slow-b','typed-29'],'first free slot must start the latest typed query');
  held.get('typed-29').resolve(messages('latest typed result'));await burst.at(-1);await queuedTwin;held.get('slow-b').reject(Error('stale burst failure'));await Promise.all(burst);
  assert.equal(calls.filter(route=>route.includes('/ws?')).length,3);assert.match(content(),/latest typed result/);assert.doesNotMatch($('error').textContent,/stale burst failure/);
  held.clear();calls=[];const oldEpoch=[begin('pause-a'),begin('pause-b'),begin('queued-before-pause')];$('pause').click();
  held.get('pause-a').resolve(messages('old epoch a'));held.get('pause-b').resolve(messages('old epoch b'));await Promise.all(oldEpoch);assert.equal(held.has('queued-before-pause'),false,'queued work must be revalidated before dispatch');assert.equal(calls.filter(route=>route.includes('/ws?')).length,2);
  handler=null;$('pause').click();await flush();await window.pauseTest.loadWs();
  held.clear();calls=[];handler=route=>{if(route.includes('/ws?')){const query=JSON.parse(decodeURIComponent(route.split('?q=')[1]));return new Promise(resolve=>held.set(query.search,{resolve}));}};
  const backA=begin('back-a'),backB=begin('back-b'),obsolete=begin('discard-on-return');const sameA=begin('back-a');await obsolete;
  held.get('back-a').resolve(messages('returned to active query'));await Promise.all([backA,sameA]);held.get('back-b').resolve(messages('stale back-b'));await backB;
  assert.equal(calls.filter(route=>route.includes('/ws?')).length,2);assert.match(content(),/returned to active query/);handler=null;
  held.clear();handler=route=>{if(route.includes('/ws?')){const query=JSON.parse(decodeURIComponent(route.split('?q=')[1]));return new Promise((resolve,reject)=>held.set(query.search,{resolve,reject}));}};
  const failSlot=begin('failed-slot'),otherSlot=begin('other-slot'),afterFailure=begin('latest-after-failure');held.get('failed-slot').reject(Error('obsolete slot failure'));await failSlot;await flush();assert.equal(held.has('latest-after-failure'),true);
  held.get('latest-after-failure').resolve(messages('queue continued after failure'));await afterFailure;held.get('other-slot').resolve(messages('old other slot'));await otherSlot;assert.match(content(),/queue continued after failure/);handler=null;
  console.log('PASS: rapid typing keeps two active WS reads and only the latest queued query, shares queued duplicates, releases slots on failure and discards work after pause / return to an active query');
  dom.window.close();
})().catch(error=>{console.error(error);dom.window.close();process.exitCode=1;});
