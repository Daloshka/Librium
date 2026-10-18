process.env.LIBRIUM_ATTACH_ONLY='1';
const {app,dialog,clipboard}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),z=require('node:zlib');
const profile=fs.mkdtempSync(path.resolve('target','ws-inflate-'));app.setPath('userData',profile);let copied='';clipboard.writeText=text=>{copied=text;};const save=path.join(profile,'source.bin');
const unpackedPath=path.join(profile,'unpacked.bin');fs.writeFileSync(unpackedPath,'preserve cancellation');let unpackedTarget=unpackedPath,unpackedSaves=0;const unpackedNames=[];dialog.showSaveDialog=async(_window,options)=>{if(options.title==='Сохранить распакованные байты'){unpackedNames.push(path.basename(options.defaultPath));return ++unpackedSaves===1?{canceled:true}:{canceled:false,filePath:unpackedTarget};}return {canceled:false,filePath:save};};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
const timer=setTimeout(()=>{console.error('WS inflate integration timed out');app.exit(1);},25000),pause=()=>new Promise(resolve=>setTimeout(resolve,25));
app.on('browser-window-created',(_event,window)=>{window.hide();window.webContents.setBackgroundThrottling(false);window.webContents.once('did-finish-load',async()=>{
 try{
  const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1],headers={'x-librium-token':token};
  const ingest=async body=>{const response=await fetch('http://127.0.0.1:3000/api/capture',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  const marker='inflate-'+Date.now(),payload={headers:[],text:'',base64:'',size:0,complete:true,truncated:false};
  const exchange=async suffix=>(await ingest({event:'exchange',websocket:true,exchange:{summary:{id:0,time:Date.now(),method:'GET',url:'wss://fixture.invalid/'+marker+suffix,status:101,elapsed_ms:0,size:0,error:null},request:payload,response:payload}})).id;
  const id=await exchange(''),otherId=await exchange('-other'),json=Buffer.from('{"decoded":"<img src=x>","ok":true}'),pack=Buffer.from('81a56576656e74aa636f6d70726573736564','hex'),compressed=z.deflateSync(pack),framed=Buffer.concat([Buffer.from([0xff,0]),compressed,Buffer.from([0xee,0xff])]);
  const corrupt=z.gzipSync(json);corrupt[corrupt.length-3]^=1;
  const cases=[
   {codec:'gzip',wire:z.gzipSync(json),raw:json},
   {codec:'zlib',wire:framed,raw:pack,offset:2,length:compressed.length},
   {codec:'deflate',wire:z.deflateRawSync(Buffer.from('0802','hex')),raw:Buffer.from('0802','hex')},
   {codec:'gzip',wire:Buffer.concat([Buffer.from([0xaa]),z.gzipSync(json)]),raw:json,offset:1,length:z.gzipSync(json).length,partial:true},
   {codec:'gzip',wire:z.gzipSync(Buffer.alloc(65537)),bad:true},
   {codec:'gzip',wire:corrupt,bad:true},
   {codec:'gzip',wire:Buffer.concat([z.gzipSync(Buffer.from('one')),z.gzipSync(Buffer.from('two'))]),raw:Buffer.from('onetwo')},
   {codec:'gzip',wire:z.gzipSync(Buffer.alloc(0)),raw:Buffer.alloc(0)},
   {codec:'zlib',wire:Buffer.concat([z.deflateSync(json),Buffer.from([255])]),bad:true},
   {codec:'gzip',wire:Buffer.from('hello'),kind:'TEXT',bad:true},
   {codec:'zlib',wire:z.deflateSync(Buffer.alloc(65536,42)),raw:Buffer.alloc(65536,42)}
  ];
  for(const item of cases)await ingest({event:'message',id,message:{time:Date.now(),direction:'sent',kind:item.kind||'BINARY',text:item.kind==='TEXT'?'hello':'',base64:item.wire.toString('base64'),size:item.wire.length+(item.partial?100:0),truncated:Boolean(item.partial)}});
  await ingest({event:'end',id,error:null});
  const route=`http://127.0.0.1:3000/api/traffic/${id}/ws`,page=await(await fetch(route,{headers})).json();cases.forEach((item,index)=>item.id=page.messages[index].id);
  const suffix=item=>`?codec=${item.codec}&offset=${item.offset||0}${item.length?'&length='+item.length:''}`;
  for(const item of cases){const response=await fetch(`${route}/${item.id}/inflate${suffix(item)}`,{headers});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ok,!item.bad);if(item.raw)assert.deepEqual(Buffer.from(result.base64,'base64'),item.raw);}
  for(const query of ['?codec=brotli','?codec=gzip&length=0','?codec=gzip&length=65537','?codec=gzip&offset=65536','?codec=gzip&file=arbitrary'])assert.equal((await fetch(`${route}/${cases[0].id}/inflate${query}`,{headers})).status,400);
  assert.equal((await fetch(`${route}/${cases[0].id}/inflate?codec=gzip`)).status,401);
  assert.equal((await fetch(`http://127.0.0.1:3000/api/traffic/${otherId}/ws/${cases[0].id}/inflate?codec=gzip`,{headers})).status,404);
  assert.equal((await fetch(`${route}/0/inflate?codec=gzip`,{headers})).status,400);
  const partial=await(await fetch(`${route}/${cases[3].id}/inflate?codec=gzip&offset=1`,{headers})).json();assert.equal(partial.ok,false);
  const run=script=>window.webContents.executeJavaScript(script),reach=async(script,label)=>{for(let n=0;n<120;n++){if(await run(script))return;await pause();}throw Error('Timed out: '+label);};
  await run(`{const input=document.querySelector('#filter');input.value=${JSON.stringify(marker)};input.dispatchEvent(new Event('input'));}`);
  await reach(`Boolean(document.querySelector('[data-id="${id}"]'))`,'history row');await run(`document.querySelector('[data-id="${id}"]').click()`);await reach(`document.querySelectorAll('.ws-message-open').length===${cases.length}`,'messages');
  const open=async index=>{await run(`document.querySelector('.ws-message[data-message-id="${cases[index].id}"] .ws-message-open').click()`);await reach(`document.querySelector('#ws-inspector-meta').textContent.includes('сохранено')`,'inspector');};
  const inflate=async(index,format='pretty',explicit=true)=>{const item=cases[index];await run(`{document.querySelector('#ws-inspector-format').value=${JSON.stringify(format)};document.querySelector('#ws-inspector-format').dispatchEvent(new Event('change'));document.querySelector('#ws-inflate-codec').value=${JSON.stringify(item.codec)};document.querySelector('#ws-inspector-decode-offset').value=${JSON.stringify(String(item.offset||0))};document.querySelector('#ws-inspector-decode-length').value=${JSON.stringify(explicit&&item.length?String(item.length):'')};document.querySelector('#ws-inflate-open').click();}`);await reach(`!document.querySelector('#ws-inflate-copy').disabled||!document.querySelector('#ws-inflate-error').hidden`,'inflate result');};
  await open(0);await inflate(0);assert.match(await run(`document.querySelector('#ws-inflate-content').textContent`),/"decoded": "<img src=x>"/);assert.equal(await run(`document.querySelectorAll('#ws-inflate-content img').length`),0);
  await run(`document.querySelector('#ws-inflate-copy').click()`);for(let n=0;n<100&&!copied;n++)await pause();assert.equal(JSON.parse(copied).ok,true);
  await run(`document.querySelector('#ws-inflate-save').click()`);await reach(`!document.querySelector('#ws-inflate-save').disabled`,'cancelled save');assert.equal(fs.readFileSync(unpackedPath,'utf8'),'preserve cancellation');
  await run(`document.querySelector('#ws-inflate-save').click()`);await reach(`!document.querySelector('#ws-inflate-save').disabled`,'saved unpacked JSON');assert.deepEqual(fs.readFileSync(unpackedPath),json);assert.match(unpackedNames.at(-1),/unpacked-gzip-0-\d+\.bin$/);
  await run(`document.querySelector('#ws-inflate-close').click();document.querySelector('#ws-inspector-close').click()`);
  await open(1);await inflate(1,'msgpack');assert.match(await run(`document.querySelector('#ws-inflate-content').textContent`),/"event": "compressed"/);await run(`document.querySelector('#ws-inflate-save').click()`);await reach(`!document.querySelector('#ws-inflate-save').disabled`,'saved unpacked MessagePack');assert.deepEqual(fs.readFileSync(unpackedPath),pack);window.setSize(1100,800);await pause();await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);fs.writeFileSync('target/ws-inflate-preview.png',(await window.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#ws-inflate-close').click();document.querySelector('#ws-inspector-save').click()`);for(let n=0;n<100&&!fs.existsSync(save);n++)await pause();assert.deepEqual(fs.readFileSync(save),framed);await run(`document.querySelector('#ws-inspector-close').click()`);
  await open(2);await inflate(2,'protobuf');assert.match(await run(`document.querySelector('#ws-inflate-content').textContent`),/"value": "2"/);await run(`document.querySelector('#ws-inflate-close').click();document.querySelector('#ws-inspector-close').click()`);
  await open(3);await inflate(3,'pretty',false);assert.match(await run(`document.querySelector('#ws-inflate-error').textContent`),/частично/);await run(`document.querySelector('#ws-inflate-close').click()`);await inflate(3);assert.match(await run(`document.querySelector('#ws-inflate-meta').textContent`),/исходное сообщение сохранено частично/);await run(`document.querySelector('#ws-inspector-close').click()`);assert.equal(await run(`document.querySelector('#ws-inflate-dialog').open`),false);
  await open(4);await inflate(4);assert.match(await run(`document.querySelector('#ws-inflate-error').textContent`),/64 КиБ/);assert.equal(await run(`document.querySelector('#ws-inflate-copy').disabled`),true);
  const saveNative=async(index,exchangeId=id)=>run(`window.librium.saveWsInflated(${exchangeId},${cases[index].id},${JSON.stringify({codec:cases[index].codec,offset:cases[index].offset||0,length:cases[index].length||null})})`);
  assert.equal((await saveNative(7)).bytes,0);assert.equal(fs.statSync(unpackedPath).size,0);
  assert.equal((await saveNative(10)).bytes,65536);assert.deepEqual(fs.readFileSync(unpackedPath),cases[10].raw);
  const beforeFailure=fs.readFileSync(unpackedPath),beforeDialogs=unpackedSaves;
  for(const [index,exchangeId]of [[4,id],[0,otherId]]){let rejected=false;try{await saveNative(index,exchangeId);}catch{rejected=true;}assert.equal(rejected,true);}
  assert.equal(unpackedSaves,beforeDialogs);assert.deepEqual(fs.readFileSync(unpackedPath),beforeFailure);
  for(const bad of [{codec:'brotli',offset:0,length:null},{codec:'gzip',offset:65536,length:null},{codec:'gzip',offset:0,length:0}])assert.equal(await run(`window.librium.saveWsInflated(${id},${cases[0].id},${JSON.stringify(bad)}).then(()=>false,()=>true)`),true);
  unpackedTarget=profile;let writeFailed=false;try{await saveNative(0);}catch{writeFailed=true;}unpackedTarget=unpackedPath;assert.equal(writeFailed,true);assert.deepEqual(fs.readFileSync(unpackedPath),beforeFailure);assert.ok(!fs.readdirSync(path.dirname(profile)).some(name=>name.startsWith(path.basename(profile)+'.librium-')));
  const after=await(await fetch(route,{headers})).json();assert.deepEqual(after,page);
  console.log('PASS: authenticated / scoped bounded gzip, zlib, raw DEFLATE; checksums, partial / selected ranges, multi-member / empty / 64 KiB output, invalid query / bomb rejection, native JSON / MessagePack / Protobuf, safe rendering, copy and unchanged source save / archive');
  assert.equal((await fetch('http://127.0.0.1:3000/api/traffic',{method:'DELETE',headers})).status,204);const dialogsBeforeClear=unpackedSaves;let deletedRejected=false;try{await saveNative(0);}catch{deletedRejected=true;}assert.equal(deletedRejected,true);assert.equal(unpackedSaves,dialogsBeforeClear);assert.deepEqual(fs.readFileSync(unpackedPath),beforeFailure);
  const quitId=await exchange('-quit');await ingest({event:'message',id:quitId,message:{time:Date.now(),direction:'sent',kind:'BINARY',text:'',base64:cases[2].wire.toString('base64'),size:cases[2].wire.length,truncated:false}});await ingest({event:'end',id:quitId,error:null});const quitPage=await(await fetch(`http://127.0.0.1:3000/api/traffic/${quitId}/ws`,{headers})).json(),quitMessage=quitPage.messages[0].id;
  const writer=require('../desktop/ws-message-save.cjs'),originalWrite=writer.writePayload;let waiting=false,done=false,release;
  writer.writePayload=(...args)=>{waiting=true;return new Promise(resolve=>{release=resolve;}).then(()=>originalWrite(...args)).then(()=>{done=true;});};
  await run(`void window.librium.saveWsInflated(${quitId},${quitMessage},{codec:'deflate',offset:0,length:null}).catch(()=>{})`);for(let n=0;n<120&&!waiting;n++)await pause();assert.equal(waiting,true);
  assert.equal(await run(`window.librium.saveWsInflated(${quitId},${quitMessage},{codec:'deflate',offset:0,length:null}).then(()=>false,()=>true)`),true);
  app.once('before-quit',()=>setTimeout(()=>release(),100));app.once('will-quit',event=>{clearTimeout(timer);try{assert.equal(done,true);assert.deepEqual(fs.readFileSync(unpackedPath),cases[2].raw);assert.ok(!fs.readdirSync(profile).some(name=>name.includes('.librium-')));console.log('PASS: exact unpacked byte save, cancellation, empty / 64 KiB data, scope / input / stream rejection, write failure cleanup, concurrent save guard and quit waiting for atomic completion');}catch(error){console.error(error);event.preventDefault();app.exit(1);}});app.quit();

 }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
});});require('../desktop/main.cjs');
