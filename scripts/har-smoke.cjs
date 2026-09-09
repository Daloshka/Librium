const {entry,exportHar}=require('../desktop/har.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const body=JSON.stringify({message:'hello',count:42});
const gzip=zlib.gzipSync(Buffer.from(body));
const json={
  summary:{id:7,time:Date.UTC(2026,0,2,3,4,5,678),method:'POST',url:'https://api.example.test/v1/items?limit=5&q=a%20b',version:'HTTP/2',content_type:'application/json',status:201,elapsed_ms:34,size:gzip.length,error:null,starred:true,note:'why this one',mock:true},
  request:{headers:[['content-type','application/json'],['cookie','session=abc; theme=dark']],text:'{"name":"x"}',base64:Buffer.from('{"name":"x"}').toString('base64'),size:12,complete:true,truncated:false},
  response:{headers:[['content-type','application/json; charset=utf-8'],['content-encoding','gzip'],['set-cookie','session=def; Path=/; HttpOnly; Secure'],['set-cookie','theme=light; Domain=example.test'],['location','']],text:'',base64:gzip.toString('base64'),size:gzip.length,complete:true,truncated:false},
};
const har=entry(json,null);
assert.equal(har.startedDateTime,'2026-01-02T03:04:05.678Z');
assert.equal(har.time,34);assert.deepEqual(har.timings,{send:0,wait:34,receive:0});
assert.deepEqual(har.request.queryString,[{name:'limit',value:'5'},{name:'q',value:'a b'}]);
assert.deepEqual(har.request.cookies,[{name:'session',value:'abc'},{name:'theme',value:'dark'}]);
assert.deepEqual(har.request.postData,{mimeType:'application/json',text:'{"name":"x"}'});
assert.equal(har.response.status,201);assert.equal(har.response.statusText,'Created');assert.equal(har.request.httpVersion,'HTTP/2');assert.equal(har.response.httpVersion,'HTTP/2');
assert.equal(har.response.content.text,body,'gzip bodies are exported decoded');
assert.equal(har.response.content.size,body.length);assert.equal(har.response.content.compression,body.length-gzip.length,'compression is bytes saved (negative when gzip grew a tiny body)');
assert.equal(har.response.content.encoding,undefined);
assert.deepEqual(har.response.cookies,[{name:'session',value:'def',path:'/',httpOnly:true,secure:true},{name:'theme',value:'light',domain:'example.test'}]);
assert.equal(har.response.bodySize,gzip.length);
// Redaction masks credential headers and the cookies derived from them, and nothing else.
const masked=entry(json,null,{redact:true});
assert.deepEqual(masked.request.headers.find(h=>h.name==='cookie').value,'«redacted»');assert.deepEqual(masked.request.cookies,[{name:'«redacted»',value:''}]);
assert.equal(masked.response.headers.filter(h=>h.name==='set-cookie').every(h=>h.value==='«redacted»'),true);assert.equal(masked.request.headers.find(h=>h.name==='content-type').value,'application/json');
assert.equal(masked.response.content.text,body,'bodies are not touched');assert.equal(entry(json,null).request.headers.find(h=>h.name==='cookie').value,'session=abc; theme=dark','without the option nothing changes');
// Binary bodies stay intact as base64.
const png=fs.readFileSync('desktop/assets/icon.png');
const image=entry({summary:{id:8,time:0,method:'GET',url:'https://example.test/icon.png',status:200,elapsed_ms:5,size:png.length,error:null},request:{headers:[],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','image/png']],text:'',base64:png.toString('base64'),size:png.length,complete:true,truncated:false}},null);
assert.equal(image.response.content.encoding,'base64');assert.deepEqual(Buffer.from(image.response.content.text,'base64'),png);
assert.equal(image.request.postData,undefined);
// A request body the capture cut at 64 KiB is marked, not passed off as complete.
const cut=entry({...json,request:{headers:[['content-type','application/octet-stream']],text:'',base64:Buffer.alloc(16,0xff).toString('base64'),size:1048576,complete:true,truncated:true}},null);
assert.equal(cut.request.bodySize,1048576);assert.equal(cut.request.postData.comment,'Body captured partially');assert.equal(cut.request.postData.encoding,'base64');
// An encoding Node cannot undo leaves the bytes as transmitted, with a note.
const zstd=entry({...json,response:{...json.response,headers:[['content-type','application/json'],['content-encoding','zstd']]}},null);
assert.match(zstd.response.content.comment,/kept as transmitted \(Content-Encoding: zstd\)/);assert.equal(zstd.response.content.compression,undefined);assert.equal(image.request.httpVersion,'HTTP/1.1','rows without a recorded version fall back to HTTP/1.1');
// A failed exchange keeps its notice; WebSocket frames follow the DevTools extension.
const socket=entry({summary:{id:9,time:1000,method:'GET',url:'wss://example.test/live',status:101,elapsed_ms:3,size:0,error:'Connection closed when Librium restarted'},request:{headers:[['upgrade','websocket']],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[],text:'',base64:'',size:0,complete:true,truncated:false}},[{id:1,time:1500,direction:'sent',kind:'TEXT',text:'hi',base64:'aGk=',size:2,truncated:false},{id:2,time:1600,direction:'received',kind:'BINARY',text:'',base64:'AAH/',size:3,truncated:false}]);
assert.equal(socket.comment,'Connection closed when Librium restarted');assert.equal(socket.response.statusText,'Switching Protocols');
assert.deepEqual(socket._webSocketMessages,[{type:'send',time:1.5,opcode:1,data:'hi'},{type:'receive',time:1.6,opcode:2,data:'AAH/'}]);
const closing=entry({...json},[{id:3,time:2000,direction:'sent',kind:'CLOSE',text:'1000 bye',base64:Buffer.from('1000 bye').toString('base64'),size:8,truncated:false},{id:4,time:2100,direction:'received',kind:'PING',text:'',base64:'',size:0,truncated:false}]);
assert.deepEqual(closing._webSocketMessages.map(f=>f.opcode),[8,9],'control frames keep their opcodes');
// Cookie expiry is ISO 8601 in HAR, not the HTTP date from the header.
const dated=entry({...json,response:{...json.response,headers:[['set-cookie','sid=x; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/'],['set-cookie','bad=y; Expires=whenever']]}},null);
assert.equal(dated.response.cookies[0].expires,'2021-06-09T10:18:14.000Z');assert.equal(dated.response.cookies[1].expires,undefined);
// An uncompressed body the capture cut short still reports its full size.
const cutBody=entry({...json,response:{headers:[['content-type','text/plain']],text:'abc',base64:Buffer.from('abc').toString('base64'),size:500000,complete:true,truncated:true}},null);
assert.equal(cutBody.response.content.size,500000);assert.equal(cutBody.response.bodySize,500000);assert.equal(cutBody.response.content.comment,'Body captured partially');
// Import: a HAR entry becomes an exchange the core accepts; our own export round-trips.
const {fromHar}=require('../desktop/har.cjs');
const back=fromHar({log:{version:'1.2',creator:{name:'x'},entries:[har,{startedDateTime:'2026-09-08T10:00:00.000Z',time:12,request:{method:'get',url:'https://other.test/a?b=1',httpVersion:'http/2.0',headers:[{name:'Accept',value:'*/*'}],queryString:[],headersSize:-1,bodySize:-1},response:{status:200,statusText:'OK',httpVersion:'HTTP/2',headers:[{name:'content-type',value:'image/png'}],content:{size:png.length,mimeType:'image/png',text:png.toString('base64'),encoding:'base64'},redirectURL:'',headersSize:-1,bodySize:png.length},cache:{},timings:{send:0,wait:12,receive:0}}]}});
assert.equal(back.length,2);
assert.deepEqual(har._librium,{starred:true,note:'why this one',mock:true},'marks ride along');assert.equal(back[0].summary.starred,true);assert.equal(back[0].summary.mock,true,'the mock tag survives the round trip');assert.equal(back[0].summary.note,'why this one');assert.equal(back[1].summary.starred,undefined,'a foreign HAR has no marks');
assert.equal(back[0].summary.method,'POST');assert.equal(back[0].summary.url,json.summary.url);assert.equal(back[0].summary.status,201);assert.equal(back[0].summary.elapsed_ms,34);assert.equal(back[0].summary.time,json.summary.time);
assert.equal(back[0].request.text,'{"name":"x"}');assert.equal(back[0].response.text,body,'decoded text round-trips');assert.equal(back[0].summary.content_type,'application/json');
assert.equal(back[1].summary.method,'GET');assert.equal(back[1].summary.version,'HTTP/2');assert.deepEqual(Buffer.from(back[1].response.base64,'base64'),png,'base64 content round-trips');assert.equal(back[1].summary.time,Date.UTC(2026,8,8,10,0,0));
assert.throws(()=>fromHar({log:{}}),/HAR/);
assert.equal('frames' in back[0],false,'HTTP entries carry no frames');
assert.equal(back[0].response.truncated,false);assert.equal(back[0].response.size,body.length,'a full body is complete');
// A body DevTools measured but left out keeps its size and is marked truncated, not invented.
const measured=fromHar({log:{entries:[{startedDateTime:'2026-09-08T10:00:00.000Z',time:1,request:{method:'POST',url:'https://big.test/u',headers:[],bodySize:4096},response:{status:200,headers:[],content:{size:5000000,mimeType:'video/mp4'}}}]}})[0];
assert.deepEqual([measured.response.size,measured.response.truncated,measured.response.base64,measured.request.size,measured.request.truncated],[5000000,true,'',4096,true]);
// WebSocket frames from DevTools' extension come back as frames for the core: text as text, binary as base64, seconds as milliseconds.
const wsBack=fromHar({log:{entries:[{startedDateTime:'2026-09-08T10:00:00.000Z',time:1,request:{method:'GET',url:'wss://ws.test/s',headers:[]},response:{status:101,headers:[],content:{}},_webSocketMessages:[{type:'send',time:1788000000.5,opcode:1,data:'hello'},{type:'receive',time:1788000001,opcode:2,data:Buffer.from([1,2,3]).toString('base64')},{type:'receive',opcode:7,data:'odd'}]}]}})[0];
assert.equal(wsBack.summary.status,101);
assert.deepEqual(wsBack.frames.map(f=>[f.direction,f.kind,f.time,Buffer.from(f.base64,'base64').toString('latin1')]),[['sent','TEXT',1788000000500,'hello'],['received','BINARY',1788000001000,'\x01\x02\x03'],['received','TEXT',Date.UTC(2026,8,8,10,0,0),'odd']]);
// The writer pages through the API oldest first, pins the newest id and streams valid JSON.
(async()=>{
  const details={9:{summary:{id:9,time:1000,method:'GET',url:'wss://example.test/live',status:101,elapsed_ms:3,size:0,error:null},request:{headers:[['upgrade','websocket']],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[],text:'',base64:'',size:0,complete:true,truncated:false}},7:json,8:{...image,summary:{id:8,time:0,method:'GET',url:'https://example.test/icon.png',status:200,elapsed_ms:5,size:png.length,error:null},request:{headers:[],text:'',base64:'',size:0,complete:true,truncated:false},response:{headers:[['content-type','image/png']],text:'',base64:png.toString('base64'),size:png.length,complete:true,truncated:false}}};
  const calls=[];
  const fetchJson=async request=>{
    calls.push(request);
    // One row per page regardless of the requested limit, so id-cursor paging and pinning are exercised.
    if(request.startsWith('traffic-page?q=')){const q=JSON.parse(decodeURIComponent(request.slice('traffic-page?q='.length)));assert.equal(q.sort,'id');assert.equal(q.order,'asc');assert.equal(q.status,'2');assert.equal(q.offset,0);const after=Math.max(0,...q.rules.filter(r=>r.field==='id'&&r.op==='gte').map(r=>Number(r.value)));const matched=[7,8,9].filter(id=>String(details[id].summary.status).startsWith(q.status)||details[id].summary.status===101).filter(id=>id>=after);return {rows:matched.slice(0,1).map(id=>details[id].summary),total:3,matched:matched.length,newest:9};}
    if(/^traffic\/9\/ws\?after=/.test(request)){const after=Number(request.split('=')[1]);const all=[{id:1,time:1500,direction:'sent',kind:'TEXT',text:'hi',base64:'aGk=',size:2,truncated:false},{id:2,time:1600,direction:'received',kind:'BINARY',text:'',base64:'AAH/',size:3,truncated:false},{id:3,time:1700,direction:'received',kind:'CLOSE',text:'1000 bye',base64:'',size:8,truncated:false}].filter(m=>m.id>after);return {messages:all.slice(0,2),total:3,state:'closed',error:null,older:false,more:all.length>2};}
    return details[Number(request.split('/')[1])];
  };
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'librium-har-')),'export.har');
  const count=await exportHar({fetchJson,query:{query:'',method:'',status:'2',traffic_type:'',rules:[]},file,redact:true});
  assert.equal(count,3);
  const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(parsed.log.version,'1.2');assert.equal(parsed.log.creator.name,'Librium');assert.equal(parsed.log.entries.length,3);
  assert.deepEqual(parsed.log.entries.map(e=>e.request.url),['https://api.example.test/v1/items?limit=5&q=a%20b','https://example.test/icon.png','wss://example.test/live']);
  assert.deepEqual(parsed.log.entries[2]._webSocketMessages.map(f=>[f.opcode,f.data]),[[1,'hi'],[2,'AAH/'],[8,'']],'socket frames are streamed in pages, oldest first, with real opcodes');
  assert.equal(parsed.log.entries[0].response.content.text,body);
  assert.equal(parsed.log.entries[0].request.headers.find(h=>h.name==='cookie').value,'«redacted»','the export honours the redaction flag');
  assert.ok(calls.some(call=>call.includes('%22before%22%3A9')),'later pages must be pinned to the newest id seen first');
  assert.ok(calls.some(call=>call.includes('%22field%22%3A%22id%22%2C%22op%22%3A%22gte%22%2C%22value%22%3A%228%22')),'pages advance by id cursor, not by offset');
  assert.ok(!fs.existsSync(file+'.part'),'the temporary file is renamed away');
  // A failure part-way must not leave a truncated document under the chosen name.
  const failing=path.join(path.dirname(file),'failing.har');fs.writeFileSync(failing,'previous export');
  await assert.rejects(exportHar({fetchJson:async request=>{if(request==='traffic/8')throw Error('API: 500');return fetchJson(request);},query:{query:'',method:'',status:'2',traffic_type:'',rules:[]},file:failing}),/API: 500/);
  assert.equal(fs.readFileSync(failing,'utf8'),'previous export','the earlier file survives a failed export');assert.ok(!fs.existsSync(failing+'.part'));
  // An exchange cleared while the export runs is skipped, not fatal.
  const skipped=await exportHar({fetchJson:async request=>{if(request==='traffic/8')throw Error('API: 404');return fetchJson(request);},query:{query:'',method:'',status:'2',traffic_type:'',rules:[]},file:path.join(path.dirname(file),'skipped.har')});
  assert.equal(skipped,2);
  fs.rmSync(path.dirname(file),{recursive:true});
  console.log('HAR smoke OK: decoded gzip JSON, cookies, base64 binaries, WebSocket frames, paged streaming export');
})().catch(error=>{console.error(error);process.exitCode=1;});
