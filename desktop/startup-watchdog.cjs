const {spawn}=require('node:child_process');

// The standalone watchdog only releases our own, freshly spawned process. It
// never enables Debugger or resumes arbitrary breakpoints in a running app.
async function releaseStartup({pid,port}) {
  let socket;
  try {
    if(!Number.isInteger(pid)||pid<1||!Number.isInteger(port)||port<1024||port>65535)return false;
    const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)});
    const target=(await response.json()).find(entry=>entry.type==='node');
    if(!target)return false;
    const endpoint=new URL(target.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||Number(endpoint.port)!==port)return false;
    socket=new WebSocket(endpoint.href);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('timeout')),1500);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('connection'));},{once:true});
    });
    let serial=0;
    const command=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial;
      const listener=event=>{let value;try{value=JSON.parse(event.data);}catch{return;}if(value.id!==id)return;clearTimeout(timer);socket.removeEventListener('message',listener);value.error?reject(Error('protocol')):resolve(value.result);};
      const timer=setTimeout(()=>{socket.removeEventListener('message',listener);reject(Error('timeout'));},1500);
      socket.addEventListener('message',listener);socket.send(JSON.stringify({id,method,params}));
    });
    const identity=await command('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
    if(identity.result?.value!==pid){
      // Electron's pre-bootstrap process object may not have pid yet. Verify
      // the listening socket's OS owner instead of guessing from its URL.
      if(identity.result?.type!=='undefined'||process.platform!=='win32')return false;
      const executable=require('node:path').join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const script=`$ErrorActionPreference='Stop'; [Console]::Out.Write(((Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','))`;
      const owners=await new Promise((resolve,reject)=>require('node:child_process').execFile(executable,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:3000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout.trim().split(',').map(Number))));
      if(!owners.includes(pid))return false;
    }
    await command('Runtime.runIfWaitingForDebugger');return true;
  }catch{return false;}finally{if(socket?.readyState<2)socket.close();}
}

function watchdogMain(release) {
  let input='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{input+=chunk;if(input.length>4096)process.exit(1);});
  process.stdin.on('end',()=>{
    let value;try{value=JSON.parse(input);}catch{process.exit(1);}
    if(!Number.isInteger(value.pid)||value.pid<1||!Number.isInteger(value.port)||value.port<1024||value.port>65535||!Number.isInteger(value.delayMs)||value.delayMs<10||value.delayMs>30000)process.exit(1);
    setTimeout(async()=>{
      for(let attempt=0;attempt<10;attempt++){
        try{process.kill(value.pid,0);}catch{break;}
        if(await release(value))break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      setTimeout(()=>process.exit(0),100);
    },value.delayMs);
  });
  process.stdout.write('READY\n');
}
async function startStartupWatchdog({executable=process.execPath,delayMs=12000}={}) {
  const code=`(${watchdogMain.toString()})(${releaseStartup.toString()})`;
  const child=spawn(executable,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,windowsHide:true,stdio:['pipe','pipe','ignore'],shell:false});
  child.stdin.on('error',()=>{});
  try{
    await new Promise((resolve,reject)=>{
      let text='';
      const fail=()=>{clearTimeout(timer);reject(Error('Не удалось подготовить захват начала запуска. Попробуй отключить этот режим.'));};
      const timer=setTimeout(fail,3000);
      child.once('error',fail);child.once('exit',fail);
      child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('READY\n')){clearTimeout(timer);child.removeListener('exit',fail);resolve();}});
    });
  }catch(error){child.stdin.end();child.kill();throw error;}
  child.stdout.destroy();child.unref();
  return {
    arm(pid,port){
      child.once('exit',code=>{if(code!==0)void releaseStartup({pid,port});});
      child.stdin.end(JSON.stringify({pid,port,delayMs}));
    },
    cancel(){child.stdin.end();},
  };
}
module.exports={startStartupWatchdog,releaseStartup};
