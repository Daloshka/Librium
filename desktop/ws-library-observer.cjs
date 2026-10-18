// Serialized into the inspected runtime. Only ws classes already loaded
// by the application (or subsequently loaded through Node's module hooks) are
// instrumented. No application package is required by this observer.
function observeWsLibraries({slot,publish,preview,frame,allocate,release,safe,byteLimit=8*1024*1024}) {
  const {Buffer}=process.getBuiltinModule('buffer');
  const modules=process.getBuiltinModule('module');
  const classes=new Map(),connections=new Map();let upgrades=new WeakMap(),serverHeaders=new WeakMap();
  let hook,stopped=false,fragmentBytes=0,unsupported=false;
  const missing=()=>{if(!unsupported){unsupported=true;publish({type:'warning',message:'Тип сообщения ws не поддерживается наблюдателем; часть данных пропущена'});}};
  const data=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
  const restore=(object,key,wrapper,descriptor)=>{
    if(Object.getOwnPropertyDescriptor(object,key)?.value!==wrapper)return;
    if(descriptor)Object.defineProperty(object,key,descriptor);else delete object[key];
  };
  const rawHeaders=response=>{
    const raw=data(response,'rawHeaders');if(!Array.isArray(raw))return [];
    const pairs=[];for(let n=0;n+1<raw.length;n+=2)if(typeof raw[n]==='string'&&typeof raw[n+1]==='string')pairs.push([raw[n],raw[n+1]]);
    return pairs;
  };
  function clean(record){
    for(const item of record.methods)restore(record.sender,item.key,item.wrapper,item.descriptor);
    connections.delete(record.ws);release(record);
    if(record.fragment){fragmentBytes-=record.fragment.bytes.length;record.fragment=null;}
  }
  function cleanup(reason){
    if(stopped)return;stopped=true;hook?.deregister();
    for(const record of connections.values()){
      clean(record);
      if(reason)record.queue.then(()=>publish({type:'end',key:record.key,error:reason})).catch(()=>{});
    }
    for(const [prototype,item] of classes){restore(prototype,'emit',item.wrapper,item.descriptor);if(item.upgrade)restore(prototype,'handleUpgrade',item.upgrade.wrapper,item.upgrade.descriptor);}
    classes.clear();upgrades=new WeakMap();serverHeaders=new WeakMap();
  }
  function part(dataValue){
    if(!Array.isArray(dataValue))return preview(dataValue);
    let size=0,remaining=65536;const chunks=[];
    for(const bytes of dataValue){
      if(!Buffer.isBuffer(bytes))return null;
      size+=bytes.length;if(remaining){const chunk=bytes.subarray(0,remaining);chunks.push(chunk);remaining-=chunk.length;}
    }
    return {kind:'BINARY',size,bytes:Buffer.concat(chunks)};
  }
  function message(record,value,direction,kind){
    const saved=part(value);if(!saved){missing();return;}
    saved.kind=kind;
    frame(record,null,direction,{part:saved,time:Date.now(),transform:(bytes,p,time)=>stopped?null:{...p,bytes,time}});
  }
  function sendPart(record,saved,binary,fin,time){
    saved.kind=binary?'BINARY':'TEXT';
    frame(record,null,'sent',{part:saved,time,transform:(bytes,p,at)=>{
      if(stopped)return null;
      const previous=record.fragment;
      const combined={kind:previous?.kind||p.kind,time:previous?.time||at,
        size:(previous?.size||0)+p.size,bytes:previous?Buffer.concat([previous.bytes,bytes.subarray(0,65536-previous.bytes.length)]):bytes};
      fragmentBytes-=previous?.bytes.length||0;
      record.fragment=fin?null:combined;
      if(!fin)fragmentBytes+=combined.bytes.length;
      if(fragmentBytes>byteLimit){
        publish({type:'warning',message:'Превышен лимит фрагментов ws; наблюдение библиотеки остановлено'});
        cleanup('Наблюдение ws остановлено: превышен лимит фрагментов');return null;
      }
      return fin?combined:null;
    }});
  }
  function attach(ws,partial,serverMetadata=null){
    if(stopped)return null;
    if(connections.has(ws))return connections.get(ws);
    const server=data(ws,'_isServer')===true,metadata=server?serverMetadata:null;
    if(![true,false].includes(data(ws,'_isServer'))||data(ws,'_readyState')!==1)return null;
    const url=server?metadata?.url:data(ws,'_url'),sender=data(ws,'_sender');
    if(typeof url!=='string'||!/^wss?:/.test(url)||!sender||typeof sender.send!=='function')return null;
    const base=allocate();if(!base)return null;
    const record={...base,ws,sender,methods:[],fragment:null};
    connections.set(ws,record);
    const wrap=(key,capture)=>{
      const descriptor=Object.getOwnPropertyDescriptor(sender,key),original=sender[key];if(typeof original!=='function')return;
      const wrapper=function(...args){
        if(stopped||this!==sender)return Reflect.apply(original,this,args);
        const saved=safe(()=>part(args[0]))();
        const metadata=key==='send'?safe(()=>{
          const binary=Object.getOwnPropertyDescriptor(args[1],'binary'),fin=Object.getOwnPropertyDescriptor(args[1],'fin');
          return binary&&fin&&'value' in binary&&'value' in fin?{binary:Boolean(binary.value),fin:Boolean(fin.value)}:null;
        })():null;
        const time=Date.now();
        const result=Reflect.apply(original,this,args);
        if(!stopped&&this===sender){if(saved)safe(capture)(saved,metadata,time);else missing();}
        return result;
      };
      Object.defineProperty(sender,key,{value:wrapper,configurable:true,writable:true});record.methods.push({key,wrapper,descriptor});
    };
    try{
      wrap('send',(saved,options,time)=>{
      if(!options||typeof options.binary!=='boolean'||typeof options.fin!=='boolean'){
        publish({type:'warning',message:'Параметры отправки ws недоступны; сообщение пропущено'});return;
      }
      sendPart(record,saved,options.binary,options.fin,time);
      });
      for(const [method,kind] of [['ping','PING'],['pong','PONG']])wrap(method,(saved,_options,time)=>{
        saved.kind=kind;frame(record,null,'sent',{part:saved,time,transform:(bytes,p,at)=>stopped?null:{...p,bytes,time:at}});
      });
    }catch{clean(record);publish({type:'warning',message:'Методы отправки этого клиента ws недоступны для наблюдения'});return null;}
    publish({type:'open',key:record.key,time:Date.now(),url,status:101,library:'ws',role:server?'server':'client',partial,
      requestHeaders:metadata?.requestHeaders,responseHeaders:server?metadata.responseHeaders:upgrades.get(ws)||[]});upgrades.delete(ws);
    return record;
  }
  function serverAttach(ws,request){
    if(stopped||!ws||!request||connections.has(ws))return;
    const requestHeaders=rawHeaders(request),host=requestHeaders.find(([key])=>key.toLowerCase()==='host')?.[1],target=data(request,'url'),socket=data(ws,'_socket');
    if(typeof host!=='string'||typeof target!=='string'||!target.startsWith('/'))return;
    const scheme=data(socket,'encrypted')===true?'wss:':'ws:',origin=new URL(scheme+'//'+host);
    if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return;
    const metadata={url:origin.origin+target,requestHeaders,responseHeaders:serverHeaders.get(request)||[]};serverHeaders.delete(request);attach(ws,false,metadata);
  }
  const register=safe(value=>{
    if(stopped||typeof value!=='function')return;
    const prototype=value.prototype;
    if(prototype&&!classes.has(prototype)&&typeof prototype.handleUpgrade==='function'&&typeof prototype.emit==='function'){
      const descriptor=Object.getOwnPropertyDescriptor(prototype,'emit'),original=prototype.emit;
      const wrapper=function(event,...args){
        if(!stopped&&event==='connection')safe(()=>serverAttach(args[0],args[1]))();
        const result=Reflect.apply(original,this,[event,...args]);
        if(!stopped&&event==='headers')safe(()=>{
          if(!Array.isArray(args[0])||!args[1])return;const headers=[];
          for(let n=0;n<args[0].length;n++){const line=data(args[0],String(n));if(typeof line!=='string')continue;const colon=line.indexOf(':');if(colon>0)headers.push([line.slice(0,colon),line.slice(colon+1).trim()]);}
          serverHeaders.set(args[1],headers);
        })();
        return result;
      };
      const upgradeDescriptor=Object.getOwnPropertyDescriptor(prototype,'handleUpgrade'),upgradeOriginal=prototype.handleUpgrade;
      const upgradeWrapper=function(request,socket,head,callback){
        'use strict';
        const args=Array.from(arguments);
        if(!stopped&&typeof callback==='function')args[3]=function(){
          'use strict';
          const values=Array.from(arguments);safe(()=>serverAttach(values[0],values[1]||request))();return Reflect.apply(callback,this,values);
        };
        return Reflect.apply(upgradeOriginal,this,args);
      };
      try{Object.defineProperty(prototype,'emit',{value:wrapper,configurable:true,writable:true});Object.defineProperty(prototype,'handleUpgrade',{value:upgradeWrapper,configurable:true,writable:true});classes.set(prototype,{wrapper,descriptor,upgrade:{wrapper:upgradeWrapper,descriptor:upgradeDescriptor}});}catch{restore(prototype,'emit',wrapper,descriptor);restore(prototype,'handleUpgrade',upgradeWrapper,upgradeDescriptor);publish({type:'warning',message:'Методы сервера ws недоступны для наблюдения'});}return;
    }
    if(!prototype||classes.has(prototype)||typeof prototype.send!=='function'||typeof prototype.ping!=='function'||typeof prototype.pong!=='function'||typeof prototype.emit!=='function')return;
    const descriptor=Object.getOwnPropertyDescriptor(prototype,'emit'),original=prototype.emit;
    const wrapper=function(event,...args){
      safe(()=>{
        const server=data(this,'_isServer')===true;if(stopped||![true,false].includes(data(this,'_isServer')))return;
        if(event==='upgrade'&&!server){upgrades.set(this,rawHeaders(args[0]));return;}
        const record=event==='open'&&!server?attach(this,false):connections.get(this)||(!server&&['message','ping','pong'].includes(event)?attach(this,true):null);
        if(!record)return;
        if(event==='message')message(record,args[0],'received',args[1]?'BINARY':'TEXT');
        else if(event==='ping'||event==='pong')message(record,args[0],'received',event.toUpperCase());
        else if(event==='close'){
          const reason=typeof args[1]==='string'?args[1]:Buffer.isBuffer(args[1])?args[1].toString('utf8'):'';
          record.queue.then(()=>publish({type:'close',key:record.key,time:Date.now(),code:args[0],reason,error:record.fragment?'Соединение ws закрыто с незавершённым исходящим сообщением':null})).catch(()=>{});
          // Pending fragment transforms run before this queued cleanup.
          record.queue=record.queue.then(()=>clean(record)).catch(()=>{});
        }
      })();
      return Reflect.apply(original,this,[event,...args]);
    };
    Object.defineProperty(prototype,'emit',{value:wrapper,configurable:true,writable:true});classes.set(prototype,{wrapper,descriptor});
  });
  const matches=value=>/(?:^|[/\\])node_modules[/\\]ws[/\\]lib[/\\]websocket(?:-server)?\.js$/i.test(value);
  try{
    const cache=modules.createRequire(process.execPath).cache;
    for(const [filename,module] of Object.entries(cache))if(matches(filename))register(module.exports);
    if(typeof modules.registerHooks==='function')hook=modules.registerHooks({load(url,context,nextLoad){
    const result=nextLoad(url,context);
    if(stopped||!matches(url)||!['commonjs',undefined].includes(result.format)||result.source==null)return result;
    try{
      const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
      return {...result,source:source+`\n;try { globalThis[${JSON.stringify(slot)}]?.registerWs?.(module.exports); } catch {}\n`};
    }catch{return result;}
    }});
  }catch{cleanup();publish({type:'warning',message:'Наблюдатель библиотеки ws недоступен в этом runtime'});}
  return {register,cleanup,lazy:Boolean(hook),available:!stopped};
}
module.exports={observeWsLibraries};
