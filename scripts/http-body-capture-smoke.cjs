const assert=require('node:assert/strict');
const http=require('node:http'),path=require('node:path');
const {createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const {CdpCapture}=require('../desktop/cdp.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let child,server,capture;
const timeout=setTimeout(()=>{console.error('Request body capture timed out');child?.kill();process.exit(1);},30000);
async function run(){
  const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1];
  async function api(route,body){const response=await fetch('http://127.0.0.1:3000/api/'+route,{method:body?'POST':'GET',headers:{'x-librium-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200);return response.json();}
  let sequence=0,abortReady=false,resetReceived=null;const pendingResponses=new Map();
  server=http.createServer((request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    if(route==='/fixture'){response.end('<!doctype html><title>Request body fixture</title>');return;}
    if(route==='/body-abort-ready'){response.end(JSON.stringify(abortReady));return;}
    if(route==='/node-body-early'){request.resume();response.setHeader('content-type','application/json');response.end('{"early":true}');return;}
    const chunks=[],id=++sequence;
    request.on('error',()=>{});request.on('data',chunk=>{chunks.push(chunk);if(route==='/node-body-abort')abortReady=true;});
    request.on('end',()=>{
      const bytes=Buffer.concat(chunks),result={id,size:bytes.length,hash:hash(bytes),previewHash:hash(bytes.subarray(0,65536))};
      if(route==='/node-body-pending'){response.writeHead(202,{'x-fixture-pending':'yes'});response.flushHeaders();pendingResponses.set(new URL(request.url,'http://localhost').searchParams.get('phase'),response);return;}
      if(route==='/node-body-response-reset'){resetReceived=result;response.destroy();return;}
      response.setHeader('content-type','application/json');for(const [key,value] of Object.entries(result))response.setHeader('x-fixture-'+key,String(value));response.end(JSON.stringify(result));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  child=spawn(require('electron'),['--inspect-brk=127.0.0.1:19511','--experimental-network-inspection','scripts/main-capture-fixture.cjs'],{
    windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,LIBRIUM_FIXTURE_ORIGIN:origin,LIBRIUM_FIXTURE_PROFILE:path.resolve('target/http-body-profile-'+Date.now())},
  });
  capture=new CdpCapture({mode:'node',ingest:event=>api('capture',event)});
  for(let n=0;n<100;n++){try{await capture.connect(19511,'node',{startup:true});break;}catch(error){if(!error.message.includes('ECONNREFUSED'))throw error;await delay(20);}}
  for(let n=0;n<100;n++){if((await capture.command('Runtime.evaluate',{expression:'globalThis.fixtureReady',returnByValue:true})).result?.value)break;await delay(20);}
  const marker='librium-http-body='+Date.now();
  const run=await capture.command('Runtime.evaluate',{expression:`globalThis.fixtureBodyRequests(${JSON.stringify(origin)},${JSON.stringify(marker)})`,awaitPromise:true,returnByValue:true});
  assert.equal(run.exceptionDetails,undefined,JSON.stringify(run.exceptionDetails));const result=run.result.value;assert.equal(result.producedChunks,4,'observer must not consume a request stream twice');
  await delay(100);await capture.queue;
  const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker}))),normal=page.rows.filter(row=>new URL(row.url).pathname==='/node-body');
  const expected=result.results.filter(entry=>entry.response?.id);assert.equal(normal.length,expected.length);
  const byKind=new Map();
  for(const row of normal){
    const detail=await api('traffic/'+row.id),header=name=>detail.response.headers.find(([key])=>key.toLowerCase()==='x-fixture-'+name)?.[1];
    const entry=expected.find(entry=>entry.response.id===Number(header('id')));assert.ok(entry,JSON.stringify(row));byKind.set(entry.kind,detail);
    const bytes=Buffer.from(detail.request.base64,'base64');
    assert.equal(detail.summary.source,'cdp_node');assert.equal(detail.request.size,entry.response.size,entry.kind);
    assert.equal(hash(bytes),entry.response.previewHash,entry.kind+' request bytes must match the actual server input');
    assert.equal(detail.request.truncated,entry.response.size>bytes.length,entry.kind);
    if(entry.kind!=='empty-stream')assert.equal(detail.request.complete,true,entry.kind);
    else if(!detail.request.complete)assert.ok(detail.request.headers.some(([key])=>key==='x-librium-capture-note'));
  }
  for(let n=0;n<12;n++)assert.equal(JSON.parse(byKind.get('json-'+n).request.text).index,n,'parallel requests on the same URL must remain distinct');
  assert.equal(byKind.get('binary').request.base64,'AP+AEQ==');
  assert.equal(Buffer.from(byKind.get('unicode').request.base64,'base64').at(-1),0xf0,'UTF-8 preview must retain the correct first byte of a boundary code point');
  assert.equal(byKind.get('large').request.size,2*1024*1024);assert.equal(byKind.get('stream').request.size,140000);
  const early=await api('traffic/'+page.rows.find(row=>new URL(row.url).pathname==='/node-body-early').id);
  assert.equal(early.request.complete,false);assert.equal(early.request.text,'early prefix');assert.ok(early.request.headers.some(([key,value])=>key==='x-librium-capture-note'&&value.includes('не завершилась')));
  const aborted=await api('traffic/'+page.rows.find(row=>new URL(row.url).pathname==='/node-body-abort').id);
  assert.ok(aborted.summary.error);assert.equal(aborted.request.complete,false);assert.equal(aborted.request.text,'aborted prefix');
  const reset=await api('traffic/'+page.rows.find(row=>new URL(row.url).pathname==='/node-body-response-reset').id);
  assert.ok(resetReceived);assert.ok(reset.summary.error);assert.equal(reset.response.complete,false);
  assert.equal(reset.request.complete,true,'a failed response must not mark a completed upload incomplete');
  assert.equal(reset.request.text,'fully uploaded before response reset');assert.equal(hash(Buffer.from(reset.request.base64,'base64')),resetReceived.hash);
  await capture.command('Runtime.evaluate',{expression:'globalThis.fixtureReleaseEarlyBody?.()',returnByValue:true});
  async function startPending(phase){
    const url=origin+'/node-body-pending?'+marker+'&phase='+phase;
    await capture.command('Runtime.evaluate',{expression:`void fetch(${JSON.stringify(url)},{method:'POST',body:'pending upload '+${JSON.stringify(phase)}}).then(r=>r.text()).then(body=>process.send({type:'pending-done',phase:${JSON.stringify(phase)},body}))`});
    for(let n=0;n<100;n++){if(pendingResponses.has(phase)&&[...capture.requests.values()].some(row=>row.request.url===url&&row.response))return url;await delay(20);}
    throw Error('Pending response headers not observed: '+phase);
  }
  async function checkPending(url,phase,complete){
    const pendingPage=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:url})));assert.equal(pendingPage.rows.length,1,phase);
    const saved=await api('traffic/'+pendingPage.rows[0].id);assert.equal(saved.summary.status,202);assert.equal(saved.response.complete,false);assert.match(saved.summary.error,/до завершения HTTP/);assert.ok(saved.response.headers.some(([key,value])=>key==='x-librium-capture-note'&&value.includes('не наблюдается')));
    assert.equal(saved.request.complete,complete,phase);if(complete)assert.equal(saved.request.text,'pending upload '+phase);
    const received=new Promise(resolve=>{const listener=message=>{if(message.type==='pending-done'&&message.phase===phase){child.off('message',listener);resolve(message.body);}};child.on('message',listener);});
    pendingResponses.get(phase).end('application still receives '+phase);assert.equal(await received,'application still receives '+phase);
  }
  const detached=await startPending('detach');
  assert.equal(capture.status().error,null,JSON.stringify(capture.status()));await capture.disconnect();assert.equal(child.exitCode,null);await checkPending(detached,'detach',true);
  await capture.connect(19511,'node');const lost=await startPending('loss');
  const closed=new Promise(resolve=>capture.socket.addEventListener('close',resolve,{once:true}));capture.socket.close();await closed;await capture.queue;await checkPending(lost,'loss',false);
  assert.equal(child.exitCode,null);
  console.log('PASS: real Node request body IDs, parallel POSTs, JSON / binary / UTF-8 / streams / 2 MiB, abort / reset / early response, pending HTTP on detach and transport loss without cancelling application requests');
}
run().catch(error=>{console.error(error);console.error(JSON.stringify(capture?.status()));process.exitCode=1;}).finally(async()=>{
  clearTimeout(timeout);await capture?.disconnect().catch(()=>{});child?.kill();if(server)await new Promise(resolve=>server.close(resolve));
});
