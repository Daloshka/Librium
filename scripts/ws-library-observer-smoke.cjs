const {app}=require('electron');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),path=require('node:path');
const {WebSocketServer,WebSocket:Ws}=require('ws');
const {observeWebSockets}=require('../desktop/node-ws-observer.cjs');
const {observeWsLibraries}=require('../desktop/ws-library-observer.cjs');
const profile=path.resolve('target/ws-library-observer-profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
let server,wss;const events=[],slot='__libriumWsLibraryTest';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const install=(lease=5000,limits={})=>{globalThis.libriumWsLibraryEmit=value=>events.push(JSON.parse(value));return observeWebSockets('libriumWsLibraryEmit',slot,lease,observeWsLibraries,undefined,limits);};
const timeout=setTimeout(()=>{console.error('ws library observer timed out');app.exit(1);},20000);
async function run(){
  server=http.createServer();wss=new WebSocketServer({server,perMessageDeflate:true});
  wss.on('headers',headers=>headers.push('X-Server-Observer: final application header'));
  wss.on('connection',ws=>{ws.ping('from server');ws.on('message',(bytes,binary)=>{
    if(bytes.toString()==='fragments-incoming'){ws.send(Buffer.from('fragmented '),{binary:true,fin:false});ws.send(Buffer.from('response'),{binary:true,fin:true});}
    else ws.send(bytes,{binary});
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`ws://127.0.0.1:${server.address().port}/same-url`;
  const originalEmit=Ws.prototype.emit,originalSend=Ws.prototype.send,originalServerEmit=WebSocketServer.prototype.emit,originalUpgrade=WebSocketServer.prototype.handleUpgrade;
  assert.equal(install().available,true);assert.notEqual(Ws.prototype.emit,originalEmit);assert.equal(Ws.prototype.send,originalSend);
  class FakeServer extends require('node:events').EventEmitter{handleUpgrade(request,socket,head,callback){return callback.call(socket,request,head);}}
  const fakeOriginal=FakeServer.prototype.handleUpgrade;globalThis[slot].registerWs(FakeServer);const fake=new FakeServer(),fakeRequest={},fakeSocket={},fakeHead={},callbackResult={};
  assert.equal(fake.handleUpgrade(fakeRequest,fakeSocket,fakeHead,function(request,head){'use strict';assert.equal(this,fakeSocket);assert.equal(request,fakeRequest);assert.equal(head,fakeHead);return callbackResult;}),callbackResult);
  const callbackError=Error('callback exception');assert.throws(()=>fake.handleUpgrade(fakeRequest,fakeSocket,fakeHead,()=>{throw callbackError;}),error=>error===callbackError);
  let getters=0,callbacks=0;
  const first=new Ws(url,{headers:{'X-Client-Observer':'original request header'}});assert.throws(()=>first.send('too early'),/not open/);
  const firstDone=new Promise((resolve,reject)=>{
    let received=0;first.on('error',reject);first.on('message',()=>{if(++received===6)first.close(1000,'done');});first.on('close',resolve);
    first.on('open',()=>{
      first.send(Buffer.from('text from Buffer'),{get binary(){getters++;return 0;}},()=>callbacks++);
      first.send('binary string',{binary:1});first.send('fragment ',{fin:0});first.send('complete',{fin:1});
      first.send(new Blob([new Uint8Array([7,128])]));first.send('я'.repeat(40000));first.send(Buffer.alloc(9*1024*1024,7));
      first.ping('heartbeat',()=>callbacks++);
      assert.equal(first.emit('no application listener'),false);
      const error=Error('application exception');first.on('custom',()=>{throw error;});
      assert.throws(()=>first.emit('custom'),value=>value===error);
    });
  });
  const second=new Ws(url);const secondDone=new Promise((resolve,reject)=>{second.on('error',reject);second.on('open',()=>second.send('second connection'));second.on('message',()=>second.close());second.on('close',resolve);});
  await Promise.all([firstDone,secondDone]);await delay(80);
  assert.equal(getters,1,'observer must not evaluate send option getters a second time');assert.equal(callbacks,2);
  const frames=events.filter(event=>event.type==='frame');
  const serverOpens=events.filter(event=>event.type==='open'&&event.role==='server');assert.equal(serverOpens.length,2);assert.ok(serverOpens.every(event=>event.url===url&&event.partial===false));
  assert.ok(serverOpens.every(event=>event.responseHeaders.some(([key,value])=>key==='X-Server-Observer'&&value==='final application header')));
  const serverKey=serverOpens.find(event=>event.requestHeaders.some(([key,value])=>key.toLowerCase()==='x-client-observer'&&value==='original request header')).key;
  for(const direction of ['sent','received']){const own=frames.filter(event=>event.key===serverKey&&event.direction===direction);assert.ok(own.some(event=>event.kind==='TEXT'&&Buffer.from(event.base64,'base64').toString()==='text from Buffer'));assert.ok(own.some(event=>event.kind==='BINARY'&&event.base64==='B4A='));assert.ok(own.some(event=>event.size===9*1024*1024&&event.truncated));}
  assert.ok(frames.some(event=>event.key===serverKey&&event.kind==='PING'&&event.direction==='sent'&&Buffer.from(event.base64,'base64').toString()==='from server'));
  const key=frames.find(event=>event.direction==='sent'&&Buffer.from(event.base64,'base64').toString()==='text from Buffer').key;
  const other=frames.find(event=>event.direction==='sent'&&Buffer.from(event.base64,'base64').toString()==='second connection').key;assert.notEqual(key,other);
  for(const direction of ['sent','received']){
    const own=frames.filter(event=>event.key===key&&event.direction===direction);
    for(const [text,kind] of [['text from Buffer','TEXT'],['binary string','BINARY'],['fragment complete','TEXT']])assert.ok(own.some(event=>event.kind===kind&&Buffer.from(event.base64,'base64').toString()===text),direction+' '+text);
    assert.ok(own.some(event=>event.kind==='BINARY'&&event.base64==='B4A='));
    assert.ok(own.some(event=>event.size===80000&&event.truncated&&Buffer.from(event.base64,'base64').length===65536));
    assert.ok(own.some(event=>event.size===9*1024*1024&&event.truncated&&Buffer.from(event.base64,'base64').length===65536));
  }
  assert.ok(frames.some(event=>event.kind==='PING'&&event.direction==='sent'));
  assert.ok(frames.some(event=>event.kind==='PONG'&&event.direction==='received'));
  assert.ok(events.some(event=>event.type==='open'&&event.library==='ws'&&event.responseHeaders.some(([key])=>key.toLowerCase()==='sec-websocket-accept')));
  assert.equal(Object.hasOwn(first._sender,'send'),false,'closed socket must release sender wrappers');
  // Load an independent ws module only after installing the observer.
  const manualHttp=http.createServer(),manual=new WebSocketServer({noServer:true});let manualPeer;
  manual.on('headers',headers=>headers.push('X-Manual-Observer: after listeners'));
  manualHttp.on('upgrade',(req,socket,head)=>manual.handleUpgrade(req,socket,head,function(ws,request){'use strict';assert.equal(this,undefined);assert.equal(request,req);manualPeer=ws;ws.send('first manual server reply');ws.on('message',bytes=>ws.send('manual echo: '+bytes));}));
  await new Promise(resolve=>manualHttp.listen(0,'127.0.0.1',resolve));const manualUrl=`ws://127.0.0.1:${manualHttp.address().port}//devtools/page/fixture?raw=1`,manualClient=new Ws(manualUrl,'cdp');
  try{await new Promise((resolve,reject)=>{manualClient.on('error',reject);manualClient.on('open',()=>manualClient.send('command'));manualClient.on('message',bytes=>{if(bytes.toString()==='manual echo: command')manualClient.close(1000,'manual complete');});manualClient.on('close',resolve);});await delay(30);
    const opens=events.filter(event=>event.type==='open'&&event.role==='server'&&event.url===manualUrl);assert.equal(opens.length,1);const peer=opens[0];assert.ok(peer.responseHeaders.some(([key,value])=>key==='X-Manual-Observer'&&value==='after listeners'));assert.ok(peer.responseHeaders.some(([key,value])=>key==='Sec-WebSocket-Protocol'&&value==='cdp'));
    assert.ok(events.some(event=>event.key===peer.key&&event.type==='frame'&&event.direction==='sent'&&Buffer.from(event.base64,'base64').toString()==='first manual server reply'));assert.ok(events.some(event=>event.key===peer.key&&event.type==='frame'&&event.direction==='received'&&Buffer.from(event.base64,'base64').toString()==='command'));
  }finally{manualClient.terminate();manualPeer?.terminate();await new Promise(resolve=>manual.close(resolve));await new Promise(resolve=>manualHttp.close(resolve));}
  const project=fs.mkdtempSync(path.resolve('target/ws-library-lazy-'));fs.mkdirSync(path.join(project,'node_modules'),{recursive:true});
  const source=path.resolve('node_modules/ws'),copy=path.join(project,'node_modules/ws');fs.cpSync(source,copy,{recursive:true});
  const Lazy=require(copy);assert.notEqual(Lazy.prototype.emit,originalEmit);
  const lazy=new Lazy(url);await new Promise((resolve,reject)=>{lazy.on('error',reject);lazy.on('open',()=>lazy.send('lazy package'));lazy.on('message',()=>lazy.close());lazy.on('close',resolve);});
  await delay(30);assert.ok(events.some(event=>event.type==='frame'&&Buffer.from(event.base64,'base64').toString()==='lazy package'));
  const esmCopy=path.join(project,'esm/node_modules/ws');fs.cpSync(source,esmCopy,{recursive:true});
  const {default:Esm}=await import(require('node:url').pathToFileURL(path.join(esmCopy,'wrapper.mjs')).href);
  const esm=new Esm(url);esm.binaryType='blob';await new Promise((resolve,reject)=>{esm.on('error',reject);esm.on('open',()=>esm.send(Buffer.from([0,255])));esm.on('message',value=>{assert.ok(value instanceof Blob);esm.close();});esm.on('close',resolve);});
  await delay(20);assert.ok(events.some(event=>event.type==='frame'&&event.kind==='BINARY'&&event.direction==='received'&&event.base64==='AP8='));
  const fragments=new Lazy(url);fragments.binaryType='fragments';await new Promise((resolve,reject)=>{fragments.on('error',reject);fragments.on('open',()=>fragments.send('fragments-incoming'));fragments.on('message',value=>{assert.ok(Array.isArray(value));fragments.close();});fragments.on('close',resolve);});
  await delay(20);assert.ok(events.some(event=>event.type==='frame'&&event.kind==='BINARY'&&event.direction==='received'&&Buffer.from(event.base64,'base64').toString()==='fragmented response'));
  globalThis[slot].stop();assert.equal(Ws.prototype.emit,originalEmit);assert.equal(Lazy.prototype.emit,originalEmit);assert.equal(WebSocketServer.prototype.emit,originalServerEmit);assert.equal(WebSocketServer.prototype.handleUpgrade,originalUpgrade);assert.equal(FakeServer.prototype.handleUpgrade,fakeOriginal);assert.equal(globalThis[slot],undefined);
  // Clean up the class loaded through a hook, then prove the app still works.
  const count=events.length;const after=new Lazy(url);await new Promise((resolve,reject)=>{after.on('error',reject);after.on('open',()=>after.send('after detach'));after.on('message',()=>after.close());after.on('close',resolve);});assert.equal(events.length,count);
  assert.equal(install(60).available,true);
  const lease=new Ws(url);await new Promise(resolve=>lease.on('open',resolve));const sender=lease._sender;assert.equal(Object.hasOwn(sender,'send'),true);
  await delay(170);assert.equal(Ws.prototype.emit,originalEmit);assert.equal(WebSocketServer.prototype.emit,originalServerEmit);assert.equal(WebSocketServer.prototype.handleUpgrade,originalUpgrade);assert.equal(Object.hasOwn(sender,'send'),false);lease.close();
  assert.equal(install(60).available,true);
  const changed=new Ws(url);await new Promise(resolve=>changed.on('open',resolve));
  const observedEmit=Ws.prototype.emit,observedSend=changed._sender.send;
  const observedUpgrade=WebSocketServer.prototype.handleUpgrade,laterUpgrade=function(...args){return Reflect.apply(observedUpgrade,this,args);};WebSocketServer.prototype.handleUpgrade=laterUpgrade;
  const laterEmit=function(...args){return Reflect.apply(observedEmit,this,args);};
  const laterSend=function(...args){return Reflect.apply(observedSend,this,args);};
  Ws.prototype.emit=laterEmit;changed._sender.send=laterSend;
  await delay(170);assert.equal(Ws.prototype.emit,laterEmit);assert.equal(changed._sender.send,laterSend);
  assert.equal(WebSocketServer.prototype.handleUpgrade,laterUpgrade);WebSocketServer.prototype.handleUpgrade=originalUpgrade;
  delete Ws.prototype.emit;await new Promise((resolve,reject)=>{changed.on('error',reject);changed.on('message',()=>{changed.close();resolve();});changed.send('still works after method replacement');});
  for(const [limits,count] of [[{},129],[{records:64,bytes:1024*1024,pending:256},17]]){
  const checkpoint=events.length;assert.equal(install(20000,limits).available,true);
  const pending=[];
  for(let n=0;n<count;n++){
    const ws=new Ws(url);pending.push(ws);
    await new Promise((resolve,reject)=>{ws.on('error',reject);ws.on('open',()=>{ws.send(Buffer.alloc(65536,1),{fin:false});resolve();});});
  }
  for(let n=0;n<100&&!events.slice(checkpoint).some(event=>event.type==='warning'&&event.message.includes('лимит фрагментов'));n++)await delay(10);
  assert.ok(events.slice(checkpoint).some(event=>event.type==='warning'&&event.message.includes('лимит фрагментов')));
  assert.equal(Ws.prototype.emit,originalEmit,'fragment limit must release ws methods');
  let completed=0;
  for(const ws of pending){assert.equal(Object.hasOwn(ws._sender,'send'),false);ws.on('message',()=>{completed++;ws.close();});ws.send('end',{fin:true});}
  for(let n=0;n<100&&completed<pending.length;n++)await delay(20);
  assert.equal(completed,pending.length,'capture overflow must not interrupt fragmented application messages');
  globalThis[slot].stop();
  }
  console.log('PASS: client / server ws, manual noServer upgrade, callback receiver, first server sends, actual request / final response headers, text/binary/Blob, option getters/callbacks, fragments, compression, identical URLs, lazy modules, detach and lease expiry');
}
app.whenReady().then(run).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  clearTimeout(timeout);globalThis[slot]?.stop();for(const ws of wss?.clients||[])ws.terminate();if(wss)await new Promise(resolve=>wss.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));app.exit(process.exitCode||0);
});
