const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const {join}=require('node:path');
const os=require('node:os');
const {Mobile,addresses,sameSubnet}=require('../desktop/mobile.cjs');
function dataDir(){
 if(process.env.LIBRIUM_DATA_DIR)return process.env.LIBRIUM_DATA_DIR;
 if(process.platform==='win32')return join(process.env.LOCALAPPDATA||os.homedir(),'Librium');
 if(process.platform==='darwin')return join(os.homedir(),'Library/Application Support/Librium');
 return join(process.env.XDG_DATA_HOME||join(os.homedir(),'.local/share'),'librium');
}
const filters=require('../ui/filters.js');
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
function get(host,port,path){return new Promise((resolve,reject)=>{http.get({host,port,path},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));}).on('error',reject);});}
(async()=>{
  assert.equal(sameSubnet('192.168.1.4','192.168.1.8','255.255.255.0'),true);
  assert.equal(sameSubnet('192.168.2.4','192.168.1.8','255.255.255.0'),false);
  assert.equal(filters.matches({url:'https://example.test/api',status:404},[{field:'host',op:'contains',value:'api'}]),false);
  assert.equal(filters.matches({url:'https://api.example.test/',status:404},[{field:'host',op:'contains',value:'API'},{field:'status',op:'gte',value:'400'}]),true);
  assert.equal(filters.matches({status:null},[{field:'status',op:'ne',value:'200'}]),false);
  assert.notEqual(filters.validate({field:'status',op:'gte',value:'oops'}),'');
  const adapter=addresses()[0];assert.ok(adapter,'A home-network adapter is required');
  const sockets=new Set();
  const core=http.createServer((req,res)=>{res.setHeader('x-test','streaming');req.pipe(res);});
  core.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  core.on('connect',(_req,socket,head)=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)socket.write(head);socket.pipe(socket);});
  const corePort=await listen(core);
  const mobile=new Mobile({getCertificate:async()=>fs.readFileSync(join(dataDir(),'ca.crt'),'utf8'),corePort,proxyPort:18080,certificatePort:18081});
  try{
    const status=await mobile.enable(adapter.address);assert.equal(status.enabled,true);
    const cert=await get(adapter.address,18081,new URL(status.url).pathname+'/ca.crt');assert.equal(cert.status,200);assert.equal(cert.body[0],0x30);assert.ok(!cert.body.includes('PRIVATE KEY'));
    assert.equal((await get(adapter.address,18081,'/api/traffic')).status,404);
    assert.equal((await get(adapter.address,18080,'http://127.0.0.1:3000/')).status,403);
    const body=Buffer.alloc(70000,0x61);
    await new Promise((resolve,reject)=>{const req=http.request({host:adapter.address,port:18080,path:'http://example.test/upload',method:'POST',headers:{'content-length':body.length}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{assert.deepEqual(Buffer.concat(chunks),body);resolve();}catch(e){reject(e);}});});req.on('error',reject);req.end(body);});
    await new Promise((resolve,reject)=>{const req=http.request({host:adapter.address,port:18080,path:'example.test:443',method:'CONNECT'});req.on('error',reject);req.on('connect',(_res,socket)=>{socket.setTimeout(3000,()=>{socket.destroy();reject(Error('Tunnel timeout'));});socket.once('data',data=>{try{assert.equal(data.toString(),'tunnel works');socket.destroy();resolve();}catch(e){reject(e);}});socket.write('tunnel works');});req.end();});
    assert.equal((await mobile.disable()).enabled,false);
    console.log('Mobile smoke OK: subnet, CA download, private routes blocked, streamed POST, CONNECT, cleanup; filters validated');
  }finally{await mobile.disable();for(const socket of sockets)socket.destroy();await new Promise(resolve=>core.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
