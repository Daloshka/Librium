const {WebSocket,WebSocketServer}=require('ws'),{HttpProxyAgent}=require('http-proxy-agent'),assert=require('node:assert/strict');
const http=require('node:http'),{once}=require('node:events');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=(path,token)=>new Promise((resolve,reject)=>http.get('http://127.0.0.1:3000'+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
(async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0,handleProtocols:offers=>offers.has('morphius-v1')&&'morphius-v1'});await once(server,'listening');
 const marker='librium-control-smoke='+Date.now();
 let serverPeer;const clientPings=[],clientPongs=[],serverPings=[],serverPongs=[],messages=[];
 const fromClient=Buffer.from([0,255,1]),fromServer=Buffer.from([128,0,2]);
 const unsolicitedClient=Buffer.from([3,0,254]),unsolicitedServer=Buffer.from([4,255,0]);
 const serverText=Buffer.from('Привет из сервера'),clientText=Buffer.from('Проверка фрагментов клиента');
 const binary=Buffer.concat([Buffer.alloc(40000,1),Buffer.alloc(40000,2)]);
 server.on('connection',peer=>{
  serverPeer=peer;peer.on('ping',bytes=>serverPings.push(Buffer.from(bytes)));peer.on('pong',bytes=>serverPongs.push(Buffer.from(bytes)));
  peer.on('message',(bytes,binary)=>peer.send(bytes,{binary}));
  peer.send(serverText.subarray(0,1),{binary:false,fin:false});peer.ping(fromServer);peer.send(serverText.subarray(1),{binary:false,fin:true});peer.pong(unsolicitedServer);
 });
 const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/?${marker}`,['other','morphius-v1'],{agent:new HttpProxyAgent('http://127.0.0.1:8080')});
 const timeout=setTimeout(()=>{client.terminate();serverPeer?.terminate();},10000);
 try{
  client.on('ping',bytes=>clientPings.push(Buffer.from(bytes)));client.on('pong',bytes=>clientPongs.push(Buffer.from(bytes)));
  client.on('message',(bytes,binary)=>messages.push({bytes:Buffer.from(bytes),binary}));
  await once(client,'open');assert.equal(client.protocol,'morphius-v1');
  client.send(clientText.subarray(0,1),{binary:false,fin:false});client.ping(fromClient);client.send(clientText.subarray(1),{binary:false,fin:true});client.pong(unsolicitedClient);
  client.send(binary.subarray(0,40000),{fin:false});client.send(binary.subarray(40000),{fin:true});
  for(let n=0;n<200&&(clientPongs.length<2||serverPongs.length<2||messages.length<3);n++)await pause(10);
  await pause(200);
  const sorted=values=>values.map(value=>value.toString('hex')).sort();
  assert.deepEqual(clientPings,[fromServer]);assert.deepEqual(serverPings,[fromClient]);
  assert.deepEqual(sorted(clientPongs),sorted([fromClient,unsolicitedServer]),'exact upstream PONGs');
  assert.deepEqual(sorted(serverPongs),sorted([fromServer,unsolicitedClient]),'exact client PONGs');
  assert.deepEqual(messages.filter(message=>!message.binary).map(message=>message.bytes.toString()),[serverText.toString(),clientText.toString()]);
  assert.deepEqual(messages.find(message=>message.binary).bytes,binary);
  const closed=once(client,'close');client.close(1000,'controls complete');await closed;
  const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
  const page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));
  const id=page.rows[0].id;let events;
  for(let n=0;n<100;n++){events=JSON.parse(await get('/api/traffic/'+id+'/ws',token));if(events.state==='closed')break;await pause(20);}
  assert.equal(events.state,'closed');assert.equal(events.error,null);assert.equal(events.total,13);
  for(const direction of ['sent','received']){
   const rows=events.messages.filter(message=>message.direction===direction);
   assert.equal(rows.filter(message=>message.kind==='PING').length,1);assert.equal(rows.filter(message=>message.kind==='PONG').length,2);
   const recorded=rows.find(message=>message.kind==='BINARY');assert.equal(recorded.size,80000);assert.equal(recorded.truncated,true);
   assert.deepEqual(Buffer.from(recorded.base64,'base64'),binary.subarray(0,65536));
   assert.equal(rows.filter(message=>message.kind==='CLOSE').length,1);
   assert.ok(rows.some(message=>message.kind==='TEXT'&&message.text===clientText.toString()));
  }
  assert.ok(events.messages.some(message=>message.direction==='received'&&message.text===serverText.toString()));
  for(const [direction,kind,payloads] of [['sent','PING',[fromClient]],['received','PING',[fromServer]],['sent','PONG',[fromServer,unsolicitedClient]],['received','PONG',[fromClient,unsolicitedServer]]]){
   assert.deepEqual(sorted(events.messages.filter(row=>row.direction===direction&&row.kind===kind).map(row=>Buffer.from(row.base64,'base64'))),sorted(payloads));
  }
  console.log('PASS: exact PING/PONG, unsolicited PONGs, subprotocol, split UTF-8, 80 KiB fragments, archived control bytes and bounded previews');
 }finally{clearTimeout(timeout);client.terminate();for(const peer of server.clients)peer.terminate();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
