const {app} = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const {WebSocketServer} = require('ws');
const {observeWebSockets} = require('../desktop/node-ws-observer.cjs');
let server, wss;
const events = [];
const slot = '__libriumObserverTest';
const install = (lease=5000) => {
  globalThis.__libriumEmitTest = value => events.push(JSON.parse(value));
  return observeWebSockets('__libriumEmitTest', slot, lease);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => {console.error('Observer test timed out');app.exit(1);}, 15000);
async function run() {
  server = http.createServer(); wss = new WebSocketServer({server});
  wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, {binary})));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/same-address`;
  const originalSend = WebSocket.prototype.send;
  assert.equal(install().available, true);
  const sockets = await Promise.all([1, 2].map(async n => {
    const ws = new WebSocket(url); ws.binaryType = n === 1 ? 'arraybuffer' : 'blob';
    await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
    assert.notEqual(ws.send, originalSend);
    return ws;
  }));
  const first = sockets[0];
  const originalReturn = first.send('one'); assert.equal(originalReturn, undefined);
  sockets[1].send('two'); first.send(new Uint8Array([0, 255, 17]));
  first.send(new Blob([new Uint8Array([7, 128])])); first.send('я'.repeat(40000));
  const boundary='x'.repeat(65535)+'😀';first.send(boundary);
  assert.throws(() => first.send.call({}), TypeError);
  for (let n = 0; n < 100 && events.filter(e => e.type === 'frame').length < 12; n++) await wait(20);
  assert.equal(events.filter(e => e.type === 'frame').length, 12);
  const opens = events.filter(e => e.type === 'open'); assert.equal(opens.length, 2);
  const firstKey = events.find(e => e.type === 'frame' && e.direction === 'sent' && Buffer.from(e.base64, 'base64').toString() === 'one').key;
  const secondKey = events.find(e => e.type === 'frame' && e.direction === 'sent' && Buffer.from(e.base64, 'base64').toString() === 'two').key;
  assert.notEqual(firstKey, secondKey);
  for (const direction of ['sent', 'received']) {
    const frames = events.filter(e => e.type === 'frame' && e.direction === direction);
    assert.equal(frames.find(e => Buffer.from(e.base64, 'base64').toString() === 'two').key, secondKey);
    const own = frames.filter(e => e.key === firstKey);
    assert.deepEqual(own.map(e => e.size), [3, 3, 2, 80000,65539]);
    assert.equal(own[1].base64, 'AP8R'); assert.equal(own[2].base64, 'B4A=');
    assert.equal(own[3].truncated, true); assert.equal(Buffer.from(own[3].base64, 'base64').length, 65536);
    assert.deepEqual(Buffer.from(own[4].base64,'base64'),Buffer.from(boundary).subarray(0,65536));
  }
  first.close(1000, 'done');
  await new Promise(resolve => first.addEventListener('close', resolve, {once:true}));
  await wait(20); assert.equal(Object.hasOwn(first, 'send'), false);
  assert.equal(events.find(e => e.type === 'close').reason, 'done');
  assert.equal(sockets[1].binaryType, 'blob');
  const wrapper = sockets[1].send;
  globalThis[slot].stop(); assert.equal(globalThis[slot], undefined);
  assert.equal(globalThis.__libriumEmitTest,undefined);
  assert.equal(Object.hasOwn(sockets[1], 'send'), false); assert.notEqual(sockets[1].send, wrapper);
  const count = events.length;
  sockets[1].send('still working'); await wait(30); assert.equal(events.length, count);
  // A lost inspector connection must not leave a send wrapper in the app.
  assert.equal(install(60).available, true);
  const lease = new WebSocket(url); await new Promise(resolve => {lease.onopen = resolve;});
  assert.notEqual(lease.send, originalSend);
  await wait(160); assert.equal(globalThis[slot], undefined); assert.equal(Object.hasOwn(lease, 'send'), false);assert.equal(lease.send, originalSend);
  lease.send('after expired lease'); lease.close(); sockets[1].close();
  assert.equal(install().available, true);
  const changed = new WebSocket(url);await new Promise(resolve => {changed.onopen=resolve;});
  const replacement = function(...args) {return Reflect.apply(originalSend, this, args);};
  changed.send=replacement;
  globalThis[slot].stop();assert.equal(changed.send,replacement,'cleanup must preserve later application changes');changed.close();
  assert.equal(install().available, true);
  const flood = new WebSocket(url);await new Promise(resolve => {flood.onopen=resolve;});
  let received=0;flood.onmessage=()=>received++;
  for(let n=0;n<1100;n++)flood.send('');
  assert.equal(globalThis[slot],undefined,'empty messages must also obey a queue limit');
  assert.equal(WebSocket.prototype.send,originalSend);assert.equal(flood.readyState,1);
  for(let n=0;n<100&&received<1100;n++)await wait(10);
  assert.equal(received,1100,'capture overflow must not interrupt application messages');flood.close();
  console.log('PASS: Node WS text/binary/Blob, UTF-8 truncation, identical URLs, send semantics, detach and expired lease');
}
app.whenReady().then(run).catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  clearTimeout(deadline);globalThis[slot]?.stop();
  for (const ws of wss?.clients || []) ws.terminate();
  if (wss) await new Promise(resolve => wss.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  app.exit(process.exitCode || 0);
});
