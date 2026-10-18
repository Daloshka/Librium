const {spawn}=require('node:child_process');
const http=require('node:http');
const {WebSocketServer}=require('ws');
const assert=require('node:assert/strict');
const path=require('node:path');
const {startStartupWatchdog,releaseStartup}=require('../desktop/startup-watchdog.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const watchdogExecutable=process.env.LIBRIUM_TEST_WATCHDOG_EXE||require('electron');
function target(port,origin){return spawn(require('electron'),[`--inspect-brk=127.0.0.1:${port}`,'scripts/startup-capture-fixture.cjs'],{
  detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,LIBRIUM_FIXTURE_ORIGIN:origin,LIBRIUM_FIXTURE_PROFILE:path.resolve(`target/watchdog-profile-${port}`)},
});}
if(process.argv[2]==='--owner'){
  (async()=>{
    const guard=await startStartupWatchdog({executable:watchdogExecutable,delayMs:400});
    const child=target(19462,process.argv[3]);guard.arm(child.pid,19462);child.unref();
    process.send({pid:child.pid});process.disconnect();process.exit(0);
  })().catch(()=>process.exit(1));
}else{
  let server,wss,child,owner,orphanPid;const received=[];
  const timeout=setTimeout(()=>{console.error('Startup watchdog timed out');child?.kill();if(orphanPid)process.kill(orphanPid);process.exit(1);},20000);
  (async()=>{
    server=http.createServer((request,response)=>{received.push(request.url);response.end('startup response');});
    wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
    child=target(19461,origin);
    for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:19461/json/list');break;}catch{await delay(20);}}
    assert.equal(await releaseStartup({pid:child.pid+1000000,port:19461}),false);
    await delay(100);assert.equal(received.length,0,'another PID must never be released');
    assert.equal(await releaseStartup({pid:child.pid,port:19461}),true);
    for(let n=0;n<100&&!received.some(url=>url.includes('/startup-http'));n++)await delay(20);
    assert.ok(received.some(url=>url.includes('/startup-http')));
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});child=null;received.length=0;
    owner=spawn(process.execPath,[__filename,'--owner',origin],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
    orphanPid=await new Promise((resolve,reject)=>{owner.once('message',message=>resolve(message.pid));owner.once('error',reject);});
    await new Promise(resolve=>owner.once('exit',resolve));assert.equal(owner.exitCode,0);
    for(let n=0;n<200&&!received.some(url=>url.includes('/startup-http'));n++)await delay(20);
    assert.ok(received.some(url=>url.includes('/startup-http')),'standalone watchdog must release startup after the owner exits');
    console.log('PASS: startup PID guard and independent Electron watchdog releases waiting application after owner exit');
  })().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    clearTimeout(timeout);child?.kill();owner?.kill();if(orphanPid)try{process.kill(orphanPid);}catch{}
    for(const ws of wss?.clients||[])ws.terminate();if(wss)await new Promise(resolve=>wss.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));
  });
}
