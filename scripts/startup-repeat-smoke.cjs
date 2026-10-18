const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const http=require('node:http'),path=require('node:path'),fs=require('node:fs');
const {WebSocketServer}=require('ws');
const {CdpCapture}=require('../desktop/cdp.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,server,wss,capture;
const timeout=setTimeout(()=>{console.error('Repeated startup capture timed out');child?.kill();process.exit(1);},60000);
async function run(){
  const profile=fs.mkdtempSync(path.resolve('target/startup-repeat-'));
  server=http.createServer((_request,response)=>response.end('startup response'));
  wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',(bytes,binary)=>ws.send(bytes,{binary})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for(let n=0;n<12;n++){
    const paused=n%2===0;
    let errorLog='',serial=0;const events=[];
    child=spawn(require('electron'),[`--inspect${paused?'-brk':''}=127.0.0.1:19481`,'--experimental-network-inspection','scripts/startup-capture-fixture.cjs'],{
      windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,LIBRIUM_FIXTURE_ORIGIN:'http://127.0.0.1:'+server.address().port,LIBRIUM_FIXTURE_LIBRARY:'ws',LIBRIUM_FIXTURE_PROFILE:profile},
    });child.stderr.on('data',chunk=>{errorLog=(errorLog+chunk).slice(-1000);});
    capture=new CdpCapture({mode:'node',ingest:async event=>{events.push(event);return {id:++serial};}});
    for(let attempt=0;attempt<100;attempt++){
      try{await capture.connect(19481,'node',{startup:true});break;}
      catch(error){if(!error.message.includes('ECONNREFUSED'))throw error;await delay(20);}
    }
    for(let attempt=0;attempt<100;attempt++){
      if((await capture.command('Runtime.evaluate',{expression:'globalThis.startupComplete',returnByValue:true})).result?.value)break;
      await delay(20);
    }
    if(!paused){
      assert.equal(capture.status().startup,'unconfirmed');
      const origin='http://127.0.0.1:'+server.address().port;
      const result=await capture.command('Runtime.evaluate',{expression:`(async()=>{
        await (await fetch(${JSON.stringify(origin+'/late-http')})).text();
        await new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/late-ws')});ws.onopen=()=>{ws.send('late message');ws.send(new Uint8Array([0,255,17]));};let count=0;ws.onmessage=()=>{if(++count===2)ws.close();};ws.onclose=resolve;ws.onerror=reject;});
      })()`,awaitPromise:true,returnByValue:true});assert.equal(result.exceptionDetails,undefined);
    }
    await delay(30);await capture.queue;
    assert.ok(capture.status().messages>=4,JSON.stringify({iteration:n,state:capture.status(),errorLog}));
    assert.ok(events.some(event=>event.exchange?.summary.url.includes(paused?'/startup-http':'/late-http')));
    if(!paused)assert.equal(events.filter(event=>event.message?.text==='late message').length,2);
    await capture.disconnect();assert.equal(child.exitCode,null);
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});child=null;
    await delay(50);
  }
  console.log('PASS: 12 repeated startup / live-attach captures with one persistent profile, HTTP / WS messages and detach');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  clearTimeout(timeout);await capture?.disconnect().catch(()=>{});child?.kill();for(const ws of wss?.clients||[])ws.terminate();if(wss)await new Promise(resolve=>wss.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));
});
