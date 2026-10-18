const assert=require('node:assert/strict');
const dc=require('node:diagnostics_channel');
const {observeHttpBodies}=require('../desktop/http-body-observer.cjs');
const warnings=[];const observer=observeHttpBodies({publish:event=>warnings.push(event)});
const symbol=Symbol('kInspectorRequestId');
const request=(id,body)=>({[symbol]:id,method:'POST',body,origin:'http://same.invalid',path:'/same-url'});
const emit=(name,request,chunk)=>dc.channel('undici:request:'+name).publish({request,chunk});
function send(id,body,chunks){const row=request(id,body);emit('create',row);for(const chunk of chunks)emit('bodyChunkSent',row,chunk);emit('bodySent',row);return row;}
try{
  const left=request('left','left'),right=request('right','right');emit('create',left);emit('create',right);
  emit('bodyChunkSent',right,'right');emit('bodySent',right);emit('bodyChunkSent',left,'left');emit('bodySent',left);
  assert.equal(Buffer.from(observer.take('left').base64,'base64').toString(),'left');
  assert.equal(Buffer.from(observer.take('right').base64,'base64').toString(),'right');assert.equal(observer.take('left'),null);
  const unicode='x'.repeat(65535)+'😀end';send('unicode',unicode,[unicode]);
  const value=observer.take('unicode');assert.equal(value.complete,true);assert.equal(value.size,Buffer.byteLength(unicode));
  assert.deepEqual(Buffer.from(value.base64,'base64'),Buffer.from(unicode).subarray(0,65536));
  const raw=Buffer.from([9,0,255,128,8]);send('view',raw,[new Uint8Array(raw.buffer,raw.byteOffset+1,3)]);
  assert.equal(observer.take('view').base64,'AP+A');
  let read=0;const stream={get [Symbol.asyncIterator](){read++;throw Error('Must not read application stream');}};
  const active=request('partial',stream);emit('create',active);emit('bodyChunkSent',active,Buffer.from('prefix'));
  const partial=observer.take('partial');assert.equal(partial.complete,false);assert.equal(partial.size,6);assert.equal(Buffer.from(partial.base64,'base64').toString(),'prefix');assert.equal(read,0);
  emit('bodyChunkSent',active,Buffer.from('later'));emit('bodySent',active);assert.equal(observer.take('partial'),null);
  send('empty',null,[]);assert.equal(observer.take('empty').complete,true);
  send('unknown-empty',stream,[]);const unknown=observer.take('unknown-empty');assert.equal(unknown.complete,false);assert.match(unknown.note,/пустое тело не подтверждено/);
  const aborted=request('aborted',stream);emit('create',aborted);emit('bodyChunkSent',aborted,Buffer.from('sent'));emit('error',aborted);
  assert.match(observer.take('aborted').note,/прервана/);
  const responseFailure=send('response-failure','uploaded',['uploaded']);emit('error',responseFailure);
  const uploaded=observer.take('response-failure');assert.equal(uploaded.complete,true,'response failure must not undo a confirmed upload');assert.equal(uploaded.note,null);
  const shared=Buffer.alloc(65536,7);
  for(let n=0;n<129;n++)send('limit-'+n,shared,[shared]);
  const limited=observer.take('limit-128');assert.equal(limited.complete,false);assert.equal(limited.size,65536);assert.equal(limited.base64,'');assert.match(limited.note,/Лимит памяти/);
  for(let n=0;n<128;n++)assert.equal(observer.take('limit-'+n).complete,true);
  send('recovered','ok',['ok']);assert.equal(observer.take('recovered').complete,true);
  const noId={method:'POST',body:'unmatched'};emit('create',noId);emit('bodyChunkSent',noId,'unmatched');emit('bodySent',noId);assert.equal(observer.take('unmatched'),null);
  let applicationEvents=0;const application=()=>applicationEvents++;dc.subscribe('undici:request:create',application);
  observer.cleanup();send('after','after',['after']);assert.equal(observer.take('after'),null);assert.equal(applicationEvents,1);dc.unsubscribe('undici:request:create',application);
  console.log('PASS: request IDs, UTF-8 boundary / binary view bytes, partial / empty / aborted bodies, no stream reads, 8 MiB limit, recovery and diagnostic cleanup');
}finally{observer.cleanup();}
