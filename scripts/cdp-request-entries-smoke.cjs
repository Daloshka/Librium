const assert=require('node:assert/strict');
const {requestEntries}=require('../desktop/cdp.cjs');
const entry=bytes=>({bytes:Buffer.from(bytes).toString('base64')});
assert.equal(requestEntries(undefined),null);assert.equal(requestEntries([]),null);
const binary=requestEntries([entry([0,255]),entry([128,17,195,40])]);
assert.deepEqual(binary.bytes,Buffer.from([0,255,128,17,195,40]));assert.equal(binary.size,6);assert.equal(binary.complete,true);
const large=Buffer.alloc(100000,0xab),limited=requestEntries([entry([0,255]),entry(large)]);
assert.equal(limited.size,100002);assert.equal(limited.bytes.length,65536);assert.deepEqual(limited.bytes,Buffer.concat([Buffer.from([0,255]),large]).subarray(0,65536));
for(const missing of [{},{bytes:null},{bytes:'not base64!'}]){
  const partial=requestEntries([entry('prefix'),missing,entry('suffix')]);
  assert.equal(partial.complete,false);assert.equal(partial.bytes.toString(),'prefix');assert.equal(partial.size,12);
}
assert.equal(requestEntries([entry('')]).complete,true);
console.log('PASS: Chromium request body entries, exact binary bytes, 64 KiB prefix and missing-entry gaps');
async function pendingLifecycle(){
  const {CdpCapture}=require('../desktop/cdp.cjs'),saved=[];
  const capture=new CdpCapture({ingest:async event=>saved.push(event.exchange)});
  capture.sessions.set('closed',{title:'Closed target'});capture.sessions.set('kept',{title:'Other target'});
  for(const sessionId of ['closed','kept']){
    await capture.event({method:'Network.requestWillBeSent',sessionId,params:{requestId:'same-id',timestamp:10,wallTime:Date.now()/1000,request:{url:'http://fixture.invalid/'+sessionId,method:'POST',headers:{},hasPostData:true,...(sessionId==='kept'?{postDataEntries:[entry([0,255])]}:{})}}});
    await capture.event({method:'Network.responseReceived',sessionId,params:{requestId:'same-id',response:{status:202,headers:{'x-pending':'yes'}}}});
  }
  await capture.event({method:'Target.detachedFromTarget',params:{sessionId:'closed'}});
  assert.equal(saved.length,1);assert.equal(capture.requests.size,1);assert.equal(saved[0].summary.url,'http://fixture.invalid/closed');
  assert.equal(saved[0].summary.status,202);assert.equal(saved[0].request.complete,false);assert.equal(saved[0].response.complete,false);assert.match(saved[0].summary.error,/закрыты до завершения/);
  await capture.event({method:'Librium.closed'});
  assert.equal(saved.length,2);assert.equal(saved[1].request.base64,'AP8=');assert.equal(saved[1].request.complete,true);assert.equal(saved[1].response.complete,false);assert.equal(capture.requests.size,0);
  await capture.disconnect();assert.equal(saved.length,2,'repeated cleanup must not duplicate pending exchanges');
  console.log('PASS: pending HTTP survives target detach / transport close, target isolation, known bytes / unavailable bodies and idempotent cleanup');
  const attempts=[],ws=new CdpCapture({ingest:async event=>attempts.push(event)});
  for(const sessionId of ['closed','kept'])await ws.event({method:'Network.webSocketCreated',sessionId,params:{requestId:'same-id',url:'wss://fixture.invalid/'+sessionId}});
  await ws.event({method:'Network.webSocketWillSendHandshakeRequest',sessionId:'kept',params:{requestId:'same-id',request:{headers:{upgrade:'websocket','x-fixture':'sent'}}}});
  await ws.event({method:'Target.detachedFromTarget',params:{sessionId:'closed'}});
  assert.equal(attempts.length,1);assert.equal(attempts[0].websocket,false);assert.equal(attempts[0].exchange.summary.status,null);assert.equal(attempts[0].exchange.request.complete,false);assert.equal(attempts[0].exchange.response.complete,false);assert.equal(ws.handshakes.size,1);
  await ws.event({method:'Librium.closed'});
  assert.equal(attempts.length,2);assert.equal(attempts[1].exchange.request.complete,true);assert.ok(attempts[1].exchange.request.headers.some(([key,value])=>key==='x-fixture'&&value==='sent'));assert.equal(attempts[1].websocket,false);assert.match(attempts[1].exchange.summary.error,/Отладочное соединение/);
  await ws.disconnect();assert.equal(attempts.length,2);
  const crowded=new CdpCapture({ingest:async event=>attempts.push(event)});
  await crowded.event({method:'Network.webSocketCreated',params:{requestId:'queued',url:'wss://fixture.invalid/queued'}});
  const padding={method:'Fixture.padding',params:{text:''}},cap=8*1024*1024;
  padding.params.text='x'.repeat(cap-1-Buffer.byteLength(JSON.stringify(padding)));crowded.enqueue(padding);
  await crowded.disconnect();assert.equal(attempts.length,3);assert.match(attempts[2].exchange.summary.error,/Захват отключён/);assert.equal(crowded.status().error,null,'shutdown marker must survive a full event queue');assert.equal(crowded.queued,0);
  console.log('PASS: pending WS handshakes survive target / transport close, known vs unconfirmed headers and no fabricated open session');
}
pendingLifecycle().catch(error=>{console.error(error);process.exitCode=1;});
