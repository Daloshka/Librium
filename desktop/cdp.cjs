const http = require('node:http');
const { existsSync } = require('node:fs');
const { join,dirname } = require('node:path');
const {launchElectron,portNumber} = require('./launch-target.cjs');
const {randomUUID} = require('node:crypto');
const {observeWebSockets} = require('./node-ws-observer.cjs');
const {observeWsLibraries} = require('./ws-library-observer.cjs');
const {observeHttpBodies} = require('./http-body-observer.cjs');
const {NodeWorkers}=require('./node-workers.cjs');

function localJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({host:'127.0.0.1',port,path}, res => {
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy(Error('Ответ отладочного порта слишком большой'));else chunks.push(chunk);});
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Отладочный порт: HTTP '+res.statusCode);resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
      res.on('error',reject);
    });
    req.setTimeout(2000,()=>req.destroy(Error('Отладочный порт не отвечает')));req.on('error',reject);
  });
}
function payload(headers={}, bytes=Buffer.alloc(0), size=bytes.length) {
  const preview=bytes.subarray(0,65536);
  return {headers:Object.entries(headers).map(([k,v])=>[k,String(v)]),text:preview.toString('utf8'),base64:preview.toString('base64'),size:Math.max(size,bytes.length),truncated:Math.max(size,bytes.length)>preview.length,complete:true};
}
function contentLength(headers={}){
  const value=Object.entries(headers).find(([key])=>key.toLowerCase()==='content-length')?.[1];
  const size=/^\d+$/.test(String(value))?Number(value):NaN;return Number.isSafeInteger(size)?size:null;
}
function requestEntries(entries){
  if(!Array.isArray(entries)||!entries.length)return null;
  const chunks=[];let size=0,retained=0,complete=true;
  for(const entry of entries){
    const encoded=entry?.bytes;
    if(typeof encoded!=='string'||encoded.length%4!==0||/[^A-Za-z0-9+/]/.test(encoded.replace(/={1,2}$/, ''))){complete=false;continue;}
    size+=Buffer.byteLength(encoded,'base64');
    // Keep a contiguous prefix only. Omitted file/blob entries create gaps.
    if(complete&&retained<65536){const bytes=Buffer.from(encoded.slice(0,Math.ceil((65536-retained)/3)*4),'base64').subarray(0,65536-retained);chunks.push(bytes);retained+=bytes.length;}
  }
  return {bytes:Buffer.concat(chunks),size,complete};
}
function majesticPath() {return join(process.env.LOCALAPPDATA||'', 'MajesticLauncher','Majestic Launcher.exe');}

class CdpCapture {
  constructor({ingest,mode='chromium',workerBudget,queueBudget,recordLimit=2000,onWarning}) {
    this.workers=null;this.workerBudget=workerBudget||{active:0};this.queueBudget=queueBudget||{bytes:0};this.recordLimit=recordLimit;this.onWarning=onWarning;
    this.ingest=ingest;this.socket=null;this.pending=new Map();this.serial=0;this.queue=Promise.resolve();this.queued=0;
    this.sessions=new Map();this.sockets=new Map();this.handshakes=new Map();this.requests=new Map();this.info={connected:false,port:null,mode,targets:0,exchanges:0,messages:0,error:null,warning:null};
    this.observer=null;this.nodePending=new Map();this.nodeCredits=[];this.stopping=false;
  }
  status(){const children=this.workers?.status()||{targets:0,exchanges:0,messages:0};return {...this.info,targets:this.info.targets+children.targets,exchanges:this.info.exchanges+children.exchanges,messages:this.info.messages+children.messages,error:[this.info.error,children.error].filter(Boolean).join(' · ')||null,warning:[this.info.warning,children.warning].filter(Boolean).join(' ')||null,majesticInstalled:existsSync(majesticPath())};}
  command(method,params={},sessionId) {
    if(this.socket?.readyState!==1)return Promise.reject(Error('Отладочное соединение закрыто'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP: нет ответа на '+method));},5000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  enqueue(event) {
    const size=Buffer.byteLength(JSON.stringify(event));
    if(!['Librium.closed','Librium.stopping'].includes(event.method)&&this.queueBudget.bytes+size>8*1024*1024){this.info.error='Захват остановлен: очередь превысила 8 МиБ';this.socket?.close();return;}
    this.queued+=size;this.queueBudget.bytes+=size;
    this.queue=this.queue.then(()=>this.event(event)).catch(error=>{this.info.error ||= error.message;this.socket?.close();}).finally(()=>{this.queued-=size;this.queueBudget.bytes-=size;});
  }
  bindSocket(ws){
    ws.addEventListener('message',event=>{
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.id){const p=this.pending.get(data.id);if(p){clearTimeout(p.timer);this.pending.delete(data.id);data.error?p.reject(Error(data.error.message)):p.resolve(data.result);}return;}
      if(this.workers?.route(data))return;
      if(data.method==='Debugger.paused'&&this.workerEntryPause){this.workerEntryPause(data.params);return;}
      if(data.method==='Debugger.paused'&&this.startupPause){this.startupPause(data.params?.reason==='Break on start');return;}
      if(data.method?.startsWith('Debugger.'))return;
      if(data.method==='Runtime.bindingCalled'){
        if(data.params?.name===this.workers?.binding){try{this.workers.route(JSON.parse(data.params.payload));}catch{}return;}
        if(data.params?.name===this.observer?.binding){
          try{this.enqueue({method:'Librium.nodeWs',params:JSON.parse(data.params.payload)});}catch{}
        }
        return;
      }
      if(data.method?.startsWith('Runtime.'))return;
      if(['Network.webSocketFrameSent','Network.webSocketFrameReceived'].includes(data.method)&&typeof data.params?.response?.payloadData==='string'){
        const frame=data.params.response,bytes=Buffer.from(frame.payloadData,frame.opcode===1?'utf8':'base64');
        frame.dataSize=bytes.length;frame.previewBase64=bytes.subarray(0,65536).toString('base64');frame.payloadData='';
      }
      data.receivedAt=Date.now();this.enqueue(data);
    });
    ws.addEventListener('error',()=>{this.info.error='Ошибка подключения к отладочному порту';});
    ws.addEventListener('close',()=>{
      clearInterval(this.targetTimer);
      this.startupPause?.(false);this.workerEntryPause?.(null);
      this.info.connected=false;
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Отладочное соединение закрыто'));}this.pending.clear();
      this.enqueue({method:'Librium.closed'});
    });
  }
  async connect(port,mode=this.info.mode,{startup=false}={}) {
    portNumber(port);if(!['chromium','node'].includes(mode))throw Error('Неизвестный источник захвата');await this.disconnect();this.stopping=false;this.workers=null;
    const discovery=await localJson(port,mode==='node'?'/json/list':'/json/version');
    const version=mode==='node'?discovery.find?.(target=>target.type==='node'):discovery;
    if(!version?.webSocketDebuggerUrl)throw Error(mode==='node'?'На этом порту нет отладчика Node.js. Проверь источник и параметр --inspect.':'На этом порту нет отладчика Chromium. Проверь источник и параметр --remote-debugging-port.');
    const endpoint=new URL(version.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||Number(endpoint.port)!==port)throw Error('Ожидался локальный отладочный WebSocket');
    const ws=new WebSocket(endpoint.href);this.socket=ws;
    this.info={connected:false,port,mode,targets:0,exchanges:0,messages:0,error:null,warning:null};
    this.bindSocket(ws);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('Отладочный порт не подключился'));},5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Не удалось подключиться к CDP'));},{once:true});});
    this.info.connected=true;
    try{
      if(mode==='node'){
        this.sessions.set('',{title:'Node.js / Electron main process',type:'node'});this.info.targets=1;
        await this.prepareNode(startup);
      }else{await this.command('Target.setDiscoverTargets',{discover:true});await this.command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});this.refreshTargetTitles();}
      await this.workers?.settle();await this.queue;
    }
    catch(e){await this.disconnect();throw e;}
    return this.status();
  }
  async disconnect() {
    clearInterval(this.targetTimer);
    this.enqueue({method:'Librium.stopping'});await this.queue;
    await this.workers?.stop();
    await this.removeObserver();
    await this.releaseStartupPause();
    if(this.socket){const ws=this.socket;this.socket=null;if(ws.readyState<2){await new Promise(resolve=>{const timer=setTimeout(resolve,1000);ws.addEventListener('close',()=>{clearTimeout(timer);resolve();},{once:true});ws.close();});}}
    await this.queue;await this.flushNativeSockets();await this.endSockets('Захват отключён');this.sessions.clear();this.handshakes.clear();this.requests.clear();this.info.connected=false;this.info.targets=0;
    return this.status();
  }
  async enableWorkers(){
    if(this.info.mode!=='node'||this.workers||this.recordLimit!==2000)return;
    this.workers=new NodeWorkers(this,options=>new CdpCapture(options));await this.workers.enable();
  }
  async connectWorker(socket,{port,title,entryUrl,waiting}){
    this.socket=socket;this.info={connected:true,port,mode:'node',targets:1,exchanges:0,messages:0,error:null,warning:null};this.sessions.set('',{title,type:'node_worker'});this.bindSocket(socket);
    if(!waiting){await this.prepareNode(false);await this.workers?.settle();await this.queue;return;}
    let breakpoint,timer,enabled=false;
    try{
      let resolvePause;const pause=new Promise(resolve=>{resolvePause=resolve;});
      this.workerEntryPause=params=>{if(params?.reason==='Break on start'||params?.hitBreakpoints?.includes(breakpoint))resolvePause(true);else if(!params)resolvePause(false);};
      await this.command('Debugger.enable');enabled=true;
      const url=typeof entryUrl==='string'&&entryUrl&&entryUrl.length<=4096?entryUrl:'[worker eval]';
      breakpoint=(await this.command('Debugger.setBreakpointByUrl',{url,lineNumber:0})).breakpointId;
      await this.command('Runtime.runIfWaitingForDebugger');
      const confirmed=await Promise.race([pause,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);
      this.info.startup=confirmed?'entry':'unconfirmed';
      if(!confirmed){await this.command('Debugger.removeBreakpoint',{breakpointId:breakpoint}).catch(()=>{});breakpoint=null;await this.command('Debugger.disable').catch(()=>{});enabled=false;await this.waitForNodeTurn();}
      await this.command('Network.enable',{maxTotalBufferSize:8*1024*1024,maxResourceBufferSize:1024*1024,maxPostDataSize:65536});
      await this.installObserver();await this.enableWorkers();
      if(!confirmed)this.info.warning+=' Начало выполнения worker не подтверждено; ранние запросы могут отсутствовать.';
    }finally{
      clearTimeout(timer);this.workerEntryPause=null;
      if(breakpoint)await this.command('Debugger.removeBreakpoint',{breakpointId:breakpoint}).catch(()=>{});
      await this.command('Runtime.runIfWaitingForDebugger').catch(()=>{});
      if(enabled)await this.command('Debugger.disable').catch(()=>{});
    }
    await this.workers?.settle();await this.queue;
  }
  async prepareNode(startup){
    let pauseTimer;
    try{
      let pause,confirmed=false;
      if(startup){
        this.startupHeld=true;
        pause=new Promise(resolve=>{this.startupPause=resolve;});
        await this.command('Debugger.enable');
      }
      if(startup){
        await this.command('Runtime.runIfWaitingForDebugger');
        confirmed=await Promise.race([pause,new Promise(resolve=>{pauseTimer=setTimeout(()=>resolve(false),2500);})]);
        this.info.startup=confirmed?'captured':'unconfirmed';
      }
      if(!confirmed){
        await this.releaseStartupPause();
        await this.command('Runtime.runIfWaitingForDebugger');
        await this.waitForNodeTurn();
      }
      // Network.enable synchronously loads Node inspector dependencies. Calling
      // it while bootstrap / another builtin load is interrupted can abort Node.
      // At an entry pause none of the application code has run; otherwise first
      // warm those dependencies on the target's normal event loop.
      await this.command('Network.enable',{maxTotalBufferSize:8*1024*1024,maxResourceBufferSize:1024*1024,maxPostDataSize:65536});
      await this.installObserver();await this.enableWorkers();
      if(startup&&this.info.startup!=='captured')this.info.warning+=' Начало запуска не подтверждено: часть первых запросов могла уйти до подключения.';
    }finally{
      clearTimeout(pauseTimer);this.startupPause=null;
      await this.command('Runtime.runIfWaitingForDebugger').catch(()=>{});
      await this.releaseStartupPause();
    }
  }
  async waitForNodeTurn(){
    const expression=`(() => {
      if(typeof setImmediate!=='function'||typeof process?.getBuiltinModule!=='function')return false;
      return new Promise(resolve=>process.getBuiltinModule('timers').setImmediate(()=>{
        try{for(const name of ['inspector','stream','http','https','diagnostics_channel','buffer','events'])process.getBuiltinModule(name);resolve(true);}
        catch{resolve(false);}
      }));
    })()`;
    for(let attempt=0;attempt<100;attempt++){
      const value=await this.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(value.result?.value===true)return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw Error('Главный процесс Node.js ещё не готов к сетевому захвату');
  }
  async releaseStartupPause(){
    if(!this.startupHeld)return;this.startupHeld=false;
    await this.command('Runtime.runIfWaitingForDebugger').catch(()=>{});
    // Disabling our Debugger agent also resumes its startup pause. Resuming
    // first lets application/module code race with a still-enabled debugger.
    await this.command('Debugger.disable').catch(()=>this.command('Debugger.resume').catch(()=>{}));
  }
  async installObserver(){
    const suffix=randomUUID().replaceAll('-','');
    const observer={binding:'libriumWs'+suffix,slot:'__libriumWs'+suffix,timer:null};this.observer=observer;
    try{
      await this.command('Runtime.enable');await this.command('Runtime.addBinding',{name:observer.binding});
      const value=await this.command('Runtime.evaluate',{expression:`(${observeWebSockets.toString()})(${JSON.stringify(observer.binding)},${JSON.stringify(observer.slot)},5000,(${observeWsLibraries.toString()}),(${observeHttpBodies.toString()}),${JSON.stringify(this.recordLimit===2000?{}:{records:64,bytes:1024*1024,pending:256})})`,returnByValue:true});
      if(value.result?.value?.bootstrap){
        await this.removeObserver();this.info.warning='Главный процесс ещё запускается; содержимое первых WS-сообщений может быть недоступно. Для захвата с начала включи соответствующий режим.';return 'bootstrap';
      }
      if(value.exceptionDetails||!value.result?.value?.available)throw Error('unavailable');
      observer.active=true;
      observer.timer=setInterval(()=>{
        if(observer.renewing)return;observer.renewing=true;
        this.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(observer.slot)}]?.renew()`})
          .catch(()=>{}).finally(()=>{observer.renewing=false;});
      },1000);observer.timer.unref?.();
      this.info.warning='Временный наблюдатель записывает встроенный WebSocket Node.js, клиенты и новые серверные соединения отдельных модулей ws. Это сообщения приложения, не сырые кадры. Встроенные в bundle библиотеки и нативные сокеты могут быть недоступны.';
      if(!value.result.value.wsLibrary?.available)this.info.warning='Встроенный WebSocket Node.js записывается. Наблюдатель библиотеки ws недоступен в этом runtime.';
      else if(!value.result.value.wsLibrary.lazy)this.info.warning+=' Для модулей ws, загруженных позже, потребуется повторное подключение.';
      return 'active';
    }catch{
      await this.removeObserver();
      this.info.warning='Наблюдатель WebSocket недоступен в этой версии Node.js; инспектор сохраняет только поддерживаемые сетевые события.';
      return 'unavailable';
    }
  }
  async removeObserver(){
    const observer=this.observer;if(!observer)return;clearInterval(observer.timer);
    if(this.socket?.readyState===1){
      await this.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(observer.slot)}]?.stop();delete globalThis[${JSON.stringify(observer.binding)}]`}).catch(()=>{});
      await this.command('Runtime.removeBinding',{name:observer.binding}).catch(()=>{});
    }
    this.observer=null;
  }
  async flushNativeSocket(key){
    const row=this.nodePending.get(key);if(!row)return;clearTimeout(row.timer);this.nodePending.delete(key);
    const {id}=await this.saveExchange(row.exchange,true);this.info.exchanges++;
    if(row.ended)await this.ingest({event:'end',id,error:row.error||null});else this.sockets.set(key,id);
  }
  async flushNativeSockets(){for(const key of this.nodePending.keys())await this.flushNativeSocket(key);this.nodeCredits=[];}
  async nodeWs(p){
    if(p.type==='warning'){this.info.warning=p.message;this.onWarning?.(p.message);return;}
    const key='observer:'+p.key;
    if(p.type==='open'){
      if(this.controlUrl(p.url))return;
      // URL counts suppress duplicate metadata only. Message identity always
      // comes from the actual WebSocket instance, never from its URL.
      if(p.library!=='ws'){
        const native=[...this.nodePending].find(([,row])=>row.exchange.summary.url===p.url);
        if(native){clearTimeout(native[1].timer);this.nodePending.delete(native[0]);}
        else {this.nodeCredits.push({url:p.url,time:Date.now()});if(this.nodeCredits.length>this.recordLimit)this.nodeCredits.shift();}
      }
      const row={summary:{id:0,time:p.time,method:'GET',url:p.url,status:p.status,ws_role:p.role==='server'?'server':'client',elapsed_ms:0,size:0,error:null},
        request:payload({'upgrade':'websocket','x-librium-target':this.targetLabel(),
          'x-librium-ws-role':p.role==='server'?'server':'client',
          'x-librium-capture-note':p.role==='server'?'Временный наблюдатель сервера ws: отправлено / получено относительно приложения. Заголовки получены при принятии соединения.':`Временный наблюдатель ${p.library==='ws'?'библиотеки ws':'Node.js'}: сообщения приложения; заголовки запроса рукопожатия недоступны.${p.partial?' Начало соединения не наблюдалось; запись началась с текущего сообщения.':''}`}),response:payload(p.headers)};
      if(p.role==='server'&&Array.isArray(p.requestHeaders))row.request.headers=[...row.request.headers,...p.requestHeaders];
      if(Array.isArray(p.responseHeaders))row.response.headers=p.responseHeaders;
      const {id}=await this.saveExchange(row,true);this.sockets.set(key,id);this.info.exchanges++;return;
    }
    const id=this.sockets.get(key);if(!id)return;
    if(p.type==='frame'){
      const preview=Buffer.from(p.base64,'base64');
      await this.ingest({event:'message',id,message:{time:p.time,direction:p.direction,kind:p.kind,
        text:p.kind==='TEXT'?preview.toString('utf8'):'',base64:p.base64,size:p.size,truncated:p.truncated}});this.info.messages++;
    }else if(p.type==='close'||p.type==='end'){
      const close=Number.isInteger(p.code)&&p.code>=0&&p.code<=65535?{code:p.code,reason:typeof p.reason==='string'?p.reason:''}:null;
      await this.ingest({event:'end',id,close,error:p.error||(p.code===1006?'WebSocket закрылся без подтверждённого close-кадра':null)});this.sockets.delete(key);
    }
  }
  async endSockets(error, session) {
    for(const [key,id]of this.sockets){if(session&&!key.startsWith(session+':'))continue;try{await this.ingest({event:'end',id,error});}catch(e){this.info.error=e.message;}this.sockets.delete(key);}
  }
  async endRequests(reason,session,unavailable=false){
    for(const key of [...this.requests.keys()]){
      const source=key.slice(0,key.indexOf(':'));if(session!==undefined&&source!==session)continue;
      await this.finishHttp(key,{errorText:reason,captureEnded:true,targetUnavailable:unavailable},source);
    }
  }
  async finishHandshake(key,reason,observationEnded=false){
    const row=this.handshakes.get(key);if(!row)return;this.handshakes.delete(key);
    row.summary.error=reason;row.summary.elapsed_ms=Math.max(0,Date.now()-row.summary.time);row.response.complete=false;
    row.response.headers.push(['x-librium-capture-note',observationEnded?reason+'; результат соединения после отключения не наблюдается; длительность отражает время наблюдения':reason]);
    await this.saveExchange(row,false);this.info.exchanges++;
  }
  async endHandshakes(reason,session){
    for(const key of [...this.handshakes.keys()]){
      if(session!==undefined&&key.slice(0,key.indexOf(':'))!==session)continue;
      await this.finishHandshake(key,reason,true);
    }
  }
  async event({method,params:p={},sessionId:s='',receivedAt=Date.now()}) {
    if(method==='Librium.stopping'){this.stopping=true;await this.endRequests('Захват отключён до завершения HTTP-запроса');await this.endHandshakes('Захват отключён до ответа на рукопожатие WebSocket');return;}
    if(method==='Librium.closed'){await this.workers?.stop(true);if(this.observer)clearInterval(this.observer.timer);this.observer=null;await this.endRequests('Отладочное соединение закрыто до завершения HTTP-запроса',undefined,true);await this.endHandshakes('Отладочное соединение закрыто до ответа на рукопожатие WebSocket');await this.flushNativeSockets();await this.endSockets('Приложение закрыло отладочное соединение');this.sessions.clear();this.info.targets=0;return;}
    if(this.stopping&&method.startsWith('Network.'))return;
    if(method==='Librium.nodeWs'){await this.nodeWs(p);return;}
    if(method==='Librium.nativeWs'){await this.flushNativeSocket(p.key);return;}
    if(method==='Target.attachedToTarget'){
      const id=p.sessionId;this.sessions.set(id,{...p.targetInfo,captureContext:randomUUID()});this.info.targets=this.sessions.size;
      if(!['page','iframe','webview','worker','service_worker','shared_worker'].includes(p.targetInfo.type)){await this.command('Runtime.runIfWaitingForDebugger',{},id).catch(()=>{});return;}
      // A paused worker may not answer Network.enable until its runtime resumes.
      // Send enable first, but never wait for that answer before sending resume.
      const enable=this.command('Network.enable',{maxTotalBufferSize:8*1024*1024,maxResourceBufferSize:1024*1024,maxPostDataSize:65536},id);
      const nested=this.command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},id).catch(()=>{});
      const resume=this.command('Runtime.runIfWaitingForDebugger',{},id).catch(()=>{});
      await Promise.all([enable,nested,resume]);
      return;
    }
    if(method==='Target.targetInfoChanged'){this.updateTargetTitles([p.targetInfo]);return;}
    if(method==='Librium.targetInfos'){this.updateTargetTitles(p.targetInfos);return;}
    if(method==='Target.detachedFromTarget'){
      await this.endRequests('Окно или worker закрыты до завершения HTTP-запроса',p.sessionId,true);
      await this.endHandshakes('Окно или worker закрыты до ответа на рукопожатие WebSocket',p.sessionId);
      await this.endSockets('Окно приложения закрыто',p.sessionId);this.sessions.delete(p.sessionId);this.info.targets=this.sessions.size;
      for(const map of [this.requests,this.handshakes])for(const key of map.keys())if(key.startsWith(p.sessionId+':'))map.delete(key);return;
    }
    const key=s+':'+p.requestId;
    if(method==='Network.webSocketCreated') {
      if(this.controlUrl(p.url))return;
      if(this.handshakes.size>=this.recordLimit){this.info.error='Достигнут лимит ожидающих WebSocket';return;}
      const request=payload({'upgrade':'websocket','x-librium-target':this.targetLabel(s),'x-librium-capture-note':'Известен адрес WebSocket; отправка и заголовки рукопожатия не подтверждены'});request.complete=false;
      this.handshakes.set(key,{summary:{id:0,capture_target:this.targetLabel(s),capture_context:this.targetContext(s),time:receivedAt,method:'GET',url:p.url,status:null,ws_role:'client',elapsed_ms:0,size:0,error:null},request,response:payload()});return;
    }
    if(method==='Network.webSocketWillSendHandshakeRequest') {
      const row=this.handshakes.get(key);if(row){row.request=payload(p.request.headers);row.request.headers.push(['x-librium-target',row.summary.capture_target]);}return;
    }
    if(method==='Network.webSocketHandshakeResponseReceived') {
      const row=this.handshakes.get(key);if(!row)return;this.handshakes.delete(key);
      row.summary.status=p.response.status;row.summary.elapsed_ms=Math.max(0,receivedAt-row.summary.time);row.response=payload(p.response.headers);
      if(this.info.mode==='node'&&p.response.status===101){
        const note='Отладчик Node.js предоставляет рукопожатие и состояние WebSocket, но не содержимое сообщений. Для сообщений используй захват окон или прокси.';
        row.request.headers.push(['x-librium-capture-note',note]);
        if(!this.observer?.active)this.info.warning=note;
        if(this.observer?.active){
          this.nodeCredits=this.nodeCredits.filter(credit=>Date.now()-credit.time<5000);
          const credit=this.nodeCredits.findIndex(credit=>credit.url===row.summary.url);
          if(credit>=0){this.nodeCredits.splice(credit,1);return;}
          if(this.nodePending.size>=this.recordLimit)await this.flushNativeSocket(this.nodePending.keys().next().value);
          const timer=setTimeout(()=>this.enqueue({method:'Librium.nativeWs',params:{key}}),250);timer.unref?.();
          this.nodePending.set(key,{exchange:row,timer});return;
        }
      }
      const {id}=await this.saveExchange(row,p.response.status===101);
      if(p.response.status===101)this.sockets.set(key,id);this.info.exchanges++;return;
    }
    if(method==='Network.webSocketFrameSent'||method==='Network.webSocketFrameReceived') {
      const id=this.sockets.get(key);if(!id)return;
      const frame=p.response,bytes=Buffer.from(frame.previewBase64??frame.payloadData,frame.previewBase64!==undefined?'base64':frame.opcode===1?'utf8':'base64'),preview=bytes.subarray(0,65536),size=frame.dataSize??bytes.length;
      const kind=({0:'CONTINUATION',1:'TEXT',2:'BINARY',8:'CLOSE',9:'PING',10:'PONG'})[frame.opcode];if(!kind)return;
      await this.ingest({event:'message',id,message:{time:receivedAt,direction:method.endsWith('Sent')?'sent':'received',kind,text:frame.opcode===1?preview.toString('utf8'):'',base64:preview.toString('base64'),size,truncated:size>preview.length}});this.info.messages++;return;
    }
    if(method==='Network.webSocketClosed'||method==='Network.webSocketFrameError'){
      const native=this.nodePending.get(key);if(native){native.ended=true;native.error=p.errorMessage;return;}
      const id=this.sockets.get(key);if(id){await this.ingest({event:'end',id,error:p.errorMessage||null});this.sockets.delete(key);}
      await this.finishHandshake(key,p.errorMessage||'WebSocket закрылся до завершения рукопожатия');return;
    }
    if(method==='Network.requestWillBeSent'&&/^https?:/.test(p.request.url)){
      if(this.controlUrl(p.request.url))return;
      if(this.requests.size>=this.recordLimit){this.info.error='Достигнут лимит '+this.recordLimit+' ожидающих HTTP-запросов';return;}
      if(p.redirectResponse&&this.requests.has(key))await this.finishHttp(key,{response:p.redirectResponse},s);
      const wall=p.wallTime||receivedAt/1000;
      // Chromium emits Unix seconds; Node.js versions also emit Unix milliseconds.
      this.requests.set(key,{request:p.request,time:Math.floor(wall>1e11?wall:wall*1000),timestamp:p.timestamp,captureTarget:this.targetLabel(s),captureContext:this.targetContext(s)});return;
    }
    if(method==='Network.responseReceived'&&this.requests.has(key)){this.requests.get(key).response=p.response;return;}
    if(method==='Network.loadingFinished'||method==='Network.loadingFailed')await this.finishHttp(key,p,s);
  }
  targetLabel(session=''){const value=String(this.sessions.get(session)?.title||'').toWellFormed(),fallback=this.info.mode==='node'?'Node.js / Electron main process':'Electron / Chromium';return Array.from(value.trim()?value:fallback).slice(0,256).join('');}
  targetContext(session=''){const info=this.sessions.get(session);if(!info)return undefined;return info.captureContext??=randomUUID();}
  updateTargetTitles(targets){for(const target of targets||[])if(target?.targetId&&typeof target.title==='string')for(const info of this.sessions.values())if(info.targetId===target.targetId)info.title=target.title;}
  refreshTargetTitles(){
    const socket=this.socket;let busy=false;
    this.targetTimer=setInterval(async()=>{
      if(busy||this.socket!==socket||socket.readyState!==1||this.stopping)return;busy=true;
      try{const value=await this.command('Target.getTargets');if(this.socket===socket&&!this.stopping)this.enqueue({method:'Librium.targetInfos',params:{targetInfos:value.targetInfos}});}catch{}finally{busy=false;}
    },1000);this.targetTimer.unref?.();
  }
  saveExchange(exchange,websocket){exchange.summary.source=this.info.mode==='node'?'cdp_node':'cdp_chromium';exchange.summary.capture_target??=this.targetLabel();exchange.summary.capture_context??=this.targetContext();return this.ingest({event:'exchange',exchange,websocket});}
  controlUrl(value){
    try{const url=new URL(value);return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&[3000,this.info.port].includes(Number(url.port));}catch{return false;}
  }
  async finishHttp(key,p,s){
    const row=this.requests.get(key);if(!row)return;this.requests.delete(key);
    const response=p.response||row.response;let body=Buffer.alloc(0),bodyError=null;
    let postData=row.request.postData,postDataEncoding='utf8',requestError=null,observedBody=null;
    const entries=this.info.mode==='chromium'?requestEntries(row.request.postDataEntries):null;
    const requestMayHaveBody=row.request.hasPostData||(this.info.mode==='node'&&!['GET','HEAD','OPTIONS'].includes(row.request.method));
    if(!p.targetUnavailable&&this.info.mode==='node'&&requestMayHaveBody&&this.observer?.active){
      try{
        const value=await this.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(this.observer.slot)}]?.takeHttpBody(${JSON.stringify(key.slice(s.length+1))})`,returnByValue:true});
        observedBody=value.result?.value||null;
      }catch{}
    }
    if(!observedBody&&!entries&&postData===undefined&&requestMayHaveBody&&p.targetUnavailable)requestError='Наблюдение завершено; тело запроса получить не удалось';
    if(!p.targetUnavailable&&!observedBody&&!entries&&postData===undefined&&requestMayHaveBody){
      try{const result=await this.command('Network.getRequestPostData',{requestId:key.slice(s.length+1)},s);postData=result.postData;postDataEncoding=result.base64Encoded?'base64':'utf8';
        if(this.info.mode==='node'&&!row.request.hasPostData&&!postData)requestError='Отладчик Node.js не предоставил тело запроса; пустое тело не подтверждено';
      }
      catch(error){requestError='Тело запроса недоступно через отладчик: '+error.message.slice(0,200);}
    }
    // Node.js discards the request buffer after getResponseBody, including POST data.
    if(response&&!p.response&&!p.errorText){try{const value=await this.command('Network.getResponseBody',{requestId:key.slice(s.length+1)},s);body=Buffer.from(value.body,value.base64Encoded?'base64':'utf8');}catch{bodyError='Тело недоступно через CDP (буфер, кэш или поток)';}}
    const req=observedBody?payload(row.request.headers,Buffer.from(observedBody.base64,'base64'),observedBody.size):entries?payload(row.request.headers,entries.bytes,Math.max(entries.size,contentLength(row.request.headers)||0)):payload(row.request.headers,Buffer.from(postData||'',postDataEncoding),contentLength(row.request.headers)||0);
    if(entries&&(!entries.complete||(contentLength(row.request.headers)??0)>entries.size)){req.complete=false;req.headers.push(['x-librium-capture-note','Отладчик Chromium пропустил часть тела запроса (например, содержимое файла); сохранён только доступный префикс, полный размер может быть неизвестен']);}
    if(observedBody&&!observedBody.complete){req.complete=false;req.headers.push(['x-librium-capture-note',observedBody.note||'Тело запроса сохранено частично']);}
    if(requestError){req.complete=false;req.headers.push(['x-librium-capture-note',requestError]);}
    req.headers.push(['x-librium-target',row.captureTarget??this.targetLabel(s)]);
    const knownSize=this.info.mode==='node'?contentLength(response?.headers):null;
    // Node.js may return a capped prefix instead of reporting a buffer error.
    if(this.info.mode==='node'&&knownSize===null&&body.length>=1024*1024&&!bodyError)bodyError='Буфер Node.js ограничил тело; полный размер ответа не подтверждён';
    const res=payload(response?.headers,body,knownSize??body.length);
    if(this.info.mode!=='node')res.headers.push(['x-librium-body-decoded','true']);
    if(bodyError)res.headers.push(['x-librium-capture-note',bodyError]);
    if(p.captureEnded)res.headers.push(['x-librium-capture-note',p.errorText+'; результат приложения после отключения не наблюдается; длительность отражает только время наблюдения']);
    if(!response||bodyError||p.errorText)res.complete=false;
    await this.saveExchange({summary:{id:0,capture_target:row.captureTarget??this.targetLabel(s),capture_context:row.captureContext??this.targetContext(s),time:row.time,method:row.request.method,url:row.request.url,status:response?.status||null,elapsed_ms:p.captureEnded?Math.max(0,Date.now()-row.time):Math.max(0,Math.round(((p.timestamp||row.timestamp)-row.timestamp)*1000)),size:res.size,error:p.errorText||null},request:req,response:res},false);this.info.exchanges++;
  }
}
async function launchMajestic(port,options={}) {
  portNumber(port);portNumber(port+1);const path=majesticPath();if(!existsSync(path))throw Error('Majestic Launcher не найден в стандартной папке');
  await launchElectron({executable:path,args:[],cwd:dirname(path)},port,options);
}
module.exports={CdpCapture,launchMajestic,portNumber,payload,requestEntries};
