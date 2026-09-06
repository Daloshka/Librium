// End-to-end fixtures generated in target: capture through the running proxy,
// then verify exact media bytes in the persistent API before Electron decoding.
const http=require('node:http'),fs=require('node:fs'),assert=require('node:assert/strict');
const files={png:{file:'preview-test.png',mime:'image/png',path:'/fixtures/image.png'},ogg:{file:'audio-test.ogg',mime:'audio/ogg',path:'/fixtures/tone.ogg'},svg:{file:'svg-test.svg',mime:'image/svg+xml',path:'/preview.svg'}};
const get=(path,token)=>new Promise((resolve,reject)=>http.get('http://127.0.0.1:3000'+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
const server=http.createServer((req,res)=>{const kind=new URL(req.url,'http://local').searchParams.get('librium-media-test');const f=files[kind];if(!f){res.writeHead(404).end();return;}const body=fs.readFileSync('target/'+f.file);res.writeHead(200,{'content-type':f.mime,'content-length':body.length});res.end(body);});
server.listen(0,'127.0.0.1',async()=>{try{
  const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
  const info=JSON.parse(await get('/api/info',token));assert.ok(info.persistent_history);
  const ids={};
  for(const [kind,f] of Object.entries(files)){
    const body=fs.readFileSync('target/'+f.file);
    const url=`http://127.0.0.1:${server.address().port}${f.path}?librium-media-test=${kind}${kind==='png'?'&librium-image-test=1':''}`;
    await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:8080,path:url,headers:{host:`127.0.0.1:${server.address().port}`}},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{try{assert.deepEqual(Buffer.concat(chunks),body);resolve();}catch(e){reject(e);}});}).on('error',reject));
    const page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:`librium-media-test=${kind}`})),token));
    ids[kind]=page.rows[0].id;
    const detail=JSON.parse(await get('/api/traffic/'+ids[kind],token));
    assert.equal(detail.response.complete,true);assert.equal(detail.response.truncated,false);
    assert.deepEqual(Buffer.from(detail.response.base64,'base64'),body);
    console.log(kind,body.length,'bytes captured completely');
  }
  fs.writeFileSync('target/media-test-ids.json',JSON.stringify(ids));fs.writeFileSync('target/preview-test-id.txt',String(ids.png));
}catch(e){console.error(e);process.exitCode=1;}finally{server.closeAllConnections();server.close();}});
