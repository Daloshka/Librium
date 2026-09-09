process.env.LIBRIUM_ATTACH_ONLY='1';
process.env.LIBRIUM_HEADLESS='1';
// Resend through the real renderer bridge: the replay must reach the origin with the captured headers
// and body, go through the proxy and land in the history as a new exchange.
const {app}=require('electron');
const http=require('node:http');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
const UI_PORT=process.env.LIBRIUM_UI_PORT||3000,PROXY_PORT=process.env.LIBRIUM_PROXY_PORT||8080;
const profile=resolve('target/replay-smoke-profile');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const get=(path,token)=>new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${UI_PORT}`+path,{headers:token?{'x-librium-token':token}:{}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>r.statusCode===200?resolve(s):reject(Error('HTTP '+r.statusCode)));}).on('error',reject));
const timer=setTimeout(()=>{console.error('FAIL: timed out');app.exit(1);},60000);
app.on('browser-window-created',(_e,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    const seen=[];
    const origin=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{seen.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()});res.writeHead(201,{'content-type':'application/json'});res.end('{"ok":true}');});});
    try{
      await new Promise(r=>origin.listen(0,'127.0.0.1',r));
      const marker='librium-replay-test='+Date.now();
      const url=`http://127.0.0.1:${origin.address().port}/items?${marker}`;
      await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:PROXY_PORT,path:url,method:'POST',headers:{host:`127.0.0.1:${origin.address().port}`,'content-type':'application/json','x-librium-check':'original','cookie':'session=abc'}},r=>{r.resume();r.on('end',resolve);});req.on('error',reject);req.end('{"name":"first"}');});
      const token=(await get('/')).match(/const token\s*=\s*'([^']+)'/)[1];
      let page;for(let i=0;i<30&&!(page&&page.rows.length);i++){page=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));if(!page.rows.length)await new Promise(r=>setTimeout(r,200));}
      const id=page.rows[0].id;
      const result=await window.webContents.executeJavaScript(`window.librium.replay(${id})`);
      assert.equal(result.status,201,JSON.stringify(result));
      assert.equal(seen.length,2,'the origin saw the original and the replay');
      assert.equal(seen[1].method,'POST');assert.equal(seen[1].url,seen[0].url);assert.equal(seen[1].body,'{"name":"first"}');
      assert.equal(seen[1].headers['x-librium-check'],'original');assert.equal(seen[1].headers['content-type'],'application/json');assert.equal(seen[1].headers.cookie,'session=abc','the captured cookie header travels with the replay');
      let after;for(let i=0;i<30;i++){after=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})),token));if(after.rows.length>=2)break;await new Promise(r=>setTimeout(r,200));}
      assert.equal(after.rows.length,2,'the replay is captured as its own exchange');assert.equal(after.rows[0].status,201);
      // Edited: another method, header and body reach the origin; the URL stays.
      const edited=await window.webContents.executeJavaScript(`window.librium.replay(${id},{method:'PUT',headers:[['content-type','text/plain'],['x-librium-check','edited']],body:'second body'})`);
      assert.equal(edited.status,201);assert.equal(seen.length,3);assert.equal(seen[2].method,'PUT');assert.equal(seen[2].body,'second body');assert.equal(seen[2].headers['x-librium-check'],'edited');assert.equal(seen[2].headers['content-type'],'text/plain');assert.equal(seen[2].headers.cookie,undefined,'headers not in the edit are not sent');
      let badHeader=false;try{await window.webContents.executeJavaScript(`window.librium.replay(${id},{headers:[['bad header','x']]})`);}catch{badHeader=true;}assert.ok(badHeader,'malformed header names are refused');
      let badUrl=false;try{await window.webContents.executeJavaScript(`window.librium.replay(${id},{url:'file:///etc/passwd'})`);}catch{badUrl=true;}assert.ok(badUrl,'only http(s) targets');
      // A refused id and a WebSocket exchange are rejected, not sent.
      let refused=false;try{await window.webContents.executeJavaScript(`window.librium.replay(0)`);}catch{refused=true;}assert.ok(refused,'id 0 without an edit is nothing to send');
      // Composed from scratch (id 0): method, URL, headers and body all come from the edit; it is captured too.
      const composedUrl=`http://127.0.0.1:${origin.address().port}/composed?${marker}`;
      const composed=await window.webContents.executeJavaScript(`window.librium.replay(0,{method:'POST',url:${JSON.stringify(composedUrl)},headers:[['content-type','text/plain'],['x-librium-check','composed']],body:'from scratch'})`);
      assert.equal(composed.status,201);assert.equal(seen.length,4);assert.equal(seen[3].method,'POST');assert.equal(seen[3].url,'/composed?'+marker);assert.equal(seen[3].body,'from scratch');assert.equal(seen[3].headers['x-librium-check'],'composed');
      let captured;for(let i=0;i<30;i++){captured=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:'/composed?'+marker})),token));if(captured.rows.length)break;await new Promise(r=>setTimeout(r,200));}
      assert.equal(captured.rows.length,1,'the composed request is captured');assert.equal(captured.rows[0].method,'POST');
      console.log('Replay smoke OK: a request composed from scratch reached the origin and the history');
      // HTTPS through the proxy: the replay session trusts the Librium CA even without the system store.
      const https=JSON.parse(await get('/api/traffic-page?q='+encodeURIComponent(JSON.stringify({query:'https://example.com/',method:'GET'})),token));
      if(https.rows.length){const secure=await window.webContents.executeJavaScript(`window.librium.replay(${https.rows[0].id})`);assert.equal(secure.status,200,JSON.stringify(secure));console.log('Replay smoke OK: HTTPS replay through the proxy trusted the Librium CA');}
      console.log('Replay smoke OK: POST resent with headers, cookie and body; captured as a new exchange');
      clearTimeout(timer);origin.close();app.quit();
    }catch(error){console.error('FAIL:',error.stack);clearTimeout(timer);origin.close();app.exit(1);}
  });
});
require('../desktop/main.cjs');
