// Decode a custom binary header in the real renderer without changing archived bytes.
process.env.LIBRIUM_ATTACH_ONLY='1';
const {app,dialog,clipboard}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const profile=fs.mkdtempSync(path.resolve('target','ws-decode-offset-'));app.setPath('userData',profile);
const savedPath=path.join(profile,'source.bin');let copied='';clipboard.writeText=value=>{copied=value;};
dialog.showSaveDialog=async()=>({canceled:false,filePath:savedPath});dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
const timer=setTimeout(()=>{console.error('WS decode offset integration timed out');app.exit(1);},20000),pause=()=>new Promise(resolve=>setTimeout(resolve,25));
app.on('browser-window-created',(_event,window)=>{
 window.hide();window.webContents.setBackgroundThrottling(false);
 window.webContents.once('did-finish-load',async()=>{
  try{
   const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1];
   const ingest=async body=>{const response=await fetch('http://127.0.0.1:3000/api/capture',{method:'POST',headers:{'x-librium-token':token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
   const marker='decode-offset-'+Date.now(),payload={headers:[],text:'',base64:'',size:0,complete:true,truncated:false};
   const {id}=await ingest({event:'exchange',websocket:true,exchange:{summary:{id:0,time:Date.now(),method:'GET',url:'wss://fixture.invalid/'+marker,status:101,elapsed_ms:0,size:0,error:null},request:payload,response:payload}});
   const header=Buffer.from([0xc1,0xff,0,0x7f]),body=Buffer.from('81a56576656e74a470696e67','hex'),packed=Buffer.concat([header,body,Buffer.from([0xde,0xad,0xbe,0xef])]);
   for(const [bytes,truncated]of [[packed,false],[Buffer.concat([header,Buffer.from('0802','hex')]),false],[packed,true],[Buffer.alloc(0),false],[Buffer.alloc(8,255),false]]){
    await ingest({event:'message',id,message:{time:Date.now(),direction:'sent',kind:'BINARY',text:'',base64:bytes.toString('base64'),size:bytes.length+(truncated?100:0),truncated}});
   }
   await ingest({event:'end',id,error:null});
   const page=await(await fetch(`http://127.0.0.1:3000/api/traffic/${id}/ws`,{headers:{'x-librium-token':token}})).json();
   const ids=page.messages.map(message=>message.id),run=script=>window.webContents.executeJavaScript(script);
   const reach=async(script,label)=>{for(let n=0;n<120;n++){if(await run(script))return;await pause();}throw Error('Timed out: '+label);};
   const format=async value=>run(`{const input=document.querySelector('#ws-inspector-format');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change'));}`);
   const decode=async value=>run(`{const input=document.querySelector('#ws-inspector-decode-offset');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));document.querySelector('#ws-inspector-decode-apply').click();}`);
   const length=async value=>run(`{const input=document.querySelector('#ws-inspector-decode-length');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));document.querySelector('#ws-inspector-decode-apply').click();}`);
   const open=async index=>{await run(`document.querySelector('.ws-message[data-message-id="${ids[index]}"] .ws-message-open').click()`);await reach(`document.querySelector('#ws-inspector-meta').textContent.includes('сохранено')`,'loaded inspector');};
   const close=()=>run(`document.querySelector('#ws-inspector-close').click()`);
   await run(`{const input=document.querySelector('#filter');input.value=${JSON.stringify(marker)};input.dispatchEvent(new Event('input'));}`);
   await reach(`Boolean(document.querySelector('[data-id="${id}"]'))`,'history row');await run(`document.querySelector('[data-id="${id}"]').click()`);
   await reach(`document.querySelectorAll('.ws-message-open').length===5`,'message cards');await open(0);await format('msgpack');
   assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/Зарезервированный/);
   await decode('65536');assert.equal(await run(`document.querySelector('#ws-inspector-decode-offset').getAttribute('aria-invalid')`),'true');
   await decode('0x4');assert.equal(await run(`document.querySelector('#ws-inspector-decode-offset').getAttribute('aria-invalid')`),'false');
   assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/Лишние байты/);
   await length('0');assert.equal(await run(`document.querySelector('#ws-inspector-decode-length').getAttribute('aria-invalid')`),'true');
   await length('0xc');assert.equal(await run(`document.querySelector('#ws-inspector-decode-length').getAttribute('aria-invalid')`),'false');
   assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/"event": "ping"/);assert.match(await run(`document.querySelector('#ws-inspector-state').textContent`),/с байта 4/);
   assert.match(await run(`document.querySelector('#ws-inspector-state').textContent`),/заданный диапазон: 12 Б/);
   await run(`document.querySelector('#ws-inspector-copy').click()`);for(let n=0;n<100&&!copied;n++)await pause();assert.equal(JSON.parse(copied).event,'ping');
   await run(`document.querySelector('#ws-inspector-save').click()`);for(let n=0;n<100&&!fs.existsSync(savedPath);n++)await pause();assert.deepEqual(fs.readFileSync(savedPath),packed);
   await run(`document.querySelector('#ws-inspector-values summary').click()`);
   const numeric=(type,endian)=>run(`document.querySelector('[data-numeric-type="${type}"] [data-endian="${endian}"]').textContent`);
   assert.equal(await numeric('uint8','le'),'193');assert.equal(await numeric('uint64','le'),packed.readBigUInt64LE(0).toString());
   await run(`{const input=document.querySelector('#ws-inspector-offset');input.value='4';input.dispatchEvent(new Event('input'));document.querySelector('#ws-inspector-go').click();}`);
   assert.equal(await numeric('uint8','le'),'129');assert.match(await run(`document.querySelector('#ws-inspector-values-title').textContent`),/байта 4 /);
   await run(`document.querySelector('#ws-inspector-values summary').click()`);
   await format('hex');assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/c1 ff 00 7f 81/);await format('msgpack');
   window.setSize(1100,800);await pause();assert.equal(await run(`document.querySelector('#ws-inspector-content').clientHeight>=80`),true);
   await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);fs.writeFileSync('target/ws-decode-offset-preview.png',(await window.webContents.capturePage()).toPNG());
   await close();await open(1);assert.equal(await run(`document.querySelector('#ws-inspector-decode-offset').value`),'0');assert.equal(await run(`document.querySelector('#ws-inspector-decode-length').value`),'');await format('protobuf');await decode('4');await length('2');assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/"offset": 0/);assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/"value": "2"/);
   await close();await open(2);await format('msgpack');await decode('4');assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/сохранено не полностью/);
   await length('12');assert.match(await run(`document.querySelector('#ws-inspector-content').textContent`),/"event": "ping"/);assert.match(await run(`document.querySelector('#ws-inspector-state').textContent`),/исходное сообщение сохранено частично/);assert.match(await run(`document.querySelector('#ws-inspector-meta').textContent`),/только фрагмент/);
   await close();await open(3);assert.equal(await run(`document.querySelector('#ws-inspector-decode-apply').disabled`),true);assert.equal(await run(`document.querySelector('#ws-inspector-decode-offset').disabled`),true);
   assert.match(await run(`document.querySelector('#ws-inspector-values-body').textContent`),/Нет сохранённых байтов/);
   await close();await open(4);assert.equal(await run(`document.querySelector('#ws-inspector-values').open`),false);
   await run(`document.querySelector('#ws-inspector-values summary').click()`);
   assert.equal(await numeric('uint64','le'),'18446744073709551615');assert.equal(await numeric('uint64','be'),'18446744073709551615');assert.equal(await numeric('int64','le'),'-1');assert.equal(await numeric('float64','be'),'NaN');
   await run(`document.querySelector('#ws-inspector-values-copy').click()`);for(let n=0;n<100&&!copied.includes('uint64');n++)await pause();assert.match(copied,/uint64\t18446744073709551615\t18446744073709551615/);
   await run(`document.querySelector('#ws-inspector-values-body').scrollTop=140;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);fs.writeFileSync('target/ws-numeric-values-preview.png',(await window.webContents.capturePage()).toPNG());
   await run(`{const input=document.querySelector('#ws-inspector-offset');input.value='7';input.dispatchEvent(new Event('input'));document.querySelector('#ws-inspector-go').click();}`);assert.equal(await numeric('uint8','le'),'255');assert.equal(await numeric('uint16','le'),'—');assert.equal(await numeric('uint64','be'),'—');
   console.log('PASS: native numeric values follow original-byte offsets, preserve uint64 precision / signed / NaN values, copy exact strings, reset per message and reject missing tail bytes');
   const source=await run(`window.librium.request('traffic/${id}/ws/${ids[0]}')`);assert.equal(source.base64,packed.toString('base64'));
   console.log('PASS: native binary decode ranges, invalid-input correction, header / trailer exclusion, MessagePack / Protobuf, unchanged source save / Hex, copied view, reset and partial-source labels');
   clearTimeout(timer);app.quit();
  }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
 });
});
require('../desktop/main.cjs');
