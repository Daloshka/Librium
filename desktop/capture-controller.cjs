const {CdpCapture,launchMajestic,portNumber}=require('./cdp.cjs');
const labels={chromium:'Окна / workers',node:'Главный процесс / Node.js'};

class CaptureController {
  constructor({ingest,launch=launchMajestic,timeoutMs=12000}){
    this.captures={chromium:new CdpCapture({ingest}),node:new CdpCapture({ingest,mode:'node'})};
    this.launch=launch;this.timeoutMs=timeoutMs;
  }
  status(){
    const sources=Object.entries(this.captures).map(([mode,capture])=>({...capture.status(),label:labels[mode]}));
    return {connected:sources.some(s=>s.connected),targets:sources.reduce((n,s)=>n+s.targets,0),exchanges:sources.reduce((n,s)=>n+s.exchanges,0),messages:sources.reduce((n,s)=>n+s.messages,0),majesticInstalled:sources[0].majesticInstalled,
      error:sources.filter(s=>s.error).map(s=>`${s.label}: ${s.error}`).join(' · ')||null,
      warning:sources.filter(s=>s.warning).map(s=>`${s.label}: ${s.warning}`).join(' · ')||null,sources};
  }
  async connect(port,mode='chromium',{startup=false}={}){
    if(!Object.hasOwn(this.captures,mode))throw Error('Неизвестный источник захвата');
    if(typeof startup!=='boolean')throw Error('Неверный режим начала запуска');
    await this.captures[mode].connect(port,mode,{startup});return this.status();
  }
  async disconnect(){await Promise.all(Object.values(this.captures).map(c=>c.disconnect()));return this.status();}
  async launchAndConnect(port,{launch=this.launch,label='Majestic Launcher',captureStartup=false}={}){
    if(typeof captureStartup!=='boolean')throw Error('Неверный режим начала запуска');
    portNumber(port);portNumber(port+1);
    // Release our own debug connections before relaunching; never terminate the application.
    await this.disconnect();await launch(port,{captureStartup});
    const results=await Promise.allSettled(Object.entries(this.captures).map(async([mode,capture])=>{
      const value=mode==='node'?port+1:port,deadline=Date.now()+this.timeoutMs;
      while(true){
        try{return await capture.connect(value,mode,{startup:mode==='node'&&captureStartup});}catch(error){
          if(Date.now()>=deadline){capture.info.error=`Порт ${value} не подключился. ${error.message}`;throw error;}
        }
        await new Promise(r=>setTimeout(r,250));
      }
    }));
    if(results.every(r=>r.status==='rejected'))throw Error(`${label} не открыл отладочные порты. Полностью закрой приложение, включая значок в трее, и повтори запуск. Сборка должна поддерживать отладку Electron / Node.js.`);
    return this.status();
  }
}
module.exports={CaptureController};
