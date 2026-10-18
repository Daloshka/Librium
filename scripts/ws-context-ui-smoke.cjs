const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('ui/index.html','utf8'),{runScripts:'outside-only'}),{window}=dom,doc=window.document;
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
window.eval(fs.readFileSync('ui/ws-context.js','utf8'));
const $=id=>doc.getElementById('ws-context-'+id),jobs=[],opened=[];let active=0,max=0;
const controller=window.LibriumWSContext.create({document:doc,request:route=>new Promise((resolve,reject)=>{active++;max=Math.max(max,active);jobs.push({route,resolve:value=>{active--;resolve(value);},reject:error=>{active--;reject(error);}});}),openMessage:(...args)=>opened.push(args)});
const result=(id,messageId)=>({id,message_id:messageId,previous:messageId>1?messageId-1:null,next:messageId+1,messages:[...new Set([Math.max(1,messageId-1),messageId,messageId+1])].map(key=>({id:key,time:10-key,direction:key%2?'sent':'received',kind:'TEXT',size:1000,truncated:true,preview:'<img src=x> packet '+key}))});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
(async()=>{
 controller.open(1,20,'hex');assert.equal(jobs[0].route,'traffic/1/ws/20/context');$('refresh').click();$('refresh').click();assert.equal(jobs.length,1);jobs[0].resolve(result(1,20));await flush();assert.equal(jobs.length,2);assert.equal($('content').textContent,'');jobs[1].resolve(result(1,20));await flush();assert.equal($('content').querySelectorAll('img').length,0);assert.match($('content').querySelector('tbody tr td:nth-child(2) strong').textContent,/\d{2}:\d{2}:\d{2}[,.]\d{3}/);assert.equal($('content').querySelector('[aria-current=true]').dataset.messageId,'20');const stale=$('content').querySelector('button');
 $('next').click();await flush();assert.deepEqual(opened,[[1,21,'hex']]);assert.equal($('dialog').open,false);stale.onclick();assert.equal(opened.length,1);
 controller.open(2,1);jobs[2].resolve(result(2,1));await flush();assert.equal($('previous').disabled,true);assert.equal($('next').disabled,false);$('content').querySelector('tr[data-message-id="2"] button').click();await flush();assert.deepEqual(opened[1],[2,2,'pretty']);
 controller.open(3,40);controller.close();controller.open(4,50);assert.equal(jobs.length,4);jobs[3].reject(Error('stale failure'));await flush();assert.equal(jobs.length,5);assert.equal($('error').hidden,true);jobs[4].resolve(result(4,50));await flush();assert.match($('state').textContent,/#4/);
 $('refresh').click();const oldNext=$('next').onclick;oldNext();assert.equal(opened.length,2);jobs[5].reject(Error('read failed'));await flush();assert.match($('error').textContent,/read failed/);$('refresh').click();jobs[6].resolve(result(4,50));await flush();assert.equal($('error').hidden,true);
 $('refresh').click();jobs[7].resolve(result(5,50));await flush();assert.match($('error').textContent,/Неверный контекст/);assert.equal($('next').disabled,true);assert.equal(max,1);controller.close();
 console.log('PASS: WS context original order, inert previews, selected packet, neighbor handoff with format, boundaries, bounded latest queue, stale close / refresh actions, retry and source validation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>window.close());
