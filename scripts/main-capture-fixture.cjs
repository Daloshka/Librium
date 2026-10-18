// Synthetic target for the parent-process inspector integration test.
const {app,BrowserWindow,net}=require('electron');
const http=require('node:http');
const {mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const profile=resolve(process.env.LIBRIUM_FIXTURE_PROFILE||'target/main-capture-fixture-profile');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
let window;
const originalWebSocketSend = WebSocket.prototype.send;
process.on('message', message => {
  if(message==='observer-state')process.send?.({observerWrapped:WebSocket.prototype.send!==originalWebSocketSend,
    libraryWrapped:Boolean(require.cache[require.resolve('ws')]&&Object.hasOwn(require.cache[require.resolve('ws')].exports.prototype,'emit')),
    observerGlobals:Object.getOwnPropertyNames(globalThis).filter(key=>/^(__libriumWs|libriumWs)[a-f0-9]+$/.test(key)).length});
});
globalThis.fixtureReady=false;
globalThis.fixtureBodyRequests=async(origin,marker)=>{
  const results=[];let producedChunks=0;
  const send=async(kind,body,stream=false)=>{
    const response=await fetch(origin+'/node-body?'+marker,{method:'POST',body,...(stream?{duplex:'half'}:{}),headers:{'content-type':'application/octet-stream'}});
    results.push({kind,response:await response.json()});
  };
  const pending=[];
  for(let n=0;n<12;n++)pending.push(send('json-'+n,JSON.stringify({index:n,text:'один URL · '+n})));
  pending.push(send('binary',new Uint8Array([99,0,255,128,17,77]).subarray(1,5)));
  pending.push(send('unicode','x'.repeat(65535)+'😀end'));
  pending.push(send('large',Buffer.alloc(2*1024*1024,0xab)));
  pending.push(send('stream',(async function*(){for(let n=0;n<4;n++){producedChunks++;yield Buffer.alloc(35000,n+1);await new Promise(resolve=>setTimeout(resolve,1));}})(),true));
  pending.push(send('empty',undefined));
  pending.push(send('empty-stream',(async function*(){})(),true));
  pending.push(fetch(origin+'/node-body-response-reset?'+marker,{method:'POST',body:'fully uploaded before response reset'}).then(()=>{throw Error('Expected response reset');},()=>{results.push({kind:'response-reset'});}));
  const earlyBody=(async function*(){yield Buffer.from('early prefix');await new Promise(resolve=>{globalThis.fixtureReleaseEarlyBody=resolve;});yield Buffer.from('later body');})();
  pending.push(fetch(origin+'/node-body-early?'+marker,{method:'POST',body:earlyBody,duplex:'half'}).then(async response=>{results.push({kind:'early',response:await response.json()});}));
  const controller=new AbortController();
  const abortBody=(async function*(){
    yield Buffer.from('aborted prefix');
    for(let n=0;n<100;n++){
      if(await(await fetch(origin+'/body-abort-ready?'+marker)).json())break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    controller.abort();
  })();
  pending.push(fetch(origin+'/node-body-abort?'+marker,{method:'POST',body:abortBody,duplex:'half',signal:controller.signal}).then(()=>{throw Error('Expected abort');},()=>{results.push({kind:'aborted'});}));
  await Promise.all(pending);return {results,producedChunks};
};
globalThis.fixtureRunWsLibrary=async(origin,marker)=>{
  const Ws=require('ws');let getters=0,callbacks=0;
  await new Promise((resolve,reject)=>{
    const ws=new Ws(origin.replace('http:','ws:')+'/library-ws?'+marker);let count=0;
    ws.on('error',reject);ws.on('open',()=>{
      ws.send(Buffer.from('{"library":"ws"}'),{get binary(){getters++;return false;}},()=>callbacks++);
      ws.send('binary string',{binary:true});ws.send('{"fragment":',{fin:false});ws.send('true}',{fin:true});
      ws.send(new Blob([new Uint8Array([7,128])]));ws.send('x'.repeat(70000));ws.ping('library ping',()=>callbacks++);
    });
    ws.on('message',()=>{if(++count===5)ws.close(1000,'library complete');});ws.on('close',resolve);
  });
  return {getters,callbacks};
};
globalThis.fixtureRun=async(origin,marker)=>{
  const address=path=>origin+path+'?'+marker;
  const echo=await(await fetch(address('/node-post'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({custom:'main process',value:17})})).json();
  const gzip=await(await fetch(address('/gzip'))).text();
  const binary=Buffer.from(await(await fetch(address('/binary'))).arrayBuffer()).toString('base64');
  const large=(await(await fetch(address('/large'))).arrayBuffer()).byteLength;
  const chunkedLarge=(await(await fetch(address('/chunked-large'))).arrayBuffer()).byteLength;
  const direct=await new Promise((resolve,reject)=>http.get(address('/node-http'),res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve(Buffer.concat(chunks).toString()));res.on('error',reject);}).on('error',reject));
  const directPost=await new Promise((resolve,reject)=>{const request=http.request(address('/node-http-post'),{method:'POST',headers:{'content-type':'text/plain'}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve(Buffer.concat(chunks).toString()));res.on('error',reject);});request.on('error',reject);request.end('http main payload');});
  let failed=false;try{await fetch(address('/failed'));}catch{failed=true;}
  await(await net.fetch(address('/electron-net'))).text();
  await window.webContents.executeJavaScript(`fetch(${JSON.stringify(address('/renderer'))}).then(r=>r.text())`);
  await new Promise((resolve,reject)=>{const ws=new WebSocket(address('/node-ws').replace('http:','ws:'));let received=0;ws.onopen=()=>{ws.send('custom from Node.js');ws.send(new Uint8Array([0,255,17]));ws.send(new Blob([new Uint8Array([7,128])]));ws.send('x'.repeat(9*1024*1024));};ws.onmessage=()=>{if(++received===4)ws.close(1000,'fixture complete');};ws.onclose=resolve;ws.onerror=reject;});
  return {echo,gzip,binary,large,chunkedLarge,direct,directPost,failed};
};
app.whenReady().then(async()=>{window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL(process.env.LIBRIUM_FIXTURE_ORIGIN+'/fixture');globalThis.fixtureReady=true;});
app.on('window-all-closed',()=>app.quit());

// Manual noServer upgrade mirrors Morphius' local CEF DevTools bridge.
globalThis.fixtureStartWsServer=async(secure,tlsDirectory)=>{
  const {WebSocketServer}=require('ws');
  const server=secure?require('node:https').createServer({key:require('node:fs').readFileSync(require('node:path').join(tlsDirectory,'key.pem')),cert:require('node:fs').readFileSync(require('node:path').join(tlsDirectory,'cert.pem'))}):http.createServer();
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:true});
  wss.on('headers',headers=>headers.push('X-Fixture-Server: final application value'));
  server.on('upgrade',(request,socket,head)=>wss.handleUpgrade(request,socket,head,function(peer,acceptedRequest){
    'use strict';if(this!==undefined||acceptedRequest!==request)throw Error('Upgrade callback semantics changed');
    peer.send('first server greeting');peer.ping(Buffer.from([0,255,1]));peer.on('message',(bytes,binary)=>peer.send(bytes,{binary}));
  }));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  globalThis.fixtureCloseWsServer=async()=>{for(const peer of wss.clients)peer.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));return true;};
  return server.address().port;
};
