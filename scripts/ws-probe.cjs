const {WebSocket,WebSocketServer}=require('ws');
const {HttpProxyAgent}=require('http-proxy-agent');
const http=require('node:http'),fs=require('node:fs'),assert=require('node:assert/strict');
const get=(path,token)=>new Promise((resolve,reject)=>http.get('http://127.0.0.1:3000'+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
(async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 const serverCloses=new Map();
 server.on('connection',(socket,request)=>{socket.on('close',(code,reason)=>serverCloses.set(request.url,{code,reason:reason.toString()}));socket.send('server welcome');if(request.url.startsWith('/server-close')){socket.close(4002,'server finished');return;}if(request.url.startsWith('/reset')){socket.terminate();return;}socket.on('message',(data,binary)=>socket.send(data,{binary}));});
 try{
  const marker='librium-ws-test='+Date.now();
  const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/?${marker}`,{agent:new HttpProxyAgent('http://127.0.0.1:8080')});
  await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{client.terminate();reject(Error('WebSocket test timed out'));},10000);
   let text=false,binary=false;
   client.on('error',reject);client.on('open',()=>{client.send('client hello');client.send(Buffer.from([0,1,255,42]));});
   client.on('message',(data,isBinary)=>{if(isBinary){assert.deepEqual(data,Buffer.from([0,1,255,42]));binary=true;}else if(data.toString()==='client hello')text=true;if(text&&binary)client.close(1000,'test complete');});
   client.on('close',()=>{clearTimeout(timeout);try{assert.ok(text&&binary);resolve();}catch(e){reject(e);}});
  });
  const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
  const page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));
  const id=page.rows[0].id,detail=JSON.parse(await get('/api/traffic/'+id,token));
  assert.equal(detail.summary.status,101);assert.equal(detail.summary.ws_role,'client');assert.equal(detail.summary.error,null);assert.equal(detail.request.complete,true);assert.equal(detail.response.complete,true);
  async function closedEvents(id){for(let n=0;n<100;n++){const page=JSON.parse(await get('/api/traffic/'+id+'/ws',token));if(page.state==='closed')return page;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Proxy did not finish closing the session');}
  const events=await closedEvents(id);assert.equal(events.error,null);
  assert.ok(events.messages.some(message=>message.kind==='CLOSE'&&message.direction==='received'),'client close must not cancel observation of the server close reply');
  assert.equal(events.close.code,1000);assert.equal(events.close.reason,'test complete');assert.equal(events.close.direction,'sent');
  for(const direction of ['sent','received']){assert.ok(events.messages.some(m=>m.direction===direction&&m.kind==='TEXT'&&m.text==='client hello'));assert.ok(events.messages.some(m=>m.direction===direction&&m.kind==='BINARY'&&m.base64==='AAH/Kg=='));}
  const remoteMarker='librium-ws-server-close='+Date.now();
  const remote=new WebSocket(`ws://127.0.0.1:${server.address().port}/server-close?${remoteMarker}`,{agent:new HttpProxyAgent('http://127.0.0.1:8080')});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{remote.terminate();reject(Error('Server close timed out'));},10000);remote.on('error',reject);remote.on('close',(code,reason)=>{clearTimeout(timer);try{assert.equal(code,4002);assert.equal(reason.toString(),'server finished');resolve();}catch(error){reject(error);}});});
  const remotePage=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:remoteMarker})),token));
  const remoteEvents=await closedEvents(remotePage.rows[0].id);assert.equal(remoteEvents.error,null);
  assert.ok(remoteEvents.messages.some(message=>message.kind==='CLOSE'&&message.direction==='sent'),'server close must not cancel observation of the client reply');
  assert.deepEqual(remoteEvents.close,{code:4002,reason:'server finished',direction:'received'});
  for(let n=0;n<100&&serverCloses.size<2;n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(serverCloses.get('/?'+marker),{code:1000,reason:'test complete'});
  assert.deepEqual(serverCloses.get('/server-close?'+remoteMarker),{code:4002,reason:'server finished'});
  const resetMarker='librium-ws-reset='+Date.now();
  const reset=new WebSocket(`ws://127.0.0.1:${server.address().port}/reset?${resetMarker}`,{agent:new HttpProxyAgent('http://127.0.0.1:8080')});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{reset.terminate();reject(Error('Reset test timed out'));},10000);reset.on('error',reject);reset.on('close',code=>{clearTimeout(timer);try{assert.equal(code,1006);resolve();}catch(error){reject(error);}});});
  const resetPage=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:resetMarker})),token));
  const resetEvents=await closedEvents(resetPage.rows[0].id);
  assert.ok(resetEvents.error,'transport reset must remain an error');assert.equal(resetEvents.close,null,'transport reset must not invent a remote close code');
  fs.writeFileSync('target/ws-test-id.txt',String(id));console.log({id,messages:events.total,state:events.state,handshakeError:detail.summary.error,remoteClose:remoteEvents.close.code});
 }finally{for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
