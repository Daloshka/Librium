// Pushes many small WebSocket frames through the running proxy (LIBRIUM_UI_PORT / LIBRIUM_PROXY_PORT, N frames)
// and checks that every one of them reaches the history: the queued write path must not drop frames under load.
const {WebSocket,WebSocketServer}=require('ws');const {HttpProxyAgent}=require('http-proxy-agent');const http=require('node:http'),assert=require('node:assert/strict');
const UI_PORT=process.env.LIBRIUM_UI_PORT||3000,PROXY_PORT=process.env.LIBRIUM_PROXY_PORT||8080,N=Number(process.env.N||5000);
const get=(path,token)=>new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${UI_PORT}`+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
(async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 server.on('connection',socket=>{let got=0;socket.on('message',()=>{if(++got===N)socket.send('done');});});
 const marker='librium-ws-load='+Date.now();
 const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/?${marker}`,{agent:new HttpProxyAgent(`http://127.0.0.1:${PROXY_PORT}`)});
 const started=Date.now();
 await new Promise((resolve,reject)=>{client.on('error',reject);client.on('open',()=>{for(let i=0;i<N;i++)client.send('frame '+i);});client.on('message',data=>{if(data.toString()==='done'){client.close(1000,'ok');}});client.on('close',resolve);});
 const elapsed=Date.now()-started;
 await new Promise(r=>setTimeout(r,1200));
 const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
 const page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));
 const events=JSON.parse(await get('/api/traffic/'+page.rows[0].id+'/ws',token));
 assert.equal(events.total,N+1+1,'every frame plus the reply plus the close must be recorded');
 assert.equal(events.state,'closed');
 console.log(`WS load OK: ${N} frames round-tripped in ${elapsed} ms (${Math.round(N/elapsed*1000)} frames/s), ${events.total} messages stored`);
 for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));
})().catch(e=>{console.error(e);process.exitCode=1;});
