// The interface as served by the core itself, without Electron: fetch with the token, no native
// bridge, Electron-only controls hidden, platform detected from the browser.
const {JSDOM}=require('jsdom');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const html=readFileSync('ui/index.html','utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:3000/'});
const {window}=dom;
const rows=[
  {id:5,method:'GET',url:'https://example.test/data.json',status:200,size:30,elapsed_ms:9,time:0,version:'HTTP/2',content_type:'application/json',finished:true},
  {id:4,method:'POST',url:'https://example.test/upload',status:201,size:0,elapsed_ms:40,time:0,version:'HTTP/1.1',content_type:'',finished:true},
];
const detail={summary:rows[0],request:{headers:[['accept','application/json']],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','application/json']],text:'{"ok":true}',base64:Buffer.from('{"ok":true}').toString('base64'),size:11,complete:true,truncated:false}};
const requests=[];
window.fetch=async(url,options={})=>{
  requests.push({url:String(url),method:options.method||'GET',token:options.headers?.['x-librium-token']});
  const path=new URL(String(url),'http://127.0.0.1:3000/').pathname;
  const reply=(status,body)=>({ok:status<300,status,json:async()=>body,blob:async()=>new window.Blob([JSON.stringify(body)])});
  if(path==='/api/state')return reply(200,{revision:3,disk:2048,error:null});
  if(path==='/api/info')return reply(200,{version:'9.9.9',proxy_port:8088,data_dir:'/tmp/librium-test',phone_lan:true,persistent_history:true});
  if(path==='/api/traffic-page')return reply(200,{rows,total:rows.length,matched:rows.length,newest:5});
  if(path==='/api/traffic/5')return reply(200,detail);
  if(path==='/api/settings')return reply(options.method==='PUT'?204:200,{ignore_hosts:[]});
  return reply(404,{});
};
window.setTimeout=()=>0;
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
let copied='';
Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
// The core inlines `const token='…'` into the page; jsdom does not run inline scripts, so declare it here.
window.eval("var token='__TOKEN__';");
window.eval(readFileSync('ui/i18n.js','utf8'));
window.eval(readFileSync('ui/filters.js','utf8'));
window.eval(readFileSync('ui/params.js','utf8'));
window.eval(readFileSync('ui/app.js','utf8'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  for(let i=0;i<5;i++)await flush();
  const $=id=>window.document.getElementById(id);
  assert.equal(window.librium,undefined,'no native bridge in the browser');
  assert.ok(requests.every(r=>r.token==='__TOKEN__'),'every API call carries the page token: '+JSON.stringify(requests));
  assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>Number(r.dataset.id)),[5,4],'rows; error banner: '+$('error').textContent+'; requests: '+JSON.stringify(requests)+'; connection: '+$('connection').textContent);
  assert.equal($('version').textContent,'9.9.9');
  assert.equal($('proxy-address').textContent,'127.0.0.1:8088');
  assert.match($('ca-check').textContent,/--proxy http:\/\/127\.0\.0\.1:8088 --cacert "\/tmp\/librium-test\/ca\.crt"/);
  assert.equal($('export').hidden,true,'HAR export needs the desktop app');assert.equal($('import').hidden,true,'HAR import needs the desktop app');assert.equal($('compose').hidden,true,'composing a request needs the desktop app');assert.equal($('rules-export').hidden,true,'rule files need the desktop app');
  assert.equal($('browser').hidden,true,'the browser launcher needs the desktop app');
  assert.equal($('filter-key').textContent,'Ctrl K','a non-mac browser gets the Ctrl hint');
  assert.match(window.document.querySelector('.history-foot .disk').textContent,/2\.0 KB/);
  assert.equal($('connection').textContent,'Proxy connected');
  window.document.querySelector('#rows tr[data-id]').click();await flush();await flush();
  assert.match(window.document.querySelector('.selection-id').textContent,/#5/);
  assert.equal(window.document.querySelectorAll('.save-body')[1].hidden,true,'saving a body needs the desktop app');
  assert.equal(window.document.querySelector('.copy-curl').hidden,false);
  window.document.querySelector('.copy-curl').click();await flush();
  assert.match(copied,/^curl 'https:\/\/example\.test\/data\.json' \\\n  -H 'accept: application\/json'$/);
  assert.equal(window.document.querySelectorAll('.json-key').length,1,'the JSON body is pretty-printed from the fetch path');
  // Without the desktop bridge a brotli body cannot be inflated in the page; the core's decoded preview is shown instead.
  rows.unshift({id:6,method:'GET',url:'https://example.test/brotli.json',status:200,size:40,elapsed_ms:3,time:0,version:'HTTP/2',content_type:'application/json',finished:true});
  const originalFetch=window.fetch;
  window.fetch=async(url,options)=>{const path=new URL(String(url),'http://127.0.0.1:3000/').pathname;if(path==='/api/traffic/6')return {ok:true,status:200,json:async()=>({summary:rows[0],request:{headers:[],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','application/json'],['content-encoding','br']],text:'{"decoded":"by the core"}',base64:Buffer.from('not brotli').toString('base64'),size:10,complete:true,truncated:false}})};return originalFetch(url,options);};
  $('filter').value='brotli.json';$('filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="6"]').click();await flush();await flush();await flush();
  const responsePane=window.document.querySelectorAll('.pane')[1];
  assert.match(responsePane.querySelector('.content').textContent,/"decoded": "by the core"/);
  assert.match(responsePane.querySelector('.notice').textContent,/br/);
  $('settings-open').click();await flush();await flush();$('ignore-hosts').value='*.noise.test';$('ignore-save').click();await flush();await flush();
  const put=requests.find(r=>r.method==='PUT');assert.ok(put&&put.url.endsWith('/api/settings')&&put.token==='__TOKEN__','settings are saved with a PUT carrying the token');
  console.log('Browser smoke OK: token on every call, rows, info, hidden desktop-only controls, curl copy via the clipboard API');
  dom.window.close();
  // A core that cannot write its history must not look healthy: the status and the banner say so.
  const broken=new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:3000/'});
  broken.window.fetch=async(url,options={})=>{
    const path=new URL(String(url),'http://127.0.0.1:3000/').pathname;
    const reply=(status,body)=>({ok:status<300,status,json:async()=>body});
    if(path==='/api/state')return reply(200,{revision:1,disk:4096,error:'disk I/O error'});
    if(path==='/api/info')return reply(200,{version:'9.9.9',proxy_port:8088,data_dir:'/tmp/librium-test'});
    if(path==='/api/traffic-page')return reply(200,{rows,total:rows.length,matched:rows.length,newest:5});
    return reply(404,{});
  };
  broken.window.setTimeout=()=>0;
  broken.window.eval("var token='__TOKEN__';");
  for(const file of ['ui/i18n.js','ui/filters.js','ui/params.js','ui/app.js'])broken.window.eval(readFileSync(file,'utf8'));
  for(let i=0;i<5;i++)await flush();
  assert.equal(broken.window.document.getElementById('connection').textContent,'History is not being saved');
  assert.equal(broken.window.document.getElementById('dot').classList.contains('live'),false);
  assert.match(broken.window.document.getElementById('error').textContent,/disk I\/O error/);
  assert.equal(broken.window.document.querySelectorAll('#rows tr[data-id]').length,rows.length,'the list still shows what the core has');
  // An empty history offers the setup steps directly (the browser launcher only with the desktop app).
  const empty=new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:3000/'});
  empty.window.fetch=async(url)=>{const path=new URL(String(url),'http://127.0.0.1:3000/').pathname;const reply=(status,body)=>({ok:status<300,status,json:async()=>body});if(path==='/api/state')return reply(200,{revision:1,disk:0,error:null});if(path==='/api/traffic-page')return reply(200,{rows:[],total:0,matched:0,newest:0});return reply(200,{});};
  empty.window.setTimeout=()=>0;empty.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  empty.window.eval("var token='__TOKEN__';");for(const file of ['ui/i18n.js','ui/filters.js','ui/params.js','ui/app.js'])empty.window.eval(readFileSync(file,'utf8'));
  for(let i=0;i<5;i++)await flush();
  assert.equal(empty.window.document.getElementById('empty').hidden,false);assert.deepEqual([...empty.window.document.querySelectorAll('.empty-actions button')].map(b=>b.textContent),['Set up HTTPS']);
  empty.window.document.querySelector('.empty-actions button').click();assert.equal(empty.window.document.getElementById('dialog').open,true,'the setup button opens the HTTPS dialog');
  empty.window.close();
  console.log('Browser smoke OK: a failing history store is reported instead of a green indicator');
  // A 401 means the core was restarted with a new token: the page schedules its own reload.
  const stale=new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:3000/'});
  let reloadScheduled=false;stale.window.setTimeout=(fn,ms)=>{if(ms===500)reloadScheduled=true;return 0;};
  stale.window.fetch=async()=>({ok:false,status:401,json:async()=>({})});
  stale.window.eval("var token='__TOKEN__';");
  for(const file of ['ui/i18n.js','ui/filters.js','ui/params.js','ui/app.js'])stale.window.eval(readFileSync(file,'utf8'));
  for(let i=0;i<5;i++)await flush();
  assert.equal(reloadScheduled,true,'a 401 schedules a reload of the page');
  assert.equal(stale.window.document.getElementById('connection').textContent,'No connection to the core');
  stale.window.close();
  console.log('Browser smoke OK: a stale token triggers a reload');
  broken.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
