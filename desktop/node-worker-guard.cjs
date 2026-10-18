// Runs in the target main thread. Its local inspector session survives loss of
// Librium's WebSocket and releases only new workers held during our setup.
function guardNodeWorkers(slot, binding, leaseMs = 5000) {
  const inspector = process.getBuiltinModule('inspector');
  const {performance} = process.getBuiltinModule('perf_hooks');
  const session = new inspector.Session();
  const pending = new Map(), attached = new Set();
  let expires = performance.now() + leaseMs, stopped = false;
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
  const send = (id, method, params = {}) => post('NodeWorker.sendMessageToWorker', {sessionId:id, message:JSON.stringify({id:-1, method, params})});
  async function release(row) {
    if (pending.get(row.id) !== row) return;
    pending.delete(row.id); clearTimeout(row.timer);
    // Commands on this local channel are queued in order on the worker thread.
    await send(row.id, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    await send(row.id, 'Debugger.enable').catch(() => {});
    await send(row.id, 'Debugger.resume').catch(() => {});
    await send(row.id, 'Debugger.disable').catch(() => {});
    await post('NodeWorker.detach', {sessionId:row.id}).catch(() => {});
  }
  async function stop() {
    if (stopped) return; stopped = true; clearInterval(timer);
    await Promise.allSettled([...pending.values()].map(release));
    await Promise.allSettled([...attached].map(id => post('NodeWorker.detach', {sessionId:id})));
    await post('NodeWorker.disable').catch(() => {});
    session.disconnect(); delete globalThis[slot]; delete globalThis[binding];
  }
  session.on('NodeWorker.attachedToWorker', ({params:p}) => {
    if (attached.size >= 32) {
      void send(p.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {}).finally(() => post('NodeWorker.detach', {sessionId:p.sessionId}).catch(() => {}));
      return;
    }
    attached.add(p.sessionId);
    if (!p.waitingForDebugger) return;
    const row = {id:p.sessionId};
    pending.set(row.id, row);
    row.timer = setTimeout(() => {void release(row);}, leaseMs); row.timer.unref?.();
  });
  session.on('NodeWorker.detachedFromWorker', ({params:p}) => {
    attached.delete(p.sessionId); const row = pending.get(p.sessionId);
    if (row) {clearTimeout(row.timer); pending.delete(p.sessionId);}
  });
  session.on('inspectorNotification', event => {
    if (!event.method.startsWith('NodeWorker.') || typeof globalThis[binding] !== 'function') return;
    if (event.method === 'NodeWorker.attachedToWorker' && !attached.has(event.params.sessionId)) {
      globalThis[binding](JSON.stringify({method:'Librium.workerLimit'})); return;
    }
    globalThis[binding](JSON.stringify(event));
  });
  session.connect();
  session.post('NodeWorker.enable', {waitForDebuggerOnStart:false});
  const timer = setInterval(() => {if (performance.now() >= expires) void stop();}, 250); timer.unref?.();
  globalThis[slot] = {
    renew() {expires = performance.now() + leaseMs;},
    command(method, params) {
      if (stopped || !['NodeWorker.enable','NodeWorker.disable','NodeWorker.detach','NodeWorker.sendMessageToWorker'].includes(method)) throw Error('Worker channel closed');
      const row = method === 'NodeWorker.detach' ? pending.get(params?.sessionId) : null;
      if (row) return release(row);
      // These commands address the local main-thread session. Return their
      // synchronous reply directly: awaiting a Promise during an inspector
      // startup pause would require the very event loop we have not resumed.
      let result, failure, replied = false;
      session.post(method, params, (error, value) => {failure = error; result = value; replied = true;});
      if (!replied || failure) throw failure || Error('Worker command was not synchronous');
      return result || {};
    },
    finish(id) {const row = pending.get(id); if (!row) return; pending.delete(id); clearTimeout(row.timer);},
    stop,
  };
  return true;
}
module.exports = {guardNodeWorkers};
