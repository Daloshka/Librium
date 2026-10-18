// Real Electron -> CDP -> authenticated Rust API -> SQLite integration.
const {app,BrowserWindow}=require('electron');
const {CdpCapture}=require('../desktop/cdp.cjs');
const {WebSocketServer}=require('ws');
const http=require('node:http');
const assert=require('node:assert/strict');
const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const profile=require('node:path').resolve('target/cdp-smoke-profile');require('node:fs').mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
app.commandLine.appendSwitch('remote-debugging-port','19333');
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
let window,server,wss,capture;
const timeout=setTimeout(()=>{console.error('CDP integration timed out');app.exit(1);},30000);
app.whenReady().then(async()=>{
  try{
    const html=await (await fetch('http://127.0.0.1:3000/')).text();const token=html.match(/const token\s*=\s*'([^']+)'/)[1];
    async function api(path,body){const res=await fetch('http://127.0.0.1:3000/api/'+path,{method:body?'POST':'GET',headers:{'x-librium-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!res.ok)throw Error('API '+res.status+' '+await res.text());return res.json();}
    capture=new CdpCapture({ingest:event=>api('capture',event)});
    const pendingResponses=new Map();
    server=http.createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{if(req.url.startsWith('/pending-')){res.writeHead(202,{'x-fixture-pending':'yes'});res.flushHeaders();pendingResponses.set(new URL(req.url,'http://localhost').pathname,res);return;}const bytes=Buffer.concat(chunks);res.setHeader('content-type','application/json');res.end(JSON.stringify({message:'cdp http body',received:bytes.length<100?bytes.toString('base64'):undefined,size:bytes.length,previewHash:hash(bytes.subarray(0,65536))}));});});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const pendingUpgrades=new Map();
    wss=new WebSocketServer({server,verifyClient:(info,accept)=>{const route=new URL(info.req.url,'http://localhost').pathname;if(route.startsWith('/pending-ws-'))pendingUpgrades.set(route.slice('/pending-ws-'.length),{accept,request:info.req});else accept(!info.req.url.includes('denied'));}});wss.on('connection',ws=>ws.on('message',(bytes,binary)=>ws.send(bytes,{binary})));
    const marker='librium-cdp-smoke='+Date.now(),origin='http://127.0.0.1:'+server.address().port;
    const wsUrl=phase=>origin.replace('http:','ws:')+'/pending-ws-'+phase+'?'+marker;
    async function startHandshake(target,phase,headers=true){
      await target.webContents.executeJavaScript(`window.pendingWsResult=new Promise(resolve=>{const socket=new WebSocket(${JSON.stringify(wsUrl(phase))});socket.onopen=()=>socket.send(${JSON.stringify('after capture '+phase)});socket.onmessage=event=>{resolve(event.data);socket.close();};socket.onerror=()=>resolve('error');socket.onclose=()=>resolve('closed');});void 0`);
      for(let n=0;n<100;n++){if((!headers||pendingUpgrades.has(phase))&&[...capture.handshakes.values()].some(row=>row.summary.url===wsUrl(phase)&&(!headers||row.request.complete)))return;await new Promise(resolve=>setTimeout(resolve,20));}
      throw Error('Pending WS request headers not observed: '+JSON.stringify({phase,serverPhases:[...pendingUpgrades.keys()],handshakes:[...capture.handshakes.values()].map(row=>({url:row.summary.url,headersObserved:row.request.complete})),status:capture.status()}));
    }
    async function checkHandshake(phase,headers=true){
      const rows=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:wsUrl(phase),traffic_type:'ws'})));assert.equal(rows.rows.length,1,phase);
      const detail=await api('traffic/'+rows.rows[0].id);assert.equal(detail.summary.status,null);assert.equal(detail.response.complete,false);assert.ok(detail.summary.error);assert.equal(detail.request.complete,headers);
      assert.equal((await api('traffic/'+rows.rows[0].id+'/ws')).state,'not_recorded','pending handshake must not create an established WS session');
      return detail;
    }
    window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await window.loadURL(origin);
    await capture.connect(19333);assert.equal(capture.status().connected,true);assert.ok(capture.status().targets>=1);
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const response=await fetch(${JSON.stringify(origin+'/?'+marker)});await response.text();
      await (await fetch(${JSON.stringify(origin+'/binary-post?'+marker)},{method:'POST',body:new Uint8Array([0,255,128,17,195,40])})).text();
      await (await fetch(${JSON.stringify(origin+'/blob-post?'+marker)},{method:'POST',body:new Blob([new Uint8Array([0,255,128,17,195,40])])})).text();
      await (await fetch(${JSON.stringify(origin+'/text-post?'+marker)},{method:'POST',body:'AP+AEcMo'})).text();
      await (await fetch(${JSON.stringify(origin+'/large-binary-post?'+marker)},{method:'POST',body:new Uint8Array(70000).fill(255)})).text();
      return new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/?'+marker)});let count=0;ws.binaryType='arraybuffer';ws.onopen=()=>{ws.send('42["custom-event",{"value":7}]');ws.send(new Uint8Array([0,1,255,42]));ws.send('x'.repeat(70000));ws.send('y'.repeat(9*1024*1024));};ws.onmessage=()=>{if(++count===4)ws.close(1000,'complete');};ws.onclose=()=>resolve(count);ws.onerror=()=>reject(Error('fixture WS failed'));});
    })()`);
    assert.equal(result,4);
    await new Promise(r=>setTimeout(r,300));await capture.queue;
    assert.equal(capture.status().error,null,JSON.stringify(capture.status()));
    const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})));
    const ws=page.rows.find(r=>r.status===101),request=page.rows.find(r=>r.status===200);assert.ok(ws);assert.ok(request);
    const messages=await api('traffic/'+ws.id+'/ws');
    for(const direction of ['sent','received']){
      assert.ok(messages.messages.some(m=>m.direction===direction&&m.text==='42["custom-event",{"value":7}]'));
      assert.ok(messages.messages.some(m=>m.direction===direction&&m.kind==='BINARY'&&m.base64==='AAH/Kg=='));
      assert.ok(messages.messages.some(m=>m.direction===direction&&m.size===70000&&m.truncated&&Buffer.from(m.base64,'base64').length===65536));
      assert.ok(messages.messages.some(m=>m.direction===direction&&m.size===9*1024*1024&&m.truncated&&Buffer.from(m.base64,'base64').length===65536));
    }
    assert.equal(messages.state,'closed');
    const detail=await api('traffic/'+request.id);assert.match(detail.response.text,/cdp http body/);
    assert.ok(detail.request.headers.some(([k])=>k==='x-librium-source'));
    for(const route of ['/binary-post','/blob-post']){
      const post=page.rows.find(row=>new URL(row.url).pathname===route);assert.ok(post,route);
      const saved=await api('traffic/'+post.id);const actual=JSON.parse(saved.response.text).received;
      assert.equal(actual,Buffer.from([0,255,128,17,195,40]).toString('base64'),'server must receive the original binary bytes');
      assert.equal(saved.request.base64,actual,route+' must preserve exact binary bytes');assert.equal(saved.request.complete,true,route);
    }
    for(const [route,expected] of [['/text-post',Buffer.from('AP+AEcMo')],['/large-binary-post',Buffer.alloc(70000,255)]]){
      const post=page.rows.find(row=>new URL(row.url).pathname===route);assert.ok(post,route);const saved=await api('traffic/'+post.id),actual=JSON.parse(saved.response.text);
      assert.equal(actual.size,expected.length);assert.equal(saved.request.size,actual.size,route);assert.equal(saved.request.complete,true,route);
      assert.equal(hash(Buffer.from(saved.request.base64,'base64')),actual.previewHash,route);assert.deepEqual(Buffer.from(saved.request.base64,'base64'),expected.subarray(0,65536));assert.equal(saved.request.truncated,expected.length>65536);
    }
    // Auto-attach must cover a dedicated worker as well as newly created windows.
    const workerCode=`const ws=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/?'+marker+'-worker')});ws.onopen=()=>ws.send('worker custom message');ws.onmessage=()=>ws.close();ws.onclose=()=>postMessage('done');`;
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}],{type:'text/javascript'}));const worker=new Worker(url);worker.onmessage=()=>{worker.terminate();URL.revokeObjectURL(url);resolve();};worker.onerror=reject;})`);
    const extra=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});await extra.loadURL(origin);
    await extra.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/?'+marker+'-window')});ws.onopen=()=>ws.send('new window message');ws.onmessage=()=>ws.close();ws.onclose=resolve;ws.onerror=reject;})`);
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const ws=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/?'+marker+'-denied')});ws.onerror=()=>resolve();ws.onclose=()=>resolve();})`);
    await new Promise(r=>setTimeout(r,300));await capture.queue;
    assert.equal(capture.status().error,null,JSON.stringify(capture.status()));
    for(const suffix of ['worker','window']){const rows=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-'+suffix})));assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].status,101);const events=await api('traffic/'+rows.rows[0].id+'/ws');assert.ok(events.messages.some(m=>m.text.includes(suffix==='worker'?'worker custom message':'new window message')));}
    const denied=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-denied'})));assert.equal(denied.rows.length,1);assert.notEqual(denied.rows[0].status,101);
    for(const [target,route]of [[window,'/pending-detach'],[extra,'/pending-window']]){
      const url=origin+route+'?'+marker;
      await target.webContents.executeJavaScript(`window.pendingResponse=fetch(${JSON.stringify(url)}).then(r=>r.text());void 0`);
      for(let n=0;n<100;n++){if([...capture.requests.values()].some(row=>row.request.url===url&&row.response))break;await new Promise(resolve=>setTimeout(resolve,20));}
      assert.ok([...capture.requests.values()].some(row=>row.request.url===url&&row.response),route+' headers must be observed');
    }
    await window.webContents.executeJavaScript(`window.liveSocket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/?'+marker+'-detach')});new Promise(r=>liveSocket.onopen=r)`);
    await startHandshake(window,'detach');await startHandshake(extra,'window',false);
    extra.destroy();
    for(let n=0;n<100;n++){await capture.queue;if(![...capture.requests.values()].some(row=>row.request.url.includes('/pending-window')))break;await new Promise(resolve=>setTimeout(resolve,20));}
    const closedWindow=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:origin+'/pending-window?'+marker})));assert.equal(closedWindow.rows.length,1);
    const closedDetail=await api('traffic/'+closedWindow.rows[0].id);assert.equal(closedDetail.response.complete,false);assert.ok(closedDetail.summary.error);
    assert.ok([...capture.requests.values()].some(row=>row.request.url.includes('/pending-detach')),'closing another target must not finish this window request');
    for(let n=0;n<100;n++){await capture.queue;if(![...capture.handshakes.values()].some(row=>row.summary.url===wsUrl('window')))break;await new Promise(resolve=>setTimeout(resolve,20));}
    await checkHandshake('window',false);assert.ok([...capture.handshakes.values()].some(row=>row.summary.url===wsUrl('detach')),'another target handshake must stay pending');pendingUpgrades.get('window')?.request.socket.destroy();
    // Detaching must close the recorded session, while the application socket stays usable.
    for(let n=0;n<50&&!capture.sockets.size;n++)await new Promise(r=>setTimeout(r,20));
    assert.ok(capture.sockets.size,'live session must be recorded before detach');await capture.queue;await capture.disconnect();
    const after=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-detach'})));
    assert.equal((await api('traffic/'+after.rows[0].id+'/ws')).state,'closed');
    assert.equal(await window.webContents.executeJavaScript('liveSocket.readyState'),1);
    const detachedHttp=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:origin+'/pending-detach?'+marker})));assert.equal(detachedHttp.rows.length,1);
    const detachedDetail=await api('traffic/'+detachedHttp.rows[0].id);assert.equal(detachedDetail.summary.status,202);assert.equal(detachedDetail.response.complete,false);assert.match(detachedDetail.summary.error,/Захват отключён/);
    pendingResponses.get('/pending-detach').end('response after capture stopped');assert.equal(await window.webContents.executeJavaScript('window.pendingResponse'),'response after capture stopped');
    const detachedWs=await checkHandshake('detach');assert.match(detachedWs.summary.error,/Захват отключён/);assert.ok(detachedWs.response.headers.some(([key,value])=>key==='x-librium-capture-note'&&value.includes('не наблюдается')));
    pendingUpgrades.get('detach').accept(true);assert.equal(await window.webContents.executeJavaScript('window.pendingWsResult'),'after capture detach');
    await window.webContents.executeJavaScript('liveSocket.close()');
    await capture.connect(19333);await startHandshake(window,'loss');const closed=new Promise(resolve=>capture.socket.addEventListener('close',resolve,{once:true}));capture.socket.close();await closed;await capture.queue;
    const lostWs=await checkHandshake('loss');assert.match(lostWs.summary.error,/Отладочное соединение/);pendingUpgrades.get('loss').accept(true);assert.equal(await window.webContents.executeJavaScript('window.pendingWsResult'),'after capture loss');await capture.disconnect();
    console.log('PASS: real CDP HTTP / WS, pending requests and handshakes on target close / detach / transport loss, no false WS sessions and unaffected application connections');
    clearTimeout(timeout);window.destroy();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));app.quit();
  }catch(e){console.error(e);clearTimeout(timeout);await capture?.disconnect().catch(()=>{});app.exit(1);}
});
