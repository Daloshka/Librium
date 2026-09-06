const {WebSocket,WebSocketServer}=require('ws');
const {HttpProxyAgent}=require('http-proxy-agent');
const http=require('node:http'),fs=require('node:fs'),assert=require('node:assert/strict');
const get=(path,token)=>new Promise((resolve,reject)=>http.get('http://127.0.0.1:3000'+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
(async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 server.on('connection',socket=>{socket.send('server welcome');socket.on('message',(data,binary)=>socket.send(data,{binary}));});
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
  assert.equal(detail.summary.status,101);assert.equal(detail.summary.error,null);assert.equal(detail.request.complete,true);assert.equal(detail.response.complete,true);
  const events=JSON.parse(await get('/api/traffic/'+id+'/ws',token));
  for(const direction of ['sent','received']){assert.ok(events.messages.some(m=>m.direction===direction&&m.kind==='TEXT'&&m.text==='client hello'));assert.ok(events.messages.some(m=>m.direction===direction&&m.kind==='BINARY'&&m.base64==='AAH/Kg=='));}
  fs.writeFileSync('target/ws-test-id.txt',String(id));console.log({id,messages:events.total,state:events.state,handshakeError:detail.summary.error});
 }finally{for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
