const assert=require('node:assert/strict');
const http=require('node:http');
const {gzipSync,gunzipSync}=require('node:zlib');
const {spawn}=require('node:child_process');
const {WebSocketServer}=require('ws');
const {CaptureController}=require('../desktop/capture-controller.cjs');
const {CaptureTarget}=require('../desktop/launch-target.cjs');
const fs=require('node:fs'),path=require('node:path');
let child,server,wss,capture;
const timeout=setTimeout(()=>{console.error('Main-process integration timed out');child?.kill();process.exit(1);},45000);
async function run(){
  const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1];
  async function api(path,body){const res=await fetch('http://127.0.0.1:3000/api/'+path,{method:body?'POST':'GET',headers:{'x-librium-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!res.ok)throw Error('API '+res.status+' '+await res.text());return res.json();}
  server=http.createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/failed'){req.socket.destroy();return;}
    if(path==='/fixture'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Synthetic main-process fixture</title>');return;}
    if(path==='/gzip'){res.writeHead(200,{'content-type':'text/plain','content-encoding':'gzip'});res.end(gzipSync('main process compressed response'));return;}
    if(path==='/binary'){res.setHeader('content-type','application/octet-stream');res.end(Buffer.from([0,255,17,128]));return;}
    if(path==='/large'){res.setHeader('content-type','application/octet-stream');res.end(Buffer.alloc(2*1024*1024,7));return;}
    if(path==='/chunked-large'){res.setHeader('content-type','application/octet-stream');res.write(Buffer.alloc(1024*1024,8));res.end(Buffer.alloc(1024*1024,8));return;}
    if(path==='/node-post'){const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({received:JSON.parse(Buffer.concat(chunks))}));});return;}
    if(path==='/node-http-post'){const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{res.setHeader('content-type','text/plain');res.end(Buffer.concat(chunks));});return;}
    res.setHeader('content-type','text/plain');res.end(path==='/node-http'?'http module response':'renderer response');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',(bytes,binary)=>ws.send(bytes,{binary})));
  const project=fs.mkdtempSync(path.resolve('target','Проект Electron с пробелами-'));
  fs.mkdirSync(path.join(project,'node_modules'),{recursive:true});
  fs.symlinkSync(path.dirname(require.resolve('electron')),path.join(project,'node_modules','electron'),'junction');
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'custom-electron-fixture',main:path.resolve('scripts/main-capture-fixture.cjs')}));
  const selected=new CaptureTarget(path.join(project,'capture-target.json'));selected.select(path.join(project,'package.json'));
  const launch=async(port,main=true)=>{
    const options={windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,LIBRIUM_FIXTURE_ORIGIN:origin,LIBRIUM_FIXTURE_PROFILE:path.resolve(`target/main-capture-profile-${port}`)}};
    if(main){await selected.launch(port,{spawnProcess:(executable,args,opts)=>(child=spawn(executable,args,{...opts,...options}))});}
    else{child=spawn(require('electron'),[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','scripts/main-capture-fixture.cjs'],options);await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
  };
  capture=new CaptureController({ingest:event=>api('capture',event),launch:async()=>{throw Error('Default launcher must not run for a selected project');}});
  const state=await capture.launchAndConnect(19337,{launch,label:'Custom Electron fixture'});assert.ok(state.sources.every(s=>s.connected),JSON.stringify(state));
  const main=capture.captures.node;
  for(let n=0;n<100;n++){const value=await main.command('Runtime.evaluate',{expression:'globalThis.fixtureReady',returnByValue:true});if(value.result.value)break;await new Promise(r=>setTimeout(r,30));}
  const marker='librium-main-smoke='+Date.now();
  const value=await main.command('Runtime.evaluate',{expression:`globalThis.fixtureRun(${JSON.stringify(origin)},${JSON.stringify(marker)})`,awaitPromise:true,returnByValue:true});
  assert.equal(value.exceptionDetails,undefined,JSON.stringify(value.exceptionDetails));const result=value.result.value;
  assert.deepEqual(result.echo.received,{custom:'main process',value:17});assert.equal(result.gzip,'main process compressed response');assert.equal(result.binary,'AP8RgA==');assert.equal(result.large,2*1024*1024);assert.equal(result.direct,'http module response');assert.equal(result.failed,true);
  await new Promise(r=>setTimeout(r,300));await Promise.all(Object.values(capture.captures).map(c=>c.queue));
  const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})));
  const find=path=>page.rows.find(row=>new URL(row.url).pathname===path);
  const post=await api('traffic/'+find('/node-post').id);assert.equal(post.summary.source,'cdp_node');assert.equal(post.request.complete,true);assert.deepEqual(JSON.parse(post.request.text),{custom:'main process',value:17});assert.match(post.response.text,/"received"/);assert.ok(post.request.headers.some(([k,v])=>k==='x-librium-target'&&v.includes('main process')));
  assert.equal(result.directPost,'http main payload');
  const directPost=await api('traffic/'+find('/node-http-post').id);assert.equal(directPost.request.complete,false);assert.ok(directPost.request.headers.some(([k])=>k==='x-librium-capture-note'));assert.equal(directPost.response.text,'http main payload');
  assert.ok(Math.abs(Date.now()-post.summary.time)<10000,'request timestamp must use Unix milliseconds');
  const compressed=await api('traffic/'+find('/gzip').id);assert.equal(gunzipSync(Buffer.from(compressed.response.base64,'base64')).toString(),'main process compressed response');assert.ok(!compressed.response.headers.some(([k])=>k==='x-librium-body-decoded'));
  assert.equal((await api('traffic/'+find('/binary').id)).response.base64,'AP8RgA==');assert.equal((await api('traffic/'+find('/node-http').id)).response.text,'http module response');assert.equal(find('/renderer').source,'cdp_chromium');
  const large=await api('traffic/'+find('/large').id);assert.equal(large.response.size,2*1024*1024);assert.equal(large.response.truncated,true);assert.equal(Buffer.from(large.response.base64,'base64').length,65536);
  assert.equal(result.chunkedLarge,2*1024*1024);const chunked=await api('traffic/'+find('/chunked-large').id);assert.equal(chunked.response.complete,false);assert.equal(chunked.response.truncated,true);assert.ok(chunked.response.headers.some(([k,v])=>k==='x-librium-capture-note'&&v.includes('полный размер')));
  assert.ok(find('/failed').error,'failed main-process request must retain its error');
  const ws=find('/node-ws');assert.equal(ws.status,101);assert.equal(page.rows.filter(row=>new URL(row.url).pathname==='/node-ws').length,1,'observer must not duplicate native inspector handshake');
  const wsDetail=await api('traffic/'+ws.id);assert.ok(wsDetail.request.headers.some(([k,v])=>k==='x-librium-capture-note'&&v.includes('наблюдатель')));
  const frames=await api('traffic/'+ws.id+'/ws');assert.equal(frames.state,'closed');
  assert.deepEqual(frames.close,{code:1000,reason:'fixture complete'});
  assert.equal(frames.messages.length,8);for(const direction of ['sent','received']){
    assert.ok(frames.messages.some(m=>m.direction===direction&&m.kind==='TEXT'&&m.text==='custom from Node.js'));
    assert.ok(frames.messages.some(m=>m.direction===direction&&m.kind==='BINARY'&&m.base64==='AP8R'));
    assert.ok(frames.messages.some(m=>m.direction===direction&&m.kind==='BINARY'&&m.base64==='B4A='));
    assert.ok(frames.messages.some(m=>m.direction===direction&&m.size===9*1024*1024&&m.truncated&&Buffer.from(m.base64,'base64').length===65536));
  }
  assert.equal(capture.status().error,null,JSON.stringify(capture.status()));assert.ok(capture.status().warning);
  const tlsDirectory=process.env.LIBRIUM_TEST_TLS_DIR,tlsRelative=tlsDirectory&&path.relative(path.resolve('target'),path.resolve(tlsDirectory));assert.ok(tlsRelative&&!tlsRelative.startsWith('..')&&!path.isAbsolute(tlsRelative),'Run this integration through test-network.ps1 with an owned target data directory');
  for(const secure of [false,true]){
    const started=await main.command('Runtime.evaluate',{expression:`globalThis.fixtureStartWsServer(${secure},${JSON.stringify(tlsDirectory)})`,awaitPromise:true,returnByValue:true});assert.equal(started.exceptionDetails,undefined,JSON.stringify(started.exceptionDetails));
    const serverMarker=marker+'-server-'+secure,url=`${secure?'wss':'ws'}://127.0.0.1:${started.result.value}/devtools/page/fixture?${serverMarker}`,large=Buffer.alloc(70000,0xab);
    await Promise.all([1,2].map(index=>new Promise((resolve,reject)=>{
      const peer=new (require('ws').WebSocket)(url,'morphius-cdp',{rejectUnauthorized:false,headers:{'X-Fixture-Client':String(index)}});let messages=0,pongs=0;
      const finish=()=>{if(messages===3&&pongs===1)peer.close(1000,'server capture complete');};
      peer.on('error',reject);peer.on('open',()=>{peer.send('fragment ',{fin:false});peer.send('command '+index,{fin:true});peer.send(large);peer.ping(Buffer.from([1,0,254]));});
      peer.on('message',(bytes,binary)=>{if(binary)assert.deepEqual(bytes,large);messages++;finish();});peer.on('pong',()=>{pongs++;finish();});peer.on('close',code=>{try{assert.equal(code,1000);assert.equal(messages,3);resolve();}catch(error){reject(error);}});
    })));
    await new Promise(resolve=>setTimeout(resolve,150));await main.queue;
    const found=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:serverMarker})));const sockets=found.rows.filter(row=>row.status===101);assert.equal(sockets.length,2,JSON.stringify(found.rows));
    const clients=new Set();for(const row of sockets){assert.equal(row.url,url);assert.equal(row.source,'cdp_node');assert.equal(row.ws_role,'server');const detail=await api('traffic/'+row.id);assert.ok(detail.request.headers.some(([key,value])=>key==='x-librium-ws-role'&&value==='server'));const client=detail.request.headers.find(([key])=>key.toLowerCase()==='x-fixture-client')?.[1];clients.add(client);assert.ok(detail.response.headers.some(([key,value])=>key==='X-Fixture-Server'&&value==='final application value'));assert.ok(detail.response.headers.some(([key,value])=>key==='Sec-WebSocket-Protocol'&&value==='morphius-cdp'));
      const frames=await api('traffic/'+row.id+'/ws');assert.equal(frames.state,'closed');assert.equal(frames.error,null);assert.deepEqual(frames.close,{code:1000,reason:'server capture complete'});
      assert.ok(frames.messages.some(message=>message.direction==='sent'&&message.kind==='TEXT'&&message.text==='first server greeting'));
      for(const direction of ['sent','received']){assert.ok(frames.messages.some(message=>message.direction===direction&&message.kind==='TEXT'&&message.text==='fragment command '+client));assert.ok(frames.messages.some(message=>message.direction===direction&&message.kind==='BINARY'&&message.size===70000&&message.truncated&&Buffer.from(message.base64,'base64').equals(large.subarray(0,65536))));}
      assert.ok(frames.messages.some(message=>message.direction==='sent'&&message.kind==='PING'&&message.base64==='AP8B'));assert.ok(frames.messages.some(message=>message.direction==='received'&&message.kind==='PONG'&&message.base64==='AP8B'));assert.ok(frames.messages.some(message=>message.direction==='received'&&message.kind==='PING'&&message.base64==='AQD+'));assert.ok(frames.messages.some(message=>message.direction==='sent'&&message.kind==='PONG'&&message.base64==='AQD+'));
    }assert.deepEqual([...clients].sort(),['1','2']);
    const stopped=await main.command('Runtime.evaluate',{expression:'globalThis.fixtureCloseWsServer()',awaitPromise:true,returnByValue:true});assert.equal(stopped.result.value,true);
  }
  console.log('PASS: server-side ws / wss manual upgrade, first reply, same-URL peer isolation, actual request / final response headers, subprotocol, directions, fragmented text, 70 KiB previews and controls through CDP / SQLite');
  const libraryRun=await main.command('Runtime.evaluate',{expression:`globalThis.fixtureRunWsLibrary(${JSON.stringify(origin)},${JSON.stringify(marker+'-library')})`,awaitPromise:true,returnByValue:true});
  assert.equal(libraryRun.exceptionDetails,undefined,JSON.stringify(libraryRun.exceptionDetails));assert.deepEqual(libraryRun.result.value,{getters:1,callbacks:2});
  await new Promise(resolve=>setTimeout(resolve,150));await main.queue;
  const libraryRows=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-library'})));
  const librarySockets=libraryRows.rows.filter(row=>row.url.startsWith('ws:'));assert.equal(librarySockets.length,1,JSON.stringify(libraryRows.rows));
  const libraryId=librarySockets[0].id;assert.equal(librarySockets[0].source,'cdp_node');assert.equal(librarySockets[0].ws_role,'client');
  const libraryDetail=await api('traffic/'+libraryId);assert.ok(libraryDetail.request.headers.some(([key,value])=>key==='x-librium-capture-note'&&value.includes('библиотеки ws')));
  const libraryFrames=await api('traffic/'+libraryId+'/ws');assert.equal(libraryFrames.state,'closed');
  assert.deepEqual(libraryFrames.close,{code:1000,reason:'library complete'});
  for(const direction of ['sent','received']){
    assert.ok(libraryFrames.messages.some(message=>message.direction===direction&&message.kind==='TEXT'&&message.text==='{"library":"ws"}'));
    assert.ok(libraryFrames.messages.some(message=>message.direction===direction&&message.kind==='TEXT'&&message.text==='{"fragment":true}'));
    assert.ok(libraryFrames.messages.some(message=>message.direction===direction&&message.kind==='BINARY'&&Buffer.from(message.base64,'base64').toString()==='binary string'));
    assert.ok(libraryFrames.messages.some(message=>message.direction===direction&&message.base64==='B4A='));
    assert.ok(libraryFrames.messages.some(message=>message.direction===direction&&message.size===70000&&message.truncated));
  }
  assert.ok(libraryFrames.messages.some(message=>message.direction==='sent'&&message.kind==='PING'));
  assert.ok(libraryFrames.messages.some(message=>message.direction==='received'&&message.kind==='PONG'));
  assert.equal(capture.status().error,null,JSON.stringify(capture.status()));
  await capture.disconnect();assert.ok(!capture.status().connected);assert.equal(child.exitCode,null,'detaching must leave the application alive');
  const wrapped=()=>new Promise((resolve,reject)=>{
    const listener=message=>{clearTimeout(timer);if(!message.observerWrapped&&(message.observerGlobals||message.libraryWrapped))reject(Error('Observer globals / ws methods remain after cleanup'));else resolve(message.observerWrapped);};
    const timer=setTimeout(()=>{child.off('message',listener);reject(Error('No fixture IPC response'));},2000);
    child.once('message',listener);child.send('observer-state');
  });
  assert.equal(await wrapped(),false,'normal detach must restore the send method');
  await main.connect(19338,'node');assert.equal(await wrapped(),true);
  // Lose only the transport, without sending the cleanup command to the app.
  main.socket.close();await new Promise(resolve=>setTimeout(resolve,6200));
  assert.equal(await wrapped(),false,'expired lease must restore send after abrupt debugger loss');
  assert.equal(child.exitCode,null);await main.disconnect();
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  capture=new CaptureController({ingest:event=>api('capture',event),launch:port=>launch(port,false),timeoutMs:5000});
  const partial=await capture.launchAndConnect(19339);assert.equal(partial.sources.find(s=>s.mode==='chromium').connected,true);assert.equal(partial.sources.find(s=>s.mode==='node').connected,false);assert.ok(partial.error.includes('Node.js'));
  const browser=capture.captures.chromium,pageSession=[...browser.sessions.entries()].find(([,target])=>target.type==='page')?.[0];assert.ok(pageSession);
  await browser.command('Runtime.evaluate',{expression:`fetch(${JSON.stringify(origin+'/partial?'+marker+'-partial')}).then(r=>r.text())`,awaitPromise:true,returnByValue:true},pageSession);
  await new Promise(r=>setTimeout(r,100));await browser.queue;
  const partialRows=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-partial'})));assert.ok(partialRows.rows.some(row=>row.source==='cdp_chromium'&&row.status===200));
  console.log('PASS: renderer and Node.js sources, HTTP bodies/availability, gzip/binary, bounded previews, errors, Node WS messages without duplicates, detach and partial-source fallback');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  clearTimeout(timeout);await capture?.disconnect().catch(()=>{});child?.kill();for(const ws of wss?.clients||[])ws.terminate();if(wss)await new Promise(r=>wss.close(r));if(server)await new Promise(r=>server.close(r));
});
