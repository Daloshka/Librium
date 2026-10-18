const assert=require('node:assert/strict');
const {CdpCapture}=require('../desktop/cdp.cjs');
async function run(){
 const saved=[];const capture=new CdpCapture({ingest:async event=>{saved.push(event);return {id:saved.length};}});
 capture.command=async method=>method==='Network.getResponseBody'?{body:'reply',base64Encoded:false}:{};
 const emit=(method,params,sessionId)=>capture.event({method,params,sessionId});
 const attach=async(id,targetId)=>emit('Target.attachedToTarget',{sessionId:id,targetInfo:{targetId,title:'same',type:'page'}});
 const start=(id,requestId)=>emit('Network.requestWillBeSent',{requestId,timestamp:1,wallTime:1,request:{url:'https://example.test/same',method:'GET',headers:{}}},id);
 const finish=async(id,requestId)=>{await emit('Network.responseReceived',{requestId,response:{status:200,headers:{}}},id);await emit('Network.loadingFinished',{requestId,timestamp:2},id);};
 await attach('one','page-one');await attach('two','page-two');
 const first=capture.targetContext('one'),second=capture.targetContext('two');assert.notEqual(first,second);
 await start('one','first');await emit('Target.targetInfoChanged',{targetInfo:{targetId:'page-one',title:'renamed',captureContext:'forged'}});await finish('one','first');
 await start('one','next');await finish('one','next');await start('two','other');await finish('two','other');
 const rows=saved.filter(event=>event.event==='exchange').map(event=>event.exchange);
 assert.deepEqual(rows.map(row=>row.summary.capture_target),['same','renamed','same']);assert.deepEqual(rows.map(row=>row.summary.capture_context),[first,first,second]);assert.equal(rows[0].request.headers.find(([key])=>key==='x-librium-target')[1],'same');
 await emit('Network.webSocketCreated',{requestId:'ws',url:'wss://example.test/same'},'one');
 await emit('Target.targetInfoChanged',{targetInfo:{targetId:'page-one',title:'another title'}});
 await emit('Network.webSocketWillSendHandshakeRequest',{requestId:'ws',request:{headers:{}}},'one');
 await emit('Network.webSocketHandshakeResponseReceived',{requestId:'ws',response:{status:101,headers:{}}},'one');
 const socket=saved.filter(event=>event.event==='exchange').at(-1).exchange;assert.equal(socket.summary.capture_context,first);assert.equal(socket.summary.capture_target,'renamed');assert.equal(socket.request.headers.find(([key])=>key==='x-librium-target')[1],'renamed');
 await emit('Target.detachedFromTarget',{sessionId:'one'});await attach('one','page-one');assert.notEqual(capture.targetContext('one'),first);
 assert.equal(capture.targetContext('missing'),undefined);await capture.disconnect();
 console.log('PASS: identical target titles stay separate, rename keeps context, HTTP / WS snapshot start labels, CDP cannot replace local identity and reattach creates a new context');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
