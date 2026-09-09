// Needs the running core (LIBRIUM_UI_PORT / LIBRIUM_PROXY_PORT); writes one synthetic 2 MB exchange into its history.
// A slow 2 MB image through the proxy: while it streams the detail API must return only the preview, afterwards the whole body.
const http=require('node:http');const assert=require('node:assert/strict');
const UI_PORT=process.env.LIBRIUM_UI_PORT||3000,PROXY_PORT=process.env.LIBRIUM_PROXY_PORT||8080;
const get=(path,token)=>new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${UI_PORT}`+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
const TOTAL=2*1024*1024,CHUNK=64*1024;
const origin=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'image/png','content-length':TOTAL});let sent=0;const tick=()=>{if(sent>=TOTAL){res.end();return;}res.write(Buffer.alloc(CHUNK,7));sent+=CHUNK;setTimeout(tick,100);};tick();});
origin.listen(0,'127.0.0.1',async()=>{
  try{
    const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
    const marker='librium-stream-test='+Date.now();
    const url=`http://127.0.0.1:${origin.address().port}/slow.png?${marker}`;
    const done=new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:PROXY_PORT,path:url,headers:{host:`127.0.0.1:${origin.address().port}`}},r=>{let n=0;r.on('data',c=>n+=c.length);r.on('end',()=>resolve(n));}).on('error',reject));
    await new Promise(r=>setTimeout(r,1200));
    const page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));
    const id=page.rows[0].id;
    const mid=JSON.parse(await get('/api/traffic/'+id,token));
    assert.equal(mid.response.complete,false);assert.equal(mid.summary.finished,false);
    assert.ok(mid.response.size>CHUNK*5,'some of the body has arrived: '+mid.response.size);
    assert.equal(Buffer.from(mid.response.base64,'base64').length,65536,'mid-stream the API ships only the 64 KiB preview');
    const received=await done;assert.equal(received,TOTAL);
    let full;for(let i=0;i<30;i++){full=JSON.parse(await get('/api/traffic/'+id,token));if(full.response.complete)break;await new Promise(r=>setTimeout(r,200));}
    assert.equal(full.response.complete,true);assert.equal(full.summary.finished,true);assert.equal(full.response.truncated,false);
    assert.equal(Buffer.from(full.response.base64,'base64').length,TOTAL,'after the end the whole image is there');
    console.log(`Stream check OK: mid-stream preview 64 KiB at ${mid.response.size} bytes received, full ${TOTAL} bytes after completion`);
  }catch(e){console.error(e);process.exitCode=1;}finally{origin.closeAllConnections();origin.close();}
});
