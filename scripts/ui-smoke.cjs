const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const html = readFileSync('ui/index.html','utf8');
const dom = new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
const {window} = dom;
const fixtures = [
  {id:2,method:'POST',url:'https://api.example.test/v1/events',status:201,size:42,elapsed_ms:12,time:Date.UTC(2026,8,7,10,0,0),version:'HTTP/2',content_type:'application/json',mock:true},
  {id:19,method:'GET',url:'https://example.test/<script>alert(1)</script>',status:200,size:35,elapsed_ms:21,time:Date.UTC(2026,8,8,12,0,0),version:'HTTP/1.1',content_type:'text/html'},
  {id:7,method:'DELETE',url:'https://api.example.test/v1/items/7',status:404,size:0,elapsed_ms:8,time:Date.UTC(2026,8,8,9,0,0),content_type:'application/vnd.api+json'},
];
function searchPage(path){
 const q=JSON.parse(new URLSearchParams(path.split('?')[1]).get('q'));
 const matched=fixtures.filter(r=>(!q.before||r.id<=q.before)&&`${r.id} ${r.method} ${r.url} ${r.status??''} ${r.content_type??''}`.toLowerCase().includes((q.query||'').toLowerCase())&&(!q.method||r.method===q.method)&&(!q.status||String(r.status).startsWith(q.status))&&window.LibriumFilters.matches(r,q.rules)).sort((a,b)=>{const key=q.sort||'id',pick=r=>key==='url'?r.url:key==='elapsed'?r.elapsed_ms:r[key],x=pick(a),y=pick(b);if(x==null||y==null)return x==null?(y==null?b.id-a.id:1):-1;const compared=typeof x==='number'?x-y:String(x).localeCompare(String(y));return (q.order==='asc'?1:-1)*compared||(q.order==='asc'?a.id-b.id:b.id-a.id);});
 return {rows:matched.slice(q.offset,q.offset+q.limit),total:fixtures.length,matched:matched.length,newest:Math.max(...fixtures.map(r=>r.id))};
}
window.URL.createObjectURL=()=> 'blob:test-image';window.URL.revokeObjectURL=()=>{};
let copied='',opened='',savedMedia=null;
let replayed=null,savedSettings=null;
const statsFixture={matched:3,bytes:4096,errors:1,pending:0,mocked:1,elapsed:{p50:12,p95:40,max:900,count:3},classes:[{class:2,count:2},{class:4,count:1}],hosts:[{host:'api.example.test',count:2,bytes:2048,errors:1,elapsed_avg:20,elapsed_max:900},{host:'example.test',count:1,bytes:2048,errors:0,elapsed_avg:null,elapsed_max:null}],methods:[{method:'get',count:3}]};
let interceptState={enabled:false,hosts:[],held:[]},recordingState=true;const decisions=[],marks=[];
const interceptStub=(path,method,body)=>{
  if(method==='PATCH'&&/^traffic\/\d+$/.test(path)){const id=Number(path.split('/')[1]),patch=JSON.parse(body);marks.push([id,patch]);Object.assign(fixtures.find(r=>r.id===id),patch);return null;}
  if(path==='intercept'&&method==='PUT'){const rules=JSON.parse(body);interceptState.enabled=!!rules.enabled;interceptState.hosts=rules.hosts||[];interceptState.methods=rules.methods||[];interceptState.path=rules.path||'';interceptState.responses=!!rules.responses;return null;}
  if(path.startsWith('intercept/')&&method==='POST'){const id=Number(path.split('/')[1]);decisions.push([id,JSON.parse(body)]);interceptState.held=interceptState.held.filter(h=>h.id!==id);return null;}
  if(path==='intercept')return JSON.parse(JSON.stringify(interceptState));
  if(path==='recording'&&method==='PUT'){recordingState=!!JSON.parse(body).enabled;return null;}
  if(path==='recording')return {enabled:recordingState};
  return undefined;
};
const imports=[],heldNotified=[];let rulesIo=[];window.librium={exportRules:async()=>{rulesIo.push('export');return '/tmp/rules.json';},importRules:async file=>{rulesIo.push(file?'import:'+file.name:'import');return ['mocks','delays'];},heldCount:async n=>{heldNotified.push(n);},importHar:async file=>{imports.push(file);return 3;},saveSettings:async value=>{savedSettings=value;},replay:async(id,edit)=>{replayed={id,edit};return {status:204};},request:async (path,method,body)=>{const hit=interceptStub(path,method,body);if(hit!==undefined)return hit;return path==='settings'?{ignore_hosts:['*.telemetry.test'],rewrites:[{host:'api.example.test',name:'x-debug',value:'1',path:'*'}],response_rewrites:[{host:'*',name:'content-security-policy',value:'',path:'*'}],delays:[{host:'slow.example.test',ms:1500}],mocks:[{host:'api.example.test',path:'/v1/items/*',method:'GET',status:200,content_type:'application/json',body:'[]'}]}:path==='state'?{revision:1,disk:3*1024*1024,error:null,held:interceptState.held.length,tweaks:{mocks:1,delays:0,rewrites:2,ignored:1},recording:recordingState}:path==='traffic'?fixtures:path.startsWith('traffic-stats?')?statsFixture:path.startsWith('traffic-page?')?searchPage(path):{summary:fixtures.find(r=>r.id===Number(path.split('/')[1])),request:{headers:[['accept','application/json']],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','application/json'],['x-example','<img src=x onerror=alert(1)>']],text:'{"message":"hello","count":42}',base64:Buffer.from('{"message":"hello","count":42}').toString('base64'),size:30,complete:true,truncated:false}};},copy:async text=>{copied=text;},saveMedia:async(id,side)=>{savedMedia={id,side};return true;},openUrl:async url=>{opened=url;},saveCertificate:async()=>true};
const pristineRequest=window.librium.request;
window.setTimeout=()=>0;
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
window.eval(readFileSync('ui/i18n.js','utf8'));
window.eval(readFileSync('ui/filters.js','utf8'));
window.eval(readFileSync('ui/suggest.js','utf8'));window.eval(readFileSync('ui/curl.js','utf8'));
window.eval(readFileSync('ui/params.js','utf8'));
window.eval(readFileSync('ui/app.js','utf8'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  await flush();
  const ids=[...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>Number(r.dataset.id));
  assert.deepEqual(ids,[19,7,2]);
  assert.equal(window.document.querySelectorAll('#rows tr.day').length,2,'a dated separator where a new day starts');
  assert.equal(window.document.querySelector('[data-id="7"] .status').title,'404 Not Found','the status cell explains the code');
  assert.equal(window.document.querySelector('[data-id="2"] .latency').textContent,'12 ms','the duration sits under the clock');
  assert.equal(window.document.querySelector('#rows tr').classList.contains('day'),true,'the list opens with the day of the newest request');
  assert.match(window.document.querySelector('.history-foot .disk').textContent,/3\.0 MB/,'the footer shows the history size on disk');
  const ordered=()=>[...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>Number(r.dataset.id));
  window.document.querySelector('[data-sort="id"]').click();await flush();assert.deepEqual(ordered(),[2,7,19]);assert.equal(window.document.querySelector('th.id').getAttribute('aria-sort'),'ascending');
  window.document.querySelector('[data-sort="status"]').click();await flush();assert.deepEqual(ordered(),[7,2,19]);assert.equal(window.document.querySelectorAll('#rows tr.day').length,0,'no day separators outside the id order');
  window.document.querySelector('[data-sort="size"]').click();await flush();assert.deepEqual(ordered(),[2,19,7]);
  window.document.querySelector('[data-sort="method"]').click();await flush();assert.deepEqual(ordered(),[7,19,2]);
  window.document.querySelector('[data-sort="elapsed"]').click();await flush();assert.deepEqual(ordered(),[19,2,7],'slowest first');
  const elapsedRules=window.LibriumFilters.parse('elapsed:>1s elapsed:<=20 -elapsed:>0.5s');assert.deepEqual(JSON.parse(JSON.stringify(elapsedRules.rules)),[{field:'elapsed',op:'gte',value:'1001'},{field:'elapsed',op:'lte',value:'20'},{field:'elapsed',op:'lte',value:'500'}]);
  window.document.querySelector('[data-sort="id"]').click();await flush();assert.deepEqual(ordered(),[19,7,2]);

  // The recording toggle flips the core's flag and shows it on the button.
  assert.equal(window.document.querySelector('#record').textContent,'● Recording');
  window.document.querySelector('#record').click();await flush();await flush();
  assert.equal(recordingState,false);assert.equal(window.document.querySelector('#record').textContent,'○ Not recording');assert.equal(window.document.querySelector('#record').classList.contains('off'),true);
  assert.equal(window.document.querySelector('#connection').textContent,'Proxy on, history not recorded','the header says so at once');assert.equal(window.document.querySelector('#dot').classList.contains('off'),true);
  window.document.querySelector('#record').click();await flush();await flush();assert.equal(recordingState,true);assert.equal(window.document.querySelector('#record').textContent,'● Recording');
  // The help dialog lists the keys and every search field; ? opens it unless something is being typed.
  window.document.querySelector('#help-open').click();await flush();
  assert.equal(window.document.querySelector('#help-dialog').open,true);assert.equal(window.document.querySelectorAll('#help-keys tr').length,11);
  assert.deepEqual([...window.document.querySelectorAll('#help-syntax th')].map(e=>e.textContent).slice(0,3),['host:','path:','url:']);assert.equal(window.document.querySelectorAll('#help-syntax tr').length,16);
  window.document.querySelector('#help-close').click();assert.equal(window.document.querySelector('#help-dialog').open,false);
  window.document.body.focus();window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'?',bubbles:true,cancelable:true}));await flush();
  assert.equal(window.document.querySelector('#help-dialog').open,true,'? opens the help');window.document.querySelector('#help-close').click();
  window.document.querySelector('#filter').focus();window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'?',bubbles:true,cancelable:true}));await flush();
  assert.equal(window.document.querySelector('#help-dialog').open,false,'not while typing in the search box');window.document.querySelector('#filter').blur();
  // Active traffic rules are announced in the header; the pill opens Settings.
  assert.equal(window.document.querySelector('#tweaks').hidden,false);assert.equal(window.document.querySelector('#tweaks').textContent,'mocks: 1 · header rewrites: 2');
  window.document.querySelector('#rows tr[data-id]').click();await flush();await flush();
  assert.match(window.document.querySelector('#selection').textContent,/#19/);
  assert.match(window.document.querySelector('.pane .content').textContent,/GET https:\/\/example.test\/.*HTTP\/1\.1/);
  assert.match(window.document.querySelector('.selection-time').textContent,/HTTP\/1\.1 · 200/);
  assert.deepEqual([...window.document.querySelectorAll('#rows .type')].map(n=>n.textContent),['html','json','json','mock'],'media type tags in the list, structured +json suffixes included; a mocked exchange is tagged');
  assert.ok(!window.document.querySelectorAll('.pane')[1].querySelector('.save-body').hidden,'a complete response body can be saved');
  window.document.querySelector('.selection-url').click();await flush();assert.equal(copied,fixtures[1].url);assert.equal(opened,'');
  window.document.querySelector('.open-url').click();await flush();assert.equal(opened,new URL(fixtures[1].url).href);

  assert.equal(window.document.querySelectorAll('.json-key').length,2);
  // The Pretty tab is a tree: folding hides the children, the count stays visible.
  const tree=window.document.querySelector('.jt');assert.ok(tree,'JSON renders as a tree');
  const toggle=tree.querySelector('.jt-toggle');toggle.click();assert.equal(tree.querySelector('.jt-children').hidden,true);assert.match(tree.querySelector('.jt-summary').textContent,/2 keys/);toggle.click();assert.equal(tree.querySelector('.jt-children').hidden,false);
  // The request pane offers the exchange as a curl command with shell quoting.
  assert.equal(window.document.querySelector('.copy-curl').hidden,false,'curl offered for an HTTP exchange');
  // Edit and resend: the dialog is filled from the capture and sends the edited request through the bridge.
  window.document.querySelector('.replay-edit').click();await flush();
  assert.equal(window.document.querySelector('#replay-dialog').open,true);
  assert.equal(window.document.querySelector('#replay-method').value,'GET');assert.equal(window.document.querySelector('#replay-url').value,fixtures[1].url);
  assert.equal(window.document.querySelector('#replay-headers').value,'accept: application/json');assert.equal(window.document.querySelector('#replay-body').disabled,false);
  window.document.querySelector('#replay-method').value='POST';window.document.querySelector('#replay-headers').value='accept: application/json\nx-edited: yes\n';window.document.querySelector('#replay-body').value='{"edited":true}';
  window.document.querySelector('#replay-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)),{id:19,edit:{method:'POST',url:fixtures[1].url,headers:[['accept','application/json'],['x-edited','yes']],body:'{"edited":true}'}});
  assert.equal(window.document.querySelector('#replay-dialog').open,false);
  window.document.querySelector('.replay').click();await flush();await flush();assert.equal(replayed.edit,undefined,'plain resend sends the capture unchanged');
  // cURL commands are parsed with shell quoting; pasted into the address field they fill the editor.
  {
    const parse=text=>{const r=window.LibriumCurl.parse(text);return r&&JSON.parse(JSON.stringify(r));};
    const p=parse(`curl 'https://api.example.test/v1/items?x=1' \\\n  -X PUT \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer a\\"b" \\\n  --data-raw '{"name":"x y"}' --compressed -sS`);
    assert.deepEqual(p,{method:'PUT',url:'https://api.example.test/v1/items?x=1',headers:[['Content-Type','application/json'],['Authorization','Bearer a"b']],body:'{"name":"x y"}'});
    assert.deepEqual(parse('curl example.test/a -d a=1 -d b=2 -u me:pw -b s=1 -A ua'),{method:'POST',url:'https://example.test/a',headers:[['Authorization','Basic '+Buffer.from('me:pw').toString('base64')],['Cookie','s=1'],['User-Agent','ua'],['Content-Type','application/x-www-form-urlencoded']],body:'a=1&b=2'});
    assert.deepEqual(parse('curl -G https://h.test/s -d q=1'),{method:'GET',url:'https://h.test/s?q=1',headers:[],body:''});
    assert.equal(parse('wget https://x.test'),null);assert.equal(parse('curl -sS'),null);
    assert.equal(parse('curl -sX DELETE https://h.test/x').method,'DELETE','bundled short flags with a trailing value option');
  }
  // A request from scratch uses the same editor and is sent with id 0.
  window.document.querySelector('#compose').click();await flush();
  assert.equal(window.document.querySelector('#replay-dialog').open,true);assert.equal(window.document.querySelector('#replay-title').textContent,'New request');assert.equal(window.document.querySelector('#replay-url').value,'https://');
  const paste=new window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=>"curl -X PATCH 'https://api.example.test/v1/paste' -H 'X-From: curl' -d '{\"p\":1}'"}});
  window.document.querySelector('#replay-url').dispatchEvent(paste);
  assert.equal(paste.defaultPrevented,true);assert.equal(window.document.querySelector('#replay-method').value,'PATCH');assert.equal(window.document.querySelector('#replay-url').value,'https://api.example.test/v1/paste');
  assert.equal(window.document.querySelector('#replay-headers').value,'X-From: curl\nContent-Type: application/x-www-form-urlencoded');assert.equal(window.document.querySelector('#replay-body').value,'{"p":1}');assert.match(window.document.querySelector('#replay-note').textContent,/2 headers/);
  window.document.querySelector('#replay-headers').value='accept: */*';
  window.document.querySelector('#replay-method').value='PUT';window.document.querySelector('#replay-url').value='https://api.example.test/v1/compose';window.document.querySelector('#replay-body').value='{"new":1}';
  // The answer shows up as a new exchange; the UI selects it once it appears.
  fixtures.push({id:21,method:'PUT',url:'https://api.example.test/v1/compose',status:200,size:2,elapsed_ms:5,time:Date.UTC(2026,8,8,12,30,0),version:'HTTP/2',content_type:'application/json'});
  window.document.querySelector('#replay-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();await flush();await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)),{id:0,edit:{method:'PUT',url:'https://api.example.test/v1/compose',headers:[['accept','*/*']],body:'{"new":1}'}});
  assert.equal(window.document.querySelector('#replay-dialog').open,false);
  assert.match(window.document.querySelector('.selection-url').textContent,/v1\/compose/,'the composed exchange is selected');
  // Reopening "+ Request" brings the last composed request back.
  window.document.querySelector('#compose').click();await flush();
  assert.equal(window.document.querySelector('#replay-url').value,'https://api.example.test/v1/compose');assert.equal(window.document.querySelector('#replay-method').value,'PUT');assert.equal(window.document.querySelector('#replay-body').value,'{"new":1}');assert.equal(window.document.querySelector('#replay-headers').value,'accept: */*');
  window.document.querySelector('#replay-cancel').click();window.localStorage.removeItem('librium-last-compose');
  fixtures.pop();window.document.querySelector('#rows tr[data-id="19"]').click();await flush();await flush();assert.match(window.document.querySelector('.selection-url').textContent,/example\.test\/<script>/,'back on the first row for the checks below');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));await flush();
  assert.equal(window.document.querySelector('#replay-dialog').open,true,'Ctrl N opens a new request');assert.equal(window.document.querySelector('#replay-title').textContent,'New request');
  window.document.querySelector('#replay-cancel').click();assert.equal(window.document.querySelector('#replay-dialog').open,false);
  window.document.querySelector('.replay-edit').click();await flush();window.document.querySelector('#replay-body').value='via shortcut';
  window.HTMLFormElement.prototype.requestSubmit=function(){this.dispatchEvent(new window.Event('submit',{cancelable:true}));};
  window.document.querySelector('#replay-body').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));await flush();await flush();
  assert.equal(replayed.edit.body,'via shortcut','Ctrl+Enter sends the edited request');
  window.document.querySelector('.copy-curl').click();await flush();
  assert.match(copied,/^curl 'https:\/\/example\.test\/<script>alert\(1\)<\/script>' \\\n  -H 'accept: application\/json'$/);
  // What "Copy as cURL" produces parses back into the same request.
  {const back=JSON.parse(JSON.stringify(window.LibriumCurl.parse(copied)));assert.equal(back.method,'GET');assert.equal(back.url,'https://example.test/<script>alert(1)</script>');assert.deepEqual(back.headers,[['accept','application/json']]);assert.equal(back.body,'');}
  // Row nodes are reused between polls, so the list updates in place instead of being rebuilt.
  const firstRow=window.document.querySelector('#rows tr[data-id]');
  window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.equal(window.document.querySelector('#rows tr[data-id]'),firstRow);
  assert.equal(window.document.querySelectorAll('#rows script').length,0);
  const response=window.document.querySelectorAll('.pane')[1];
  response.querySelector('[data-mode="headers"]').click();await flush();
  assert.match(response.textContent,/<img src=x onerror=alert\(1\)>/);
  response.querySelectorAll('.headers-table td')[1].click();await flush();assert.equal(copied,'application/json','a header cell copies its value');
  assert.equal(response.querySelectorAll('img').length,0);
  response.querySelector('.copy-pane').click();await flush();
  assert.match(copied,/content-type: application\/json/);
  window.document.querySelector('#find').value='json';window.document.querySelector('#find').dispatchEvent(new window.Event('input'));await flush();
  assert.ok(window.document.querySelectorAll('mark').length>0);
  assert.equal(window.document.querySelector('#layout'),null);assert.equal(window.document.querySelector('#wrap'),null);assert.ok(window.document.querySelector('#panes').classList.contains('side-by-side'));
  window.document.querySelector('#filter').value='POST';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,1);
  window.document.querySelector('#filter').value='json';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id),['7','2'],'the media type is searchable');
  // The search box understands conditions next to free text.
  const parsed=window.LibriumFilters.parse('api status:>=400 -host:cdn method:post size:>1kb type:json path:"/a b" id:<=100 status:4xx -size:>1mb foo:bar host:=api.example.test');
  assert.equal(parsed.text,'api foo:bar');
  // Objects from the jsdom realm have another Object.prototype: compare by value, not by realm.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.rules)),[
    {field:'status',op:'gte',value:'400'},{field:'host',op:'not_contains',value:'cdn'},{field:'method',op:'eq',value:'post'},
    {field:'size',op:'gte',value:'1025'},{field:'type',op:'contains',value:'json'},{field:'path',op:'contains',value:'/a b'},{field:'id',op:'lte',value:'100'},
    {field:'status',op:'gte',value:'400'},{field:'status',op:'lte',value:'499'},{field:'size',op:'lte',value:'1048576'},{field:'host',op:'eq',value:'api.example.test'}]);
  const bodyRule=window.LibriumFilters.parse('body:token -body:"not this"');
  assert.deepEqual(JSON.parse(JSON.stringify(bodyRule.rules)),[{field:'body',op:'contains',value:'token'},{field:'body',op:'not_contains',value:'not this'}]);
  assert.equal(window.LibriumFilters.matches(fixtures[0],bodyRule.rules),true,'body rules are left to the core: the page keeps its rows');
  const flagsParsed=window.LibriumFilters.parse('is:error -is:pending is:unknown');
  assert.deepEqual(JSON.parse(JSON.stringify(flagsParsed.rules)),[{field:'error',op:'eq',value:'1'},{field:'pending',op:'eq',value:'0'}]);assert.equal(flagsParsed.text,'is:unknown');
  assert.equal(window.LibriumFilters.matches({id:1,status:null},flagsParsed.rules),false);assert.equal(window.LibriumFilters.matches({id:1,status:200,error:'cut'},flagsParsed.rules),true);
  const timed=window.LibriumFilters.parse('since:10m until:2026-09-08 since:garbage');
  const sinceRule=timed.rules.find(r=>r.op==='gte'),untilRule=timed.rules.find(r=>r.op==='lte');
  assert.ok(Math.abs(Number(sinceRule.value)-(Date.now()-600000))<5000,'since:10m is ten minutes ago');
  assert.equal(new Date(Number(untilRule.value)).toDateString(),new Date(2026,8,8).toDateString());assert.equal(new Date(Number(untilRule.value)).getHours(),23,'until:<date> reaches the end of that day');
  assert.equal(timed.text,'since:garbage');
  assert.equal(window.LibriumFilters.matches({id:1,time:Date.now()-60000},[sinceRule]),true);assert.equal(window.LibriumFilters.matches({id:1,time:Date.now()-3600000},[sinceRule]),false);
  const refused=window.LibriumFilters.parse('status:99 host:x id:>1');
  assert.equal(refused.text,'status:99');assert.equal(refused.conditions.length,2,'a condition the core would refuse becomes text');
  const typed=async text=>{window.document.querySelector('#filter').value=text;window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();return [...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id);};
  assert.deepEqual(await typed('status:4xx'),['7']);
  assert.deepEqual(await typed('type:json -method:delete'),['2']);
  assert.deepEqual(await typed('host:api.example.test size:>10'),['2']);
  assert.deepEqual(await typed('example status:2xx'),['19','2']);
  assert.deepEqual(await typed('nothing-like-this'),[]);assert.equal(window.document.querySelector('#empty').hidden,false);
  window.document.querySelector('#empty .empty-actions button').click();await flush();assert.equal(window.document.querySelector('#filter').value,'','the nothing-found state resets the conditions');
  // The row menu narrows the list; a header cell copies its value on click.
  await typed('');
  const target=window.document.querySelector('[data-id="7"]');target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  const menu=window.document.querySelector('#row-menu');assert.equal(menu.hidden,false);
  {
    // "Intercept this host" arms the core for that host alone; the toggle then switches it off again.
    const arm=[...menu.querySelectorAll('button')].find(b=>b.textContent==='Intercept this host');assert.ok(arm,'the menu offers intercept');
    arm.click();await flush();await flush();
    assert.deepEqual(interceptState,{enabled:true,hosts:['api.example.test'],held:[],methods:[],path:'',responses:false});
    window.document.querySelector('#intercept').click();await flush();await flush();assert.equal(interceptState.enabled,false);
    target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();assert.equal(menu.hidden,false);
  }
  assert.deepEqual([...menu.querySelectorAll('button')].map(b=>b.textContent),['Star ★','Only this host','Hide this host','Only this path','Intercept this host','Stop recording this host','Only DELETE','Only status 404','Copy URL','Compare with #19','Copy as fetch','Copy as Python','Copy as cURL','Mock this response','Resend','Delete from the history']);
  {
    // "Mock this response" opens an editor filled from the exchange; saving appends to the core's mocks.
    const pick=label=>[...menu.querySelectorAll('button')].find(b=>b.textContent===label);
    pick('Mock this response').click();await flush();await flush();
    const dialog=window.document.querySelector('#mock-dialog');assert.equal(dialog.open,true);
    assert.equal(window.document.querySelector('#mock-host').value,'api.example.test');assert.equal(window.document.querySelector('#mock-status').value,'404');
    assert.equal(window.document.querySelector('#mock-type').value,'application/json');assert.equal(window.document.querySelector('#mock-body').value,'{"message":"hello","count":42}');
    window.document.querySelector('#mock-path').value='nope';window.document.querySelector('#mock-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.match(window.document.querySelector('#mock-error').textContent,/start with/);assert.equal(savedSettings,null);
    window.document.querySelector('#mock-path').value='/v1/*';window.document.querySelector('#mock-status').value='200';window.document.querySelector('#mock-body').value='x'.repeat(1024*1024+1);window.document.querySelector('#mock-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.match(window.document.querySelector('#mock-error').textContent,/1 MiB/);assert.equal(savedSettings,null);window.document.querySelector('#mock-body').value='{"a":1}';
    window.document.querySelector('#mock-path').value='/v1/*';window.document.querySelector('#mock-status').value='42';window.document.querySelector('#mock-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
    assert.match(window.document.querySelector('#mock-error').textContent,/100 and 599/);assert.equal(savedSettings,null);
    window.document.querySelector('#mock-path').value='/v1/*';window.document.querySelector('#mock-status').value='503';window.document.querySelector('#mock-body').value='{"down":true}';
    window.document.querySelector('#mock-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();await flush();await flush();
    assert.equal(dialog.open,false);
    const saved=JSON.parse(JSON.stringify(savedSettings));assert.equal(saved.mocks.length,2,'appended to the existing mock');
    assert.deepEqual(saved.mocks[1],{host:'api.example.test',path:'/v1/*',method:'DELETE',status:503,content_type:'application/json',body:'{"down":true}',enabled:true});savedSettings=null;
    target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();assert.equal(menu.hidden,false);
  }
  {
    // The same request as code: fetch() with method and headers, Python requests.
    const pick=label=>[...menu.querySelectorAll('button')].find(b=>b.textContent===label);
    pick('Copy as fetch').click();await flush();await flush();assert.match(copied,/^fetch\("https:\/\/api\.example\.test\/v1\/items\/7", \{\n  "method": "DELETE",\n  "headers": \[\n    \[\n      "accept",/);
    target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
    pick('Copy as Python').click();await flush();await flush();assert.match(copied,/^import requests\n\nresponse = requests\.request\("DELETE", "https:\/\/api\.example\.test\/v1\/items\/7",\n    headers=\{"accept": "application\/json"\},\n\)\nprint/);
    target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  }
  {
    // A star from the menu marks the row and the header; the note field saves on change; is:starred finds it.
    const pick=label=>[...menu.querySelectorAll('button')].find(b=>b.textContent===label);
    pick('Star ★').click();await flush();await flush();await flush();
    assert.deepEqual(marks.at(-1),[7,{starred:true}]);
    assert.ok(window.document.querySelector('[data-id="7"] .star'),'the row shows the star');assert.equal(window.document.querySelector('.star-toggle').textContent,'★');
    assert.equal(window.document.querySelector('#note').hidden,false);
    window.document.querySelector('#note').value='hello note';window.document.querySelector('#note').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.deepEqual(marks.at(-1),[7,{note:'hello note'}]);assert.match(window.document.querySelector('[data-id="7"]').querySelector('td:nth-child(4)').title,/hello note/);
    assert.equal((await typed('is:starred')).length,1,'is:starred keeps the starred row');await typed('');
    window.document.querySelector('[data-preset="starred"]').click();await flush();assert.equal(window.document.querySelector('#filter').value,'is:starred','the preset writes the condition');await typed('');
    window.document.querySelector('.star-toggle').click();await flush();await flush();await flush();
    assert.deepEqual(marks.at(-1),[7,{starred:false}]);assert.equal(window.document.querySelector('[data-id="7"] .star'),null);
    target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  }
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Compare with #19').click();await flush();await flush();await flush();
  assert.equal(window.document.querySelector('#diff-dialog').open,true);assert.match(window.document.querySelector('#diff-title').textContent,/#19 and #7/);
  assert.ok(window.document.querySelectorAll('#diff-body .diff-del').length>=1&&window.document.querySelectorAll('#diff-body .diff-add').length>=1,'the differing start lines show as removed and added');
  assert.equal(window.document.querySelectorAll('#diff-body h3').length,2);window.document.querySelector('#diff-close').click();
  target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Stop recording this host').click();await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{ignore_hosts:['*.telemetry.test','api.example.test']},'the host joins the ignore list');savedSettings=null;
  target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  menu.querySelector('button').focus();menu.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal(window.document.activeElement.textContent,'Only this host','arrow keys move through the menu');menu.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));assert.equal(window.document.activeElement.textContent,'Star ★');
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Only this host').click();await flush();
  assert.equal(menu.hidden,true);assert.equal(window.document.querySelector('#filter').value,'host:=api.example.test');
  assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id),['7','2']);
  target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));await flush();
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Only status 404').click();await flush();
  assert.equal(window.document.querySelector('#filter').value,'host:=api.example.test status:404');
  assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id),['7']);
  target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await flush();
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Copy URL').click();await flush();assert.equal(copied,fixtures[2].url);
  // Deleting a row asks the core and reloads the page without it.
  const deleted=[];const beforeDelete=window.librium.request;window.librium.request=async(path,method)=>{if(method==='DELETE'){deleted.push(path);const id=Number(path.split('/')[1]);const at=fixtures.findIndex(r=>r.id===id);if(at>=0)fixtures.splice(at,1);return null;}return beforeDelete(path,method);};
  target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await flush();
  [...menu.querySelectorAll('button')].find(b=>b.textContent==='Delete from the history').click();await flush();await flush();
  assert.deepEqual(deleted,['traffic/7']);assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id),[],'the deleted row is gone from the filtered page');
  window.librium.request=beforeDelete;fixtures.splice(2,0,{id:7,method:'DELETE',url:'https://api.example.test/v1/items/7',status:404,size:0,elapsed_ms:8,time:0,content_type:'application/vnd.api+json'});
  // "Delete matching" sends the list's own query as a DELETE, after a confirmation.
  await typed('host:=api.example.test');
  const purges=[];const beforePurge=window.librium.request;window.librium.request=async(path,method)=>{if(method==='DELETE'){purges.push(path);return {deleted:2};}return beforePurge(path,method);};
  window.confirm=()=>false;window.document.querySelector('.delete-matching').click();await flush();assert.equal(purges.length,0,'declining the confirmation deletes nothing');
  window.confirm=()=>true;window.document.querySelector('.delete-matching').click();await flush();await flush();
  assert.equal(purges.length,1);const purgeQuery=JSON.parse(decodeURIComponent(purges[0].slice('traffic-page?q='.length)));
  assert.deepEqual(JSON.parse(JSON.stringify(purgeQuery.rules)),[{field:'host',op:'eq',value:'api.example.test'}]);assert.equal(purgeQuery.offset,undefined,'no paging in a delete');
  window.librium.request=beforePurge;await typed('');
  await typed('');
  // Follow mode opens the newest row on every reload of the newest page.
  await typed('');window.document.querySelector('#follow').click();await flush();await flush();await flush();
  assert.equal(window.document.querySelector('#follow').classList.contains('active'),true);assert.match(window.document.querySelector('.selection-id').textContent,/#19/,'the newest row is opened');
  window.document.querySelector('#follow').click();await flush();assert.equal(window.localStorage.getItem('librium-follow'),'0');
  // Ignored hosts: the dialog shows the core's list and saves a cleaned one.
  window.document.querySelector('#settings-open').click();await flush();await flush();
  assert.equal(window.document.querySelector('#settings-dialog').open,true,'the gear opens the settings');
  assert.equal(window.document.querySelector('#ignore-hosts').value,'*.telemetry.test');
  window.document.querySelector('#ignore-hosts').value='*.telemetry.test\n  CDN.Example.com \n\nbad host';
  window.document.querySelector('#ignore-save').click();await flush();assert.equal(savedSettings,null);assert.match(window.document.querySelector('#ignore-state').textContent,/bad host/);
  // Header rewrites: shown as lines, parsed back into rules, a malformed line is refused before anything is sent.
  assert.equal(window.document.querySelector('#rewrite-rules').value,'api.example.test x-debug: 1');
  window.document.querySelector('#rewrite-rules').value='api.example.test x-debug: 1\n* Authorization: Bearer abc def\nbad line';
  window.document.querySelector('#rewrite-save').click();await flush();assert.equal(savedSettings,null);assert.match(window.document.querySelector('#rewrite-state').textContent,/bad line/);
  window.document.querySelector('#rewrite-rules').value='api.example.test X-Debug: 1\n* Authorization: Bearer abc def\n*.example.test/v1/* If-None-Match:';
  window.document.querySelector('#rewrite-save').click();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{rewrites:[{host:'api.example.test',name:'x-debug',value:'1',path:'*'},{host:'*',name:'authorization',value:'Bearer abc def',path:'*'},{host:'*.example.test',name:'if-none-match',value:'',path:'/v1/*'}]});
  assert.equal(window.document.querySelector('#rewrite-rules').value,'api.example.test x-debug: 1\n* authorization: Bearer abc def\n*.example.test/v1/* if-none-match: ');savedSettings=null;
  // Response rewrites use the same editor and land in their own settings field.
  assert.equal(window.document.querySelector('#response-rewrite-rules').value,'* content-security-policy: ');
  window.document.querySelector('#response-rewrite-rules').value='* Content-Security-Policy:\napi.example.test Access-Control-Allow-Origin: *';
  window.document.querySelector('#response-rewrite-save').click();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{response_rewrites:[{host:'*',name:'content-security-policy',value:'',path:'*'},{host:'api.example.test',name:'access-control-allow-origin',value:'*',path:'*'}]});
  assert.match(window.document.querySelector('#response-rewrite-state').textContent,/2/);savedSettings=null;
  // Delays: `host ms` lines, refused before sending when out of range.
  assert.equal(window.document.querySelector('#delay-rules').value,'slow.example.test 1500');
  window.document.querySelector('#delay-rules').value='slow.example.test 1500\n* 0';
  window.document.querySelector('#delay-save').click();await flush();assert.equal(savedSettings,null);assert.match(window.document.querySelector('#delay-state').textContent,/\* 0/);
  window.document.querySelector('#delay-rules').value='Slow.example.test 1500\n*/api/* 300';
  window.document.querySelector('#delay-save').click();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{delays:[{host:'slow.example.test',ms:1500,path:'*'},{host:'*',ms:300,path:'/api/*'}]});assert.equal(window.document.querySelector('#delay-rules').value,'slow.example.test 1500\n*/api/* 300');savedSettings=null;
  // Rules travel as one file through the bridge; the state line reports what happened.
  assert.equal(window.document.querySelector('#rules-export').hidden,false);
  window.document.querySelector('#rules-export').click();await flush();await flush();assert.match(window.document.querySelector('#rules-state').textContent,/rules\.json/);
  window.document.querySelector('#rules-import').click();await flush();await flush();await flush();assert.match(window.document.querySelector('#rules-state').textContent,/mocks, delays/);assert.deepEqual(rulesIo,['export','import']);
  // Mocks are listed in the settings dialog; deleting one saves the rest.
  assert.deepEqual([...window.document.querySelectorAll('#mock-list .mock-where')].map(e=>e.textContent),['GET api.example.test/v1/items/*']);
  // Edit reopens the editor on that mock; saving replaces it in place and refreshes the list.
  window.document.querySelector('#mock-list .mock-row button').click();await flush();
  assert.equal(window.document.querySelector('#mock-dialog').open,true);assert.equal(window.document.querySelector('#mock-path').value,'/v1/items/*');assert.match(window.document.querySelector('#mock-note').textContent,/replace/);
  window.document.querySelector('#mock-status').value='204';window.document.querySelector('#mock-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{mocks:[{host:'api.example.test',path:'/v1/items/*',method:'GET',status:204,content_type:'application/json',body:'[]',enabled:true}]},'replaced, not appended');
  assert.match(window.document.querySelector('#mock-list .mock-status').textContent,/204/);savedSettings=null;
  // The checkbox switches a mock off without deleting it.
  const mockToggle=window.document.querySelector('#mock-list .mock-row input[type=checkbox]');assert.equal(mockToggle.checked,true);mockToggle.checked=false;mockToggle.dispatchEvent(new window.Event('change'));await flush();await flush();
  assert.equal(JSON.parse(JSON.stringify(savedSettings)).mocks[0].enabled,false,'the mock is saved switched off');assert.equal(window.document.querySelector('#mock-list .mock-row').classList.contains('off'),true);savedSettings=null;
  [...window.document.querySelectorAll('#mock-list .mock-row button')].at(-1).click();await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{mocks:[]});assert.equal(window.document.querySelector('#mock-list').textContent,'No mocks');savedSettings=null;
  window.document.querySelector('#ignore-hosts').value='*.telemetry.test\n  CDN.Example.com \n';
  window.document.querySelector('#ignore-save').click();await flush();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)),{ignore_hosts:['*.telemetry.test','cdn.example.com']});
  assert.match(window.document.querySelector('#ignore-state').textContent,/2 patterns/);
  window.document.querySelector('#filters-close').click();
  assert.equal(window.document.querySelector('#export-redact').checked,true,'credentials are masked by default');
  // The split and the hand-picked tabs are remembered for the next start.
  window.document.querySelector('#divider').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',cancelable:true}));
  assert.equal(window.localStorage.getItem('librium-split'),'42');
  assert.equal(JSON.parse(window.localStorage.getItem('librium-modes')).response,'headers','the last hand-picked response tab is remembered');
  // Each condition is a chip of its own; removing one rewrites the search text.
  await typed('example status:2xx -method:post');
  assert.deepEqual([...window.document.querySelectorAll('.filter-chip')].map(c=>c.textContent),['Search: example ×','status:2xx ×','-method:post ×']);
  window.document.querySelectorAll('.filter-chip')[1].click();await flush();
  assert.equal(window.document.querySelector('#filter').value,'example -method:post');
  assert.deepEqual([...window.document.querySelectorAll('#rows tr[data-id]')].map(r=>r.dataset.id),['19','7']);
  window.document.querySelectorAll('.filter-chip')[0].click();await flush();
  assert.equal(window.document.querySelector('#filter').value,'-method:post');
  window.document.querySelector('#filter').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await flush();
  assert.equal(window.document.querySelector('#filter').value,'','Escape empties the history filter');
  assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,3);
  assert.match(window.document.querySelector('[data-id="2"] td.time').title,/12 ms$/,'the time cell tooltip carries the duration');
  window.document.querySelector('[data-preset="errors"]').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,1);
  assert.equal(window.document.querySelector('#rows tr[data-id]').dataset.id,'7');
  window.document.querySelector('.filter-chip').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,3);
  // A large history is paged, and a filtered old entry remains discoverable.
  for(let id=20;id<=1100;id++)fixtures.push({id,method:'GET',url:`https://example.test/${id}`,status:200,size:1,time:0});
  window.document.querySelector('#page-live').click();await flush();
  assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,500);
  window.document.querySelector('#page-next').click();await flush();
  assert.equal(Number(window.document.querySelector('#rows tr[data-id]').dataset.id),600);
  window.document.querySelector('#filter').value='/v1/events';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  assert.equal(window.document.querySelector('#rows tr[data-id]').dataset.id,'2');
  const originalRequest=window.librium.request;
  window.librium.request=async path=>path==='traffic/2'?{summary:fixtures[0],request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['content-type','image/png']],text:'',base64:readFileSync('desktop/assets/icon.png').toString('base64'),size:1234,complete:true,truncated:false}}:originalRequest(path);
  window.document.querySelector('#rows tr[data-id]').click();await flush();await flush();
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
  // Brotli is beyond DecompressionStream: the bridge decodes it and the JSON view still works.
  fixtures.push({id:1150,method:'GET',url:'https://example.test/compressed.json',status:200,size:20,time:0,content_type:'application/json'});
  const beforeBrotli=window.librium.request;let decodeCalls=[];
  window.librium.request=async path=>path==='traffic/1150'?{summary:fixtures.find(r=>r.id===1150),request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['content-type','application/json'],['content-encoding','br']],text:'\u0001garbage',base64:Buffer.from('not-really-brotli').toString('base64'),size:17,complete:true,truncated:false}}:beforeBrotli(path);
  window.librium.decodeBody=async(id,side)=>{decodeCalls.push([id,side]);return {decoded:true,encoding:'br',size:11,base64:Buffer.from('{"br":true}').toString('base64')};};
  window.document.querySelector('#find').value='';window.document.querySelector('#find').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('#filter').value='compressed.json';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="1150"]').click();await flush();await flush();await flush();
  response.querySelector('[data-mode="pretty"]').click();await flush();await flush();
  assert.deepEqual(decodeCalls,[[1150,'response']]);
  assert.match(response.querySelector('.content').textContent,/"br": true/);assert.equal(response.querySelectorAll('.json-key').length,1);
  assert.match(response.querySelector('.notice').textContent,/br/);
  // A row with a transfer error is flagged in the list.
  fixtures.push({id:1155,method:'GET',url:'https://example.test/cut.bin',status:200,size:100,time:0,error:'Transfer interrupted before the full body arrived'});
  window.document.querySelector('#filter').value='cut.bin';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  const flagged=window.document.querySelector('[data-id="1155"]');assert.ok(flagged.classList.contains('flagged'));assert.match(flagged.querySelector('.status').title,/Transfer interrupted|Передача прервана/);
  // While a body streams, the preview is not reported as "stored partially".
  fixtures.push({id:1160,method:'GET',url:'https://example.test/big.bin',status:200,size:5000000,time:0,content_type:'application/octet-stream'});
  const beforeStreaming=window.librium.request;
  window.librium.request=async path=>path==='traffic/1160'?{summary:{...fixtures.find(r=>r.id===1160),finished:false},request:{headers:[],text:'',base64:'',size:0,complete:true},response:{headers:[['content-type','application/octet-stream']],text:'xxxx',base64:Buffer.from('xxxx').toString('base64'),size:5000000,complete:false,truncated:true}}:beforeStreaming(path);
  window.document.querySelector('#filter').value='big.bin';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="1160"]').click();await flush();await flush();await flush();
  assert.match(response.querySelector('.pane-state').textContent,/streaming/);
  assert.doesNotMatch(response.querySelector('.notice').textContent,/stored partially/);
  // Params and Cookies tabs: query string, form fields, cookies sent and set.
  fixtures.push({id:1170,method:'POST',url:'https://example.test/login?next=%2Fhome&lang=en',status:200,size:2,time:0,content_type:'text/html'});
  const beforeParams=window.librium.request;
  window.librium.request=async path=>path==='traffic/1170'?{summary:{...fixtures.find(r=>r.id===1170),finished:true},request:{headers:[['content-type','application/x-www-form-urlencoded'],['cookie','session=abc; theme=dark']],text:'user=neo&pass=x%26y',base64:Buffer.from('user=neo&pass=x%26y').toString('base64'),size:19,complete:true,truncated:false},response:{headers:[['content-type','text/html'],['set-cookie','session=def; Path=/; HttpOnly; Secure; SameSite=Lax']],text:'ok',base64:Buffer.from('ok').toString('base64'),size:2,complete:true,truncated:false}}:beforeParams(path);
  window.document.querySelector('#filter').value='login?next';window.document.querySelector('#filter').dispatchEvent(new window.Event('input'));await flush();
  window.document.querySelector('[data-id="1170"]').click();await flush();await flush();await flush();
  const requestPane=window.document.querySelectorAll('.pane')[0];
  assert.equal(requestPane.querySelector('[data-mode="params"]').hidden,false);assert.equal(response.querySelector('[data-mode="params"]').hidden,true,'the response has no params');
  requestPane.querySelector('[data-mode="params"]').click();await flush();await flush();
  assert.deepEqual([...requestPane.querySelectorAll('.headers-table td')].map(td=>td.textContent),['next','/home','lang','en','user','neo','pass','x&y']);
  requestPane.querySelector('[data-mode="cookies"]').click();await flush();await flush();
  assert.deepEqual([...requestPane.querySelectorAll('.headers-table td')].map(td=>td.textContent),['session','abc','theme','dark']);
  response.querySelector('[data-mode="cookies"]').click();await flush();await flush();
  assert.deepEqual([...response.querySelectorAll('.headers-table td')].map(td=>td.textContent),['session','def  ·  Path=/; SameSite=Lax; Secure; HttpOnly']);
  window.document.querySelector('.pane [data-mode="http"]').click();response.querySelector('[data-mode="pretty"]').click();await flush();
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
  // Suggestions under the search box: fields while typing, values once a field has its colon; the keys accept them.
  {
    const box=window.document.querySelector('#filter'),list=window.document.querySelector('#suggest');
    const key=name=>box.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    const labels=()=>[...list.querySelectorAll('.suggest-item b')].map(b=>b.textContent);
    window.localStorage.removeItem('librium-recent-searches');
    await typed('');box.focus();
    assert.equal(list.hidden,false,'an empty focused box lists the fields');assert.equal(labels()[0],'host:');
    await typed('ho');assert.deepEqual(labels(),['host:']);
    key('ArrowDown');key('Enter');await flush();
    assert.equal(box.value,'host:');assert.equal(list.hidden,false,'an accepted field keeps the list open for its values');
    assert.equal(window.document.querySelectorAll('.filter-chip').length,0,'an unfinished condition filters nothing');await flush();assert.ok(window.document.querySelectorAll('#rows tr[data-id]').length>=400,'a full page stays while the value is typed');
    assert.ok(labels().includes('api.example.test'),'hosts seen in the history are offered: '+labels());
    await typed('host:api');assert.deepEqual(labels(),['api.example.test']);
    key('Tab');await flush();
    assert.equal(box.value,'host:api.example.test ');assert.equal(list.hidden,true);
    assert.deepEqual([...window.document.querySelectorAll('.filter-chip')].map(c=>c.textContent),['host:api.example.test ×']);
    await typed('-me');assert.deepEqual(labels(),['-method:']);
    await typed('status:');assert.deepEqual(labels().slice(0,4),['2xx','3xx','4xx','5xx']);
    await typed('is:');assert.deepEqual(labels(),['error','pending','starred','mock']);await typed('hea');assert.deepEqual(labels(),['header:']);await typed('fr');assert.deepEqual(labels(),['frame:']);
    // The rule builder offers only contains / not contains for frames.
    window.document.querySelector('#rule-field').value='frame';window.document.querySelector('#rule-field').dispatchEvent(new window.Event('change'));
    assert.deepEqual([...window.document.querySelectorAll('#rule-op option')].map(o=>o.value),['contains','not_contains']);
    window.document.querySelector('#rule-field').value='host';window.document.querySelector('#rule-field').dispatchEvent(new window.Event('change'));
    assert.deepEqual([...window.document.querySelectorAll('#rule-op option')].map(o=>o.value),['contains','not_contains','eq','ne']);assert.deepEqual(JSON.parse(JSON.stringify(window.LibriumFilters.parse('-frame:ping').rules)),[{field:'frame',op:'not_contains',value:'ping'}]);await typed('header:');assert.ok(labels().includes('set-cookie'));assert.deepEqual(JSON.parse(JSON.stringify(window.LibriumFilters.parse('header:"cache-control: no-store"').rules)),[{field:'header',op:'contains',value:'cache-control: no-store'}]);await typed('is:mock');assert.equal(window.document.querySelectorAll('#rows tr[data-id]').length,1,'is:mock keeps the mocked fixture');
    await typed('login');assert.equal(list.hidden,true,'free text has no suggestions');
    await typed('si');assert.equal(list.hidden,false);key('Escape');assert.equal(list.hidden,true);assert.equal(box.value,'si','Escape closes the list first');key('Escape');await flush();assert.equal(box.value,'','the second Escape clears the box');
    box.blur();assert.equal(list.hidden,true);
  }
  // The summary dialog aggregates the current search; a host row narrows the search to that host.
  {
    await typed('');window.document.querySelector('#stats-open').click();await flush();await flush();
    const dialog=window.document.querySelector('#stats-dialog');assert.equal(dialog.open,true);
    const cards=[...dialog.querySelectorAll('.stats-card b')].map(b=>b.textContent);
    assert.deepEqual(cards.slice(0,4),['3','1 · 33%','0','1']);assert.match(cards[4],/^4(\.0)? KB/);assert.deepEqual(cards.slice(5),['12 ms','40 ms','900 ms']);
    assert.match(window.document.querySelector('#stats-scope').textContent,/whole history/);
    assert.match(dialog.querySelector('.stats-line').textContent,/2xx 2.*4xx 1/);
    const hosts=[...dialog.querySelectorAll('.stats-table tr[data-host]')];assert.equal(hosts.length,2);assert.equal(hosts[1].querySelectorAll('td')[4].textContent,'—');
    hosts[0].click();await flush();
    assert.equal(window.document.querySelector('#filter').value,'host:=api.example.test');assert.equal(dialog.open,false);
    assert.match(window.document.querySelector('#stats-scope').textContent,/whole history/);
    await typed('');window.document.querySelector('#stats-open').click();await flush();await flush();
    [...dialog.querySelectorAll('.stats-line code')][1].click();await flush();
    assert.equal(window.document.querySelector('#filter').value,'status:4xx','a status class chip narrows the search');assert.equal(dialog.open,false);
    await typed('');
  }
  // A host condition elsewhere in the box narrows the values offered for the other fields.
  {
    const box=window.document.querySelector('#filter'),list=window.document.querySelector('#suggest');
    const labels=()=>list.hidden?[]:[...list.querySelectorAll('.suggest-item b')].map(b=>b.textContent);
    box.focus();await typed('path:/v1');assert.ok(labels().includes('/v1/items/7'),'every host\'s paths without a host condition: '+labels());
    await typed('host:=example.test path:/v1');    await typed('host:=example.test path:/v1');assert.ok(!labels().includes('/v1/items/7'),'another host\'s path is not offered: '+labels());
    await typed('host:=example.test path:/log');assert.deepEqual(labels(),['/login'],'that host\'s own paths are');
    assert.match(list.querySelector('.suggest-foot').textContent,/Tab/);
    await typed('');box.blur();
  }
  // Searches run on purpose (Enter, or leaving the box) come back as recent ones when the box is empty.
  {
    const box=window.document.querySelector('#filter'),list=window.document.querySelector('#suggest');
    const key=name=>box.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    const labels=()=>list.hidden?[]:[...list.querySelectorAll('.suggest-item b')].map(b=>b.textContent);
    window.localStorage.removeItem('librium-recent-searches');
    box.focus();await typed('host:api status:4xx');key('Enter');assert.equal(list.hidden,true,'Enter closes the list');
    await typed('is:error');box.blur();box.focus();
    await typed('');assert.deepEqual(labels().slice(0,3),['is:error','host:api status:4xx','host:'],'the newest first, then the fields: '+labels());
    assert.equal(list.querySelector('.suggest-head').textContent,'Recent searches');
    key('ArrowDown');key('ArrowDown');key('Enter');await flush();
    assert.equal(box.value,'host:api status:4xx','a recent search is put back whole');assert.equal(list.hidden,true);
    assert.deepEqual(JSON.parse(window.localStorage.getItem('librium-recent-searches')),['host:api status:4xx','is:error'],'the picked one moves to the front');
    await typed('');box.blur();window.localStorage.removeItem('librium-recent-searches');
  }
  // Intercept: the toggle arms the core, a held request fills the panel, the decision carries the edits.
  {
    const q=id=>window.document.querySelector('#'+id);
    window.librium.request=pristineRequest;// earlier blocks left single-argument wrappers behind
    q('intercept').click();await flush();await flush();
    assert.equal(interceptState.enabled,true);assert.equal(q('intercept-panel').hidden,false);assert.equal(q('intercept-editor').hidden,true,'nothing held yet');assert.equal(q('intercept-waiting').hidden,false);
    assert.match(q('intercept').textContent,/Intercept/);assert.equal(q('intercept').getAttribute('aria-pressed'),'true');
    interceptState.held=[{id:5,time:0,method:'POST',url:'https://api.example.test/v1/items',headers:[['content-type','application/json'],['x-a','1']],text:'{"a":1}',base64:'',size:7,truncated:false}];
    q('intercept-hosts').value='api.example.test, *.test';q('intercept-hosts').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.deepEqual(interceptState.hosts,['api.example.test','*.test'],'the host patterns go with the rules');
    q('intercept-methods').value='post, put';q('intercept-path').value=' /API/ ';q('intercept-methods').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.deepEqual(interceptState.methods,['POST','PUT'],'methods are upper-cased');assert.equal(interceptState.path,'/API/','the path goes as typed, the core lowers it');
    q('intercept-methods').value='';q('intercept-path').value='';q('intercept-path').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.deepEqual(interceptState.methods,[]);assert.equal(interceptState.path,'');
    assert.equal(q('intercept-editor').hidden,false);assert.equal(q('intercept-url').value,'https://api.example.test/v1/items');assert.equal(q('intercept-method').value,'POST');
    assert.equal(q('intercept-headers').value,'content-type: application/json\nx-a: 1');assert.equal(q('intercept-body').value,'{"a":1}');assert.match(q('intercept').textContent,/1$/);
    assert.equal(heldNotified.at(-1),1,'the desktop shell hears about held requests');
    q('intercept-collapse').click();assert.equal(q('intercept-panel').classList.contains('collapsed'),true);q('intercept-collapse').click();assert.equal(q('intercept-panel').classList.contains('collapsed'),false);
    q('intercept-body').value='{"a":2}';q('intercept-headers').value='content-type: application/json\nx-b: 2';
    q('intercept-forward').click();await flush();await flush();
    assert.deepEqual(decisions.at(-1),[5,{action:'forward',method:'POST',url:'https://api.example.test/v1/items',headers:[['content-type','application/json'],['x-b','2']],text:'{"a":2}'}]);
    assert.equal(q('intercept-editor').hidden,true);assert.equal(heldNotified.at(-1),0);
    interceptState.held=[{id:6,time:0,method:'GET',url:'https://api.example.test/bin',headers:[],text:'\uFFFD\uFFFD',base64:'AAE=',size:2,truncated:false}];
    q('intercept-hosts').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.equal(q('intercept-body').disabled,true,'a binary body is kept as it is');assert.match(q('intercept-note').textContent,/2 B/);
    q('intercept-drop').click();await flush();await flush();assert.deepEqual(decisions.at(-1),[6,{action:'drop'}]);
    assert.equal(q('intercept-queue').hidden,true,'one held request needs no queue');
    interceptState.held=[{id:8,time:0,method:'GET',url:'https://api.example.test/first',headers:[],text:'',base64:'',size:0,truncated:false},{id:9,time:0,method:'POST',url:'https://api.example.test/second',headers:[],text:'b',base64:'',size:1,truncated:false}];
    q('intercept-hosts').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.equal(q('intercept-queue').hidden,false);const tabs=[...q('intercept-queue').querySelectorAll('button')];
    assert.deepEqual(tabs.map(b=>b.textContent),['→ GET api.example.test/first','→ POST api.example.test/second']);assert.equal(tabs[0].classList.contains('current'),true);
    q('intercept-panel').dispatchEvent(new window.KeyboardEvent('keydown',{key:']',ctrlKey:true,bubbles:true,cancelable:true}));await flush();await flush();
    assert.equal(q('intercept-url').value,'https://api.example.test/second','Ctrl ] moves to the next held request');
    q('intercept-panel').dispatchEvent(new window.KeyboardEvent('keydown',{key:']',ctrlKey:true,bubbles:true,cancelable:true}));await flush();await flush();
    assert.equal(q('intercept-url').value,'https://api.example.test/first','and wraps around');
    tabs[1].click();await flush();await flush();
    assert.equal(q('intercept-url').value,'https://api.example.test/second','the picked request is shown');assert.equal(q('intercept-queue').querySelectorAll('button')[1].getAttribute('aria-selected'),'true');
    q('intercept-forward').click();await flush();await flush();assert.equal(decisions.at(-1)[0],9,'the decision goes to the picked one');
    assert.equal(q('intercept-url').value,'https://api.example.test/first','then the queue falls back to the first');assert.equal(q('intercept-queue').hidden,true);
    q('intercept-drop').click();await flush();await flush();
    // A held response: status instead of method, the URL is not editable, the decision carries the status.
    q('intercept-responses').checked=true;q('intercept-responses').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.equal(interceptState.responses,true,'the responses flag goes with the rules');
    interceptState.held=[{id:7,kind:'response',time:0,method:'GET',url:'https://api.example.test/v1/items',status:200,headers:[['content-type','application/json'],['content-encoding','gzip']],text:'{"ok":true}',base64:'',size:40,truncated:false,decoded:true}];
    q('intercept-hosts').dispatchEvent(new window.Event('change'));await flush();await flush();
    assert.equal(q('intercept-status').hidden,false);assert.equal(q('intercept-method').hidden,true);assert.equal(q('intercept-url').readOnly,true);assert.equal(q('intercept-status').value,'200');assert.match(q('intercept-note').textContent,/decoded|распакован/);
    // The held response, as edited, can be saved as a mock.
    assert.equal(q('intercept-mock').hidden,false);q('intercept-status').value='503';q('intercept-body').value='{"ok":false}';q('intercept-mock').click();await flush();
    assert.equal(q('mock-dialog').open,true);assert.equal(q('mock-host').value,'api.example.test');assert.equal(q('mock-path').value,'/v1/items');assert.equal(q('mock-method').value,'GET');
    assert.equal(q('mock-status').value,'503');assert.equal(q('mock-type').value,'application/json');assert.equal(q('mock-body').value,'{"ok":false}');
    q('mock-cancel').click();assert.equal(q('mock-dialog').open,false);
    // Ctrl/⌘ M mocks the selected exchange.
    window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'m',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));await flush();await flush();
    assert.equal(q('mock-dialog').open,true,'Ctrl Shift M opens the mock editor for the selection');q('mock-cancel').click();
    q('intercept-status').value='404';q('intercept-body').value='{"ok":false}';
    q('intercept-forward').click();await flush();await flush();
    assert.deepEqual(decisions.at(-1),[7,{action:'forward',status:404,headers:[['content-type','application/json'],['content-encoding','gzip']],text:'{"ok":false}'}]);
    q('intercept').click();await flush();await flush();assert.equal(interceptState.enabled,false);assert.equal(q('intercept-panel').hidden,true);assert.equal(q('intercept').getAttribute('aria-pressed'),'false');
  }
  // A dropped .har goes to the bridge as its File and the count is shown; other files are left alone.
  {
    const drop=name=>{const event=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:[{name}]}});window.document.dispatchEvent(event);return event;};
    assert.equal(window.document.querySelector('#import').hidden,false,'the desktop bridge offers import');
    assert.equal(drop('shot.png').defaultPrevented,false);assert.equal(imports.length,0,'only HAR files are imported');
    const event=drop('session.har');await flush();await flush();
    assert.equal(event.defaultPrevented,true);assert.equal(imports[0]?.name,'session.har');assert.match(window.document.querySelector('#toast').textContent,/3/,'the count is shown');
    // A dropped rules file (a .json that says librium_rules) goes to the rules import, not the HAR one.
    const rulesDrop=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(rulesDrop,'dataTransfer',{value:{types:['Files'],files:[{name:'team.json',slice(){return {text:async()=>'{"librium_rules":1,"mocks":[]}'};}}]}});
    window.document.dispatchEvent(rulesDrop);await flush();await flush();await flush();
    assert.equal(rulesIo.at(-1),'import:team.json','the rules file went to the rules import');assert.equal(imports.length,1,'not to the HAR import');
    const plainJson=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(plainJson,'dataTransfer',{value:{types:['Files'],files:[{name:'export.json',slice(){return {text:async()=>'{"log":{}}'};}}]}});
    window.document.dispatchEvent(plainJson);await flush();await flush();await flush();
    assert.equal(imports.at(-1)?.name,'export.json','a plain .json is still a HAR');
  }
  console.log('UI smoke OK: descending IDs, selection, JSON, inert headers, copy, search, layout, filter');
  dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
