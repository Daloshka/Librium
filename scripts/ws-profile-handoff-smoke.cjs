const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('ui/index.html','utf8'),{runScripts:'outside-only',url:'http://localhost/'}),{window}=dom,$=id=>window.document.getElementById(id);
const summary={id:1,status:101,method:'GET',url:'wss://profile.example.test/',time:0,size:0},payload={headers:[],base64:'',text:'',size:0,complete:true,truncated:false};
const messages=new Map([[11,{id:11,time:0,direction:'received',kind:'BINARY',text:'',base64:'eJw=',size:2,truncated:false}],[12,{id:12,time:0,direction:'sent',kind:'BINARY',text:'',base64:'H4sIAAAAAAAAAw==',size:10,truncated:false}]]);
const profile={id:1,total:2,through:12,summary,groups:[{kind:'zlib_header',count:1,sent:0,received:1,unknown:0,examples:[{id:11,direction:'received',kind:'BINARY',entry:null}]},{kind:'gzip_header',count:1,sent:1,received:0,unknown:0,examples:[{id:12,direction:'sent',kind:'BINARY',entry:null}]}]};
let hold=false,deferred=null;const queries=[];
window.librium={request:async route=>{
 if(route.startsWith('traffic-page?'))return {rows:[summary],total:1,matched:1,newest:1};
 if(route==='traffic/1')return {summary,request:payload,response:payload};
 if(route==='traffic/1/ws-profile')return profile;
 if(route.includes('/ws?')){queries.push(JSON.parse(new URLSearchParams(route.split('?')[1]).get('q')));return {total:2,matched:2,older:false,state:'closed',messages:[...messages.values()]};}
 const id=Number(route.split('/').at(-1));if(messages.has(id)){if(hold){hold=false;return new Promise((resolve,reject)=>{deferred={resolve:()=>resolve(messages.get(id)),reject};});}return messages.get(id);}
 throw Error('Unexpected route '+route);
}};
window.setTimeout=()=>0;window.requestAnimationFrame=callback=>callback();window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
for(const file of ['filters.js','ws-analysis.js','ws-message.js','ws-fields.js','ws-signatures.js','ws-export.js','ws-profile.js','app.js'])window.eval(fs.readFileSync('ui/'+file,'utf8')+(file==='app.js'?'\nwindow.profileHandoffTest={choose,openWsInspector,closeWsInspector};':''));
const flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
async function example(kind='zlib_header',delayed=false){$('ws-profile-open').click();await flush();hold=delayed;$('ws-profile-content').querySelector(`[data-format="${kind}"] button`).click();await flush();}
(async()=>{
 await flush();await window.profileHandoffTest.choose(1);await example();assert.equal($('ws-inflate-codec').value,'zlib');window.profileHandoffTest.closeWsInspector();
 for(const fail of [false,true]){
  await example('zlib_header',true);assert.ok(deferred);assert.equal($('ws-inspector-dialog').open,true);assert.equal($('ws-inflate-codec').value,'gzip');
  window.profileHandoffTest.closeWsInspector();await window.profileHandoffTest.openWsInspector(1,11,'hex');$('ws-inflate-codec').value='deflate';
  if(fail)deferred.reject(Error('obsolete payload failure'));else deferred.resolve();await flush();
  assert.equal($('ws-inflate-codec').value,'deflate','An obsolete profile load must not change the codec of a newer inspector for the same packet');assert.equal($('ws-inspector-dialog').open,true);assert.doesNotMatch($('ws-inspector-error').textContent,/obsolete/);window.profileHandoffTest.closeWsInspector();
 }
 await example('zlib_header',true);window.profileHandoffTest.closeWsInspector();deferred.resolve();await flush();assert.equal($('ws-inspector-dialog').open,false);assert.equal($('ws-inflate-codec').value,'gzip');
 await example('zlib_header',true);window.profileHandoffTest.closeWsInspector();await window.profileHandoffTest.openWsInspector(1,12,'hex');$('ws-inflate-codec').value='deflate';deferred.resolve();await flush();assert.equal($('ws-inflate-codec').value,'deflate');window.profileHandoffTest.closeWsInspector();
 await example('gzip_header');assert.equal($('ws-inflate-codec').value,'gzip');
 window.profileHandoffTest.closeWsInspector();$('ws-kind').value='BINARY';$('ws-direction').value='received';$('ws-filter').value='old text';$('ws-profile-open').click();await flush();$('ws-profile-content').querySelector('[data-format="gzip_header"] .ws-profile-filter').click();await flush();assert.equal(queries.at(-1).format,'content_kind');assert.equal(queries.at(-1).search,'gzip_header');assert.equal(queries.at(-1).kind,'');assert.equal(queries.at(-1).direction,'');assert.equal($('ws-filter').hidden,true);assert.equal($('ws-content-kind').value,'gzip_header');$('ws-content-kind').value='zlib_header';$('ws-content-kind').dispatchEvent(new window.Event('change'));await flush();assert.equal(queries.at(-1).search,'zlib_header');
 console.log('PASS: profile codec handoff survives same-packet reopen, superseded success / failure, close and another packet; active gzip / zlib hints still apply');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>window.close());
