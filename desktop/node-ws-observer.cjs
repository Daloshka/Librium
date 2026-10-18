// Runs inside the inspected Node.js runtime. Keep dependencies local to this
// function: its source is sent through Runtime.evaluate, including in ESM apps.
function observeWebSockets(binding, slot, leaseMs = 5000,wsInstaller,httpInstaller,limits={}) {
  if(typeof process?.pid!=='number')return {available:false,bootstrap:true};
  if (typeof process?.getBuiltinModule !== 'function') return {available:false};
  const dc = process.getBuiltinModule('diagnostics_channel');
  const {Buffer, Blob} = process.getBuiltinModule('buffer');
  const timers = process.getBuiltinModule('timers');
  const {performance} = process.getBuiltinModule('perf_hooks');
  const emit = globalThis[binding];
  if (typeof emit !== 'function' || globalThis[slot]) return {available:false};
  const recordLimit=limits.records||2000,byteLimit=limits.bytes||8*1024*1024,pendingLimit=limits.pending||4096;
  const active = new Map();
  const early = new Map();
  const prototype = globalThis.WebSocket?.prototype;
  const sendDescriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'send');
  let prototypeWrapper,library,httpBodies;
  let stopped = false, serial = 0, records=0, pendingBytes = 0, pendingCount = 0, expires = performance.now() + leaseMs;
  const safe = fn => (...args) => {try {return fn(...args);} catch {}};
  const publish = safe(event => {if (!stopped) emit(JSON.stringify(event));});
  const allocate=()=>{
    if(records>=recordLimit){publish({type:'warning',message:'Достигнут лимит '+recordLimit+' WebSocket Node.js'});return null;}
    records++;return {key:String(++serial),queue:Promise.resolve(),pending:0,count:0};
  };
  const release=record=>{if(!record.released){record.released=true;records--;}};
  const cleanSocket = record => {
    record.ws.removeEventListener('message', record.message);
    record.ws.removeEventListener('close', record.close);
    // Do not overwrite a later change made by the inspected application.
    if (Object.getOwnPropertyDescriptor(record.ws, 'send')?.value === record.wrapper) {
      if (record.descriptor) Object.defineProperty(record.ws, 'send', record.descriptor);
      else delete record.ws.send;
    }
    active.delete(record.ws);
    release(record);
  };
  function stop() {
    if (stopped) return;
    stopped = true; timers.clearInterval(timer);
    library?.cleanup();
    httpBodies?.cleanup();
    dc.unsubscribe('undici:websocket:open', open);
    for (const record of active.values()) cleanSocket(record);
    for (const item of early.values()) timers.clearTimeout(item.timer);
    early.clear();
    if (prototype && Object.getOwnPropertyDescriptor(prototype, 'send')?.value === prototypeWrapper)
      Object.defineProperty(prototype, 'send', sendDescriptor);
    delete globalThis[slot];
    if (globalThis[binding] === emit) delete globalThis[binding];
  }
  function preview(data) {
    if (typeof data === 'string') {
      const size = Buffer.byteLength(data);
      return {kind:'TEXT', size, bytes:Buffer.from(data.slice(0, 65537)).subarray(0, 65536)};
    }
    if (data instanceof Blob) {
      return {kind:'BINARY', size:data.size, blob:data.slice(0, 65536)};
    }
    const view = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) :
      data instanceof ArrayBuffer ? Buffer.from(data) : null;
    if (!view) return null; // Never stringify an application object twice.
    return {kind:'BINARY', size:view.length, bytes:Buffer.from(view.subarray(0, 65536))};
  }
  function frame(record, data, direction, saved) {
    if (stopped) return;
    const part = saved?.part || preview(data);
    if (!part) return;
    const time = saved?.time || Date.now();
    // Bound pending Blob reads as well as previews. A slow reader cannot retain
    // unlimited application data; stop observing rather than interrupt the app.
    const cost = Math.min(part.size, 65536);
    if (record.pending + cost > 1024 * 1024 || pendingBytes + cost > byteLimit || record.count >= 1024 || pendingCount >= pendingLimit) {
      publish({type:'warning', message:'Превышен лимит очереди сообщений Node.js; наблюдатель отключён'});
      stop(); return;
    }
    record.pending += cost;record.count++;
    pendingBytes += cost;pendingCount++;
    record.queue = record.queue.then(async () => {
      if (stopped) return;
      const bytes = part.bytes || Buffer.from(await part.blob.arrayBuffer());
      const message=saved?.transform?saved.transform(bytes,part,time):{...part,bytes,time};
      if(message)publish({type:'frame', key:record.key, time:message.time, direction, kind:message.kind,
        size:message.size, truncated:message.size > message.bytes.length, base64:message.bytes.toString('base64')});
    }).catch(() => publish({type:'warning', message:'Не удалось прочитать сообщение Node.js'}))
      .finally(() => {record.pending -= cost;record.count--;pendingBytes -= cost;pendingCount--;});
  }
  const open = safe(({websocket:ws, handshakeResponse}) => {
    if (stopped) return;
    if (!ws || typeof ws.send !== 'function') {
      publish({type:'warning', message:'Версия Undici не предоставляет экземпляр WebSocket; доступны только данные инспектора'});
      return;
    }
    if (handshakeResponse?.status && handshakeResponse.status !== 101) {
      publish({type:'warning', message:'WebSocket через HTTP/2 пока не поддерживается хранилищем Librium'});return;
    }
    if (active.has(ws)) return;
    const base=allocate();if(!base)return;
    const original = ws.send, descriptor = Object.getOwnPropertyDescriptor(ws, 'send');
    const record = {...base,ws,descriptor};
    record.wrapper = function(...args) {
      const result = Reflect.apply(original, this, args);
      // A borrowed method must retain its normal receiver semantics.
      if (!stopped && this === ws && ws.readyState === 1) safe(frame)(record, args[0], 'sent');
      return result;
    };
    record.message = safe(event => frame(record, event.data, 'received'));
    record.close = safe(event => {
      cleanSocket(record);
      record.queue.then(() => publish({type:'close', key:record.key, time:Date.now(),
        code:event.code, reason:event.reason})).catch(() => {});
    });
    if (original !== prototypeWrapper)
      Object.defineProperty(ws, 'send', {value:record.wrapper, configurable:true, writable:true});
    ws.addEventListener('message', record.message); ws.addEventListener('close', record.close);
    active.set(ws, record);
    publish({type:'open', key:record.key, time:Date.now(), url:ws.url,
      status:handshakeResponse?.status || 101, headers:handshakeResponse?.headers || {}});
    const item = early.get(ws);
    if (item) {
      early.delete(ws);timers.clearTimeout(item.timer);
      for (const saved of item.frames) {pendingBytes -= Math.min(saved.part.size, 65536);pendingCount--;frame(record, null, 'sent', saved);}
    }
  });
  // Undici publishes websocket:open after the application's synchronous
  // onopen callback. Keep those first sends until the diagnostic event arrives.
  if (sendDescriptor?.value) {
    prototypeWrapper = function(...args) {
      const result = Reflect.apply(sendDescriptor.value, this, args);
      safe(() => {
        if (stopped || this.readyState !== 1) return;
        const record = active.get(this);
        if (record) {frame(record, args[0], 'sent');return;}
        const part = preview(args[0]);if (!part) return;
        const cost = Math.min(part.size, 65536);
        if (pendingBytes + cost > byteLimit || pendingCount >= pendingLimit || early.size >= recordLimit) {
          publish({type:'warning', message:'Переполнена очередь первых сообщений Node.js; наблюдатель отключён'});stop();return;
        }
        let item = early.get(this);
        if (!item) {
          item = {frames:[], timer:timers.setTimeout(() => {
            early.delete(this);
            for (const saved of item.frames) {pendingBytes -= Math.min(saved.part.size, 65536);pendingCount--;}
          },100)};
          item.timer.unref?.();early.set(this,item);
        }
        if(item.frames.length>=1024){publish({type:'warning',message:'Слишком много первых сообщений Node.js; наблюдатель отключён'});stop();return;}
        pendingBytes += cost;pendingCount++;item.frames.push({part,time:Date.now()});
      })();
      return result;
    };
    Object.defineProperty(prototype, 'send', {...sendDescriptor, value:prototypeWrapper});
  }
  dc.subscribe('undici:websocket:open', open);
  const timer = timers.setInterval(() => {if (performance.now() > expires) stop();}, Math.min(1000, leaseMs));
  timer.unref?.();
  Object.defineProperty(globalThis, slot, {configurable:true, value:{
    renew:() => {expires = performance.now() + leaseMs;}, stop,registerWs:value=>library?.register(value),
    takeHttpBody:id=>httpBodies?.take(id)||null,
  }});
  if(typeof wsInstaller==='function')library=wsInstaller({slot,publish,preview,frame,allocate,release,safe,byteLimit});
  if(typeof httpInstaller==='function')httpBodies=httpInstaller({publish,recordLimit,byteLimit});
  return {available:true,wsLibrary:library?{lazy:library.lazy,available:library.available}:null};
}

module.exports = {observeWebSockets};
