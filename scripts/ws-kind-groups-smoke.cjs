// Actual sandboxed renderer + authenticated Rust history; synthetic traffic only.
process.env.LIBRIUM_ATTACH_ONLY='1';
const {app,dialog}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const profile=fs.mkdtempSync(path.resolve('target','ws-kind-groups-'));app.setPath('userData',profile);
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
const timeout=setTimeout(()=>{console.error('WS kind groups integration timed out');app.exit(1);},20000);
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
app.on('browser-window-created',(_event,window)=>{
 window.hide();window.webContents.setBackgroundThrottling(false);
 window.webContents.once('did-finish-load',async()=>{
  try{
   const html=await(await fetch('http://127.0.0.1:3000/')).text(),token=html.match(/const token\s*=\s*'([^']+)'/)[1];
   const ingest=async body=>{const response=await fetch('http://127.0.0.1:3000/api/capture',{method:'POST',headers:{'x-librium-token':token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
   const marker='kind-groups-'+Date.now(),payload={headers:[],text:'',base64:'',size:0,complete:true,truncated:false};
   const {id}=await ingest({event:'exchange',websocket:true,exchange:{summary:{id:0,time:Date.now(),method:'GET',url:'wss://fixture.invalid/'+marker,status:101,elapsed_ms:0,size:0,error:null},request:payload,response:payload}});
   const message=async(kind,direction,bytes)=>ingest({event:'message',id,message:{time:Date.now(),direction,kind,text:kind==='BINARY'?'':bytes.toString(),base64:bytes.toString('base64'),size:bytes.length,truncated:false}});
   await message('TEXT','sent',Buffer.from('2')); // Engine.IO heartbeat is still a TEXT data frame.
   await message('BINARY','received',Buffer.from('{"needle":"Привет"}'));
   for(let n=0;n<120;n++){await message('PING','sent',Buffer.from([0,255,n]));await message('PONG','received',Buffer.from([0,255,n]));}
   await message('CLOSE','received',Buffer.from([3,232]));await ingest({event:'end',id,error:null,close:{code:1000,reason:''}});
   const run=script=>window.webContents.executeJavaScript(script);
   const reach=async(script,label)=>{for(let n=0;n<120;n++){if(await run(script))return;await pause();}throw Error('Timed out: '+label);};
   const select=async(element,value)=>run(`{const input=document.getElementById(${JSON.stringify(element)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change'));}`);
   const count=()=>run(`document.querySelectorAll('.ws-message').length`);
   const notice=()=>run(`document.querySelector('.pane .notice').textContent`);
   await run(`{const input=document.querySelector('#filter');input.value=${JSON.stringify(marker)};input.dispatchEvent(new Event('input'));}`);
   await reach(`Boolean(document.querySelector('[data-id="${id}"]'))`,'history row');await run(`document.querySelector('[data-id="${id}"]').click()`);
   await select('ws-layout','timeline');
   await reach(`document.querySelectorAll('.ws-message').length===100`,'latest control page');
   await select('ws-kind','DATA');await reach(`document.querySelectorAll('.ws-message').length===2`,'old data behind controls');
   assert.match(await notice(),/2 \/ 243/);assert.match(await run(`document.querySelector('#panes').textContent`),/Engine.IO/);
   assert.equal(await run(`Array.from(document.querySelectorAll('.ws-message')).every(row=>/ TEXT ·| BINARY ·/.test(row.textContent))`),true);
   await select('ws-kind','CONTROL');await reach(`document.querySelectorAll('.ws-message').length===100`,'control group');assert.match(await notice(),/241 \/ 243/);
   const newest=await run(`Array.from(document.querySelectorAll('.ws-message')).map(row=>Number(row.dataset.messageId))`);
   await run(`document.querySelector('.pane .notice button').click()`);
   await reach(`Math.max(...Array.from(document.querySelectorAll('.ws-message')).map(row=>Number(row.dataset.messageId)))<${newest[0]}`,'older controls');
   assert.equal(await count(),100);
   await select('ws-direction','sent');await reach(`document.querySelector('.pane .notice').textContent.includes('120 / 243')`,'group and direction');
   assert.equal(await run(`Array.from(document.querySelectorAll('.ws-message')).every(row=>row.dataset.direction==='sent'&&row.textContent.includes(' PING ·'))`),true);
   await select('ws-kind','DATA');await reach(`document.querySelectorAll('.ws-message').length===1`,'cursor reset on group change');assert.match(await notice(),/1 \/ 243/);
   await select('ws-direction','received');await select('ws-search-format','utf8');
   await run(`{const input=document.querySelector('#ws-filter');input.value='привет';input.dispatchEvent(new Event('input'));}`);
   await reach(`document.querySelector('#panes').textContent.includes('Привет')`,'UTF-8 group search');assert.match(await notice(),/1 \/ 243/);
   await select('ws-search-format','hex');await run(`{const input=document.querySelector('#ws-filter');input.value='7b 22 6e 65 65 64 6c 65';input.dispatchEvent(new Event('input'));}`);
   await reach(`document.querySelector('#panes').textContent.includes('найдено @ 0x000000')`,'byte group search');
   const summary=await run(`window.librium.request('traffic/${id}/ws-summary')`);assert.equal(summary.total.count,243);
   await run(`{document.querySelector('#ws-filter').value='';document.querySelector('#ws-filter').dispatchEvent(new Event('input'));}`);
   await select('ws-search-format','text');await select('ws-direction','');await select('ws-kind','DATA');
   await reach(`document.querySelectorAll('.ws-message').length===2`,'both data directions');
   window.setSize(800,650);await pause();
   assert.equal(await run(`(()=>{const box=document.querySelector('#ws-tools').getBoundingClientRect();return Array.from(document.querySelectorAll('#ws-tools select,#ws-tools button,#ws-filter')).every(node=>{if(node.hidden)return true;const r=node.getBoundingClientRect();return r.left>=box.left&&r.right<=box.right+1;});})()`),true,'filters must fit narrow window');
   assert.equal(await run(`document.querySelector('.pane .content').clientHeight>=100`),true,'wrapped filters must not collapse message content');
   await run(`document.querySelector('.pane .content').scrollIntoView({block:'nearest'})`);
   assert.equal(await run(`(()=>{const content=document.querySelector('.pane .content').getBoundingClientRect(),box=document.querySelector('.inspector').getBoundingClientRect();return content.top>=box.top&&content.bottom<=box.bottom+1;})()`),true,'message body must be reachable through inspector scrolling');
   await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   fs.writeFileSync('target/ws-kind-groups-preview.png',(await window.webContents.capturePage()).toPNG());
   console.log('PASS: grouped DATA / CONTROL filters in real renderer, old data behind controls, pagination, cursor reset, direction, UTF-8 / byte search, Engine.IO TEXT and narrow layout');
   clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
 });
});
require('../desktop/main.cjs');
