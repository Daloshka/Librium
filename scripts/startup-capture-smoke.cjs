const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {WebSocketServer}=require('ws');
const {launchElectron}=require('../desktop/launch-target.cjs');
const {CaptureController}=require('../desktop/capture-controller.cjs');
const {CdpCapture}=require('../desktop/cdp.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,server,wss,capture,childError='';const requests=[];
const timeout=setTimeout(()=>{console.error('Startup capture timed out');child?.kill();process.exit(1);},45000);
async function run(){
  const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1];
  async function api(route,body){const response=await fetch('http://127.0.0.1:3000/api/'+route,{method:body?'POST':'GET',headers:{'x-librium-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(response.status!==200)throw Error('Synthetic capture API '+response.status+' '+await response.text());return response.json();}
  const ingest=event=>api('capture',event);
  server=http.createServer((request,response)=>{requests.push(request.url);response.end(request.url.startsWith('/startup-page')?'<!doctype html><title>Startup fixture</title>':'first response from server');});
  wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const spec={executable:require('electron'),args:[path.resolve('scripts/startup-capture-fixture.cjs')],cwd:process.cwd()};
  const marker='librium-startup-smoke='+Date.now();
  const launch=(port,options={},suffix='')=>launchElectron(spec,port,{...options,spawnProcess:(executable,args,opts)=>{
    childError='';child=spawn(executable,args,{...opts,stdio:['ignore','ignore','pipe'],env:{...process.env,LIBRIUM_FIXTURE_ORIGIN:origin,LIBRIUM_FIXTURE_MARKER:marker+suffix,LIBRIUM_FIXTURE_LIBRARY:suffix==='-ws-start'?'ws':'',LIBRIUM_FIXTURE_PROFILE:path.resolve(`target/startup-capture-profile-${Date.now()}-${port}`)}});child.stderr.on('data',chunk=>{childError=(childError+chunk).slice(-4000);});return child;
  }});
  const stop=()=>new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  capture=new CaptureController({ingest});
  const state=await capture.launchAndConnect(19465,{launch,captureStartup:true,label:'Startup fixture'});
  const main=capture.captures.node;assert.equal(state.sources.find(source=>source.mode==='node').startup,'captured',JSON.stringify(state));
  for(let n=0;n<100;n++){if((await main.command('Runtime.evaluate',{expression:'globalThis.startupComplete',returnByValue:true})).result?.value)break;await delay(20);}
  await delay(300);await main.queue;
  const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker})));
  const httpRow=page.rows.find(row=>new URL(row.url).pathname==='/startup-http');assert.ok(httpRow,'very first main-process fetch must be saved');assert.equal(httpRow.source,'cdp_node');
  assert.equal((await api('traffic/'+httpRow.id)).response.text,'first response from server');
  const sockets=page.rows.filter(row=>new URL(row.url).pathname==='/startup-ws');assert.equal(sockets.length,1);
  const frames=await api('traffic/'+sockets[0].id+'/ws');assert.equal(frames.state,'closed');assert.equal(frames.messages.length,4);
  for(const direction of ['sent','received']){
    assert.ok(frames.messages.some(message=>message.direction===direction&&message.text==='first message from main'));
    assert.ok(frames.messages.some(message=>message.direction===direction&&message.base64==='AP8R'));
  }
  await capture.disconnect();assert.equal(child.exitCode,null);await stop();capture=null;
  // Both failure during setup and a lost inspector transport must release the
  // application, including while the main module is still at its first line.
  for(const [port,transport] of [[19467,false],[19469,true]]){
    await launch(port,{captureStartup:true},'-failure-'+port);
    for(let n=0;n<100;n++){try{await fetch(`http://127.0.0.1:${port+1}/json/list`);break;}catch{await delay(20);}}
    const failed=new CdpCapture({ingest,mode:'node'});capture=failed;
    failed.installObserver=async()=>{if(transport)failed.socket.close();throw Error('Synthetic setup failure');};
    await assert.rejects(failed.connect(port+1,'node',{startup:true}));
    for(let n=0;n<150&&!requests.some(url=>url.includes('-failure-'+port));n++)await delay(20);
    assert.ok(requests.some(url=>url.includes('-failure-'+port)),'failed capture must not leave the application paused');
    await failed.disconnect();assert.equal(child.exitCode,null);await stop();capture=null;
  }
  await launch(19471,{captureStartup:false},'-unconfirmed');
  for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:19472/json/list');break;}catch{await delay(20);}}
  const unconfirmed=new CdpCapture({ingest,mode:'node'});capture=unconfirmed;
  await unconfirmed.connect(19472,'node',{startup:true});assert.equal(unconfirmed.status().startup,'unconfirmed');
  assert.match(unconfirmed.status().warning,/часть первых запросов/);assert.equal(child.exitCode,null);
  await unconfirmed.disconnect();await stop();capture=null;
  await launch(19473,{captureStartup:true},'-manual');
  for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:19474/json/list');break;}catch{await delay(20);}}
  const manual=new CdpCapture({ingest,mode:'node'});capture=manual;
  await manual.connect(19474,'node',{startup:true});assert.equal(manual.status().startup,'captured','manual inspect-brk must support the selected startup mode');
  for(let n=0;n<100;n++){if((await manual.command('Runtime.evaluate',{expression:'globalThis.startupComplete',returnByValue:true})).result?.value)break;await delay(20);}
  await delay(100);await manual.queue;assert.ok(manual.status().messages>=4);await manual.disconnect();await stop();capture=null;
  await launch(19475,{captureStartup:true},'-plain-connect');
  for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:19476/json/list');break;}catch{await delay(20);}}
  const plain=new CdpCapture({ingest,mode:'node'});capture=plain;
  await plain.connect(19476,'node');assert.equal(plain.status().startup,undefined);
  for(let n=0;n<100;n++){if((await plain.command('Runtime.evaluate',{expression:'globalThis.startupComplete',returnByValue:true})).result?.value)break;await delay(20);}
  assert.equal(child.exitCode,null);assert.ok(!childError.includes('testEnabled is not a function'));await plain.disconnect();await stop();capture=null;
  await launch(19477,{captureStartup:true},'-ws-start');
  for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:19478/json/list');break;}catch{await delay(20);}}
  const library=new CdpCapture({ingest,mode:'node'});capture=library;await library.connect(19478,'node',{startup:true});
  for(let n=0;n<100;n++){if((await library.command('Runtime.evaluate',{expression:'globalThis.startupComplete',returnByValue:true})).result?.value)break;await delay(20);}
  await delay(100);await library.queue;
  const libraryRows=await api('traffic-page?q='+encodeURIComponent(JSON.stringify({query:marker+'-ws-start'})));
  const librarySocket=libraryRows.rows.find(row=>row.url.startsWith('ws:'));assert.ok(librarySocket,'ws loaded at startup must be captured by the module hook');
  const firstLibraryFrames=await api('traffic/'+librarySocket.id+'/ws');assert.equal(firstLibraryFrames.messages.length,4);assert.equal(firstLibraryFrames.state,'closed');
  await library.disconnect();await stop();capture=null;
  console.log('PASS: first main-process HTTP and WS messages saved to SQLite, no duplicate handshake, automatic resume after setup failure and transport loss');
}
run().catch(async error=>{console.error(error);await delay(100);console.error(JSON.stringify({state:capture?.status(),exitCode:child?.exitCode,childError}));process.exitCode=1;}).finally(async()=>{
  clearTimeout(timeout);await capture?.disconnect().catch(()=>{});child?.kill();for(const ws of wss?.clients||[])ws.terminate();if(wss)await new Promise(resolve=>wss.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));
});
