const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const html = readFileSync('ui/index.html','utf8');
const dom = new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
const {window} = dom;
const fixtures = [
  {id:2,method:'POST',url:'https://api.example.test/v1/events',status:201,size:42,elapsed_ms:12,time:0},
  {id:19,method:'GET',url:'https://example.test/<script>alert(1)</script>',status:200,size:35,elapsed_ms:21,time:0},
  {id:7,method:'DELETE',url:'https://api.example.test/v1/items/7',status:404,size:0,elapsed_ms:8,time:0},
];
function searchPage(path){
 const q=JSON.parse(new URLSearchParams(path.split('?')[1]).get('q'));
 const matched=fixtures.filter(r=>(!q.before||r.id<=q.before)&&`${r.id} ${r.method} ${r.url} ${r.status??''}`.toLowerCase().includes(q.query.toLowerCase())&&(!q.method||r.method===q.method)&&(!q.status||String(r.status).startsWith(q.status))&&window.LibriumFilters.matches(r,q.rules)).sort((a,b)=>{const key=q.sort||'id',x=key==='url'?a.url:a[key],y=key==='url'?b.url:b[key];if(x==null||y==null)return x==null?(y==null?b.id-a.id:1):-1;const compared=typeof x==='number'?x-y:String(x).localeCompare(String(y));return (q.order==='asc'?1:-1)*compared||b.id-a.id;});
 return {rows:matched.slice(q.offset,q.offset+q.limit),total:fixtures.length,matched:matched.length,newest:Math.max(...fixtures.map(r=>r.id))};
}
window.URL.createObjectURL=()=> 'blob:test-image';window.URL.revokeObjectURL=()=>{};
let copied='',opened='',savedMedia=null;
window.librium={request:async path=>path==='traffic'?fixtures:path.startsWith('traffic-page?')?searchPage(path):{summary:fixtures.find(r=>r.id===Number(path.split('/')[1])),request:{headers:[['accept','application/json']],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','application/json'],['x-example','<img src=x onerror=alert(1)>']],text:'{"message":"hello","count":42}',base64:Buffer.from('{"message":"hello","count":42}').toString('base64'),size:30,complete:true,truncated:false}},copy:async text=>{copied=text;},saveMedia:async(id,side)=>{savedMedia={id,side};return true;},openUrl:async url=>{opened=url;},saveCertificate:async()=>true};
window.setTimeout=()=>0;
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
window.eval(readFileSync('ui/i18n.js','utf8'));
window.eval(readFileSync('ui/filters.js','utf8'));
window.eval(readFileSync('ui/app.js','utf8'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  await flush();
  const ids=[...window.document.querySelectorAll('#rows tr')].map(r=>Number(r.dataset.id));
  assert.deepEqual(ids,[19,7,2]);
  const ordered=()=>[...window.document.querySelectorAll('#rows tr')].map(r=>Number(r.dataset.id));
  window.document.querySelector('[data-sort="id"]').click();await flush();assert.deepEqual(ordered(),[2,7,19]);assert.equal(window.document.querySelector('th.id').getAttribute('aria-sort'),'ascending');
  window.document.querySelector('[data-sort="status"]').click();await flush();assert.deepEqual(ordered(),[7,2,19]);
  window.document.querySelector('[data-sort="size"]').click();await flush();assert.deepEqual(ordered(),[2,19,7]);
  window.document.querySelector('[data-sort="method"]').click();await flush();assert.deepEqual(ordered(),[7,19,2]);
  window.document.querySelector('[data-sort="id"]').click();await flush();assert.deepEqual(ordered(),[19,7,2]);

  window.document.querySelector('#rows tr').click();await flush();await flush();
  assert.match(window.document.querySelector('#selection').textContent,/#19/);
  assert.match(window.document.querySelector('.pane .content').textContent,/GET https:\/\/example.test\//);
  window.document.querySelector('.selection-url').click();await flush();assert.equal(copied,fixtures[1].url);assert.equal(opened,'');
  window.document.querySelector('.open-url').click();await flush();assert.equal(opened,new URL(fixtures[1].url).href);

  assert.equal(window.document.querySelectorAll('.json-key').length,2);
  assert.equal(window.document.querySelectorAll('#rows script').length,0);
  const response=window.document.querySelectorAll('.pane')[1];
  response.querySelector('[data-mode="headers"]').click();await flush();
  assert.match(response.textContent,/<img src=x onerror=alert\(1\)>/);
  assert.equal(response.querySelectorAll('img').length,0);
  response.querySelector('.pane-title button').click();await flush();
  assert.match(copied,/content-type: application\/json/);
  window.document.querySelector('#find').value='json';window.document.querySelector('#find').dispatchEvent(new window.Event('input'));await flush();
  assert.ok(window.document.querySelectorAll('mark').length>0);
  assert.equal(window.document.querySelector('#layout'),null);assert.equal(window.document.querySelector('#wrap'),null);assert.ok(window.document.querySelector('#panes').classList.contains('side-by-side'));
  window.document.querySelector('#filter').value='POST';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.equal(window.document.querySelectorAll('#rows tr').length,1);
  window.document.querySelector('#filter').value='';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-preset="errors"]').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr').length,1);
  assert.equal(window.document.querySelector('#rows tr').dataset.id,'7');
  window.document.querySelector('.filter-chip').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr').length,3);
  // A large history is paged, and a filtered old entry remains discoverable.
  for(let id=20;id<=1100;id++)fixtures.push({id,method:'GET',url:`https://example.test/${id}`,status:200,size:1,time:0});
  window.document.querySelector('#page-live').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr').length,500);
  window.document.querySelector('#page-next').click();await flush();
  assert.equal(Number(window.document.querySelector('#rows tr').dataset.id),600);
  window.document.querySelector('#filter').value='/v1/events';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.equal(window.document.querySelector('#rows tr').dataset.id,'2');
  const originalRequest=window.librium.request;
  window.librium.request=async path=>path==='traffic/2'?{summary:fixtures[0],request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['content-type','image/png']],text:'',base64:readFileSync('desktop/assets/icon.png').toString('base64'),size:1234,complete:true,truncated:false}}:originalRequest(path);
  window.document.querySelector('#rows tr').click();await flush();await flush();
  assert.equal(response.querySelector('[data-mode="image"]').classList.contains('active'),true);
  assert.equal(response.querySelector('.image-preview img').getAttribute('src'),'blob:test-image');
  response.querySelector('.image-tools button').click();assert.ok(response.querySelector('.actual-size'));
  const canvas=response.querySelector('.actual-size'),content=response.querySelector('.content');canvas.setPointerCapture=()=>{};canvas.hasPointerCapture=()=>true;canvas.releasePointerCapture=()=>{};
  content.scrollLeft=100;content.scrollTop=150;
  canvas.onpointerdown({button:0,pointerId:1,clientX:100,clientY:100,preventDefault(){}});canvas.onpointermove({pointerId:1,clientX:60,clientY:70,preventDefault(){}});
  assert.equal(content.scrollLeft,140);assert.equal(content.scrollTop,180);canvas.onpointerup({pointerId:1});assert.equal(canvas.classList.contains('dragging'),false);
  response.querySelector('.media-download').click();await flush();assert.deepEqual(savedMedia,{id:2,side:'response'});

  fixtures.push({id:1101,method:'GET',url:'https://example.test/librium-media-test.svg',status:200,size:50,time:0},{id:1102,method:'GET',url:'https://example.test/librium-media-test.ogg',status:200,size:50,time:0});
  const previousRequest=window.librium.request;
  window.librium.request=async path=>['traffic/1101','traffic/1102'].includes(path)?{summary:fixtures.find(r=>r.id===Number(path.split('/')[1])),request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['content-type',path.endsWith('1101')?'image/svg+xml':'audio/ogg']],text:'',base64:Buffer.from(path.endsWith('1101')?'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>':'OggS').toString('base64'),size:50,complete:true,truncated:false}}:previousRequest(path);
  window.document.querySelector('#filter').value='librium-media-test';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="1102"]').click();await flush();await flush();
  const player=response.querySelector('audio');assert.ok(player.controls);assert.equal(player.autoplay,false);
  window.document.querySelector('.pane [data-mode="headers"]').click();await flush();
  assert.equal(response.querySelector('audio'),player,'changing request tabs must not restart audio');
  window.document.querySelector('[data-id="1101"]').click();await flush();await flush();
  assert.ok(response.querySelector('.image-preview img'));assert.equal(response.querySelector('svg'),null,'SVG must be an image, not injected document markup');
  fixtures.push({id:1200,method:'GET',url:'https://example.test/redirect-source',status:302,size:0,time:0},{id:1201,method:'GET',url:'https://example.test/redirect-target',status:200,size:1,time:0});
  const beforeRedirect=window.librium.request;
  window.librium.request=async path=>path==='traffic/1200'?{summary:fixtures.find(r=>r.id===1200),request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['location','/redirect-target'],['content-type','text/html']],text:'302 Found',base64:'',size:0,complete:true,truncated:false}}:beforeRedirect(path);
  window.document.querySelector('#filter').value='redirect-source';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="1200"]').click();await flush();await flush();
  assert.ok(response.querySelector('.redirect-open'));
  response.querySelector('.redirect-open').click();await flush();await flush();
  assert.match(window.document.querySelector('.selection-id').textContent,/#1201/);
  window.document.querySelector('#session-new').click();window.document.querySelector('#session-name').value='WebSocket';window.document.querySelector('#session-copy').checked=false;window.document.querySelector('#session-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
  const wsSession=window.document.querySelector('#filter-session').value;
  window.document.querySelector('#preset-ws').click();await flush();
  let sessions=JSON.parse(window.localStorage.getItem('librium-filter-sessions-v1'));assert.equal(sessions.activeId,wsSession);assert.equal(sessions.sessions.find(s=>s.id===wsSession).type,'ws');
  window.document.querySelector('#filter-session').value='default';window.document.querySelector('#filter-session').dispatchEvent(new window.Event('change'));await flush();assert.equal(window.document.querySelector('#filter').value,'redirect-source');assert.equal(window.document.querySelector('#traffic-type').value,'');
  window.document.querySelector('#filter-session').value=wsSession;window.document.querySelector('#filter-session').dispatchEvent(new window.Event('change'));await flush();assert.equal(window.document.querySelector('#traffic-type').value,'ws');
  window.document.querySelector('#session-rename').click();window.document.querySelector('#session-name').value='Sockets';window.document.querySelector('#session-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();assert.match(window.document.querySelector('#filter-session').textContent,/Sockets/);
  window.confirm=()=>true;window.document.querySelector('#session-delete').click();await flush();assert.equal(window.document.querySelector('#filter-session').options.length,1);assert.equal(window.document.querySelector('#filter').value,'redirect-source');
  console.log('UI smoke OK: descending IDs, selection, JSON, inert headers, copy, search, layout, filter');
  dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
