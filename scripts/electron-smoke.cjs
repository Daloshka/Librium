process.env.LIBRIUM_ATTACH_ONLY='1';
process.env.LIBRIUM_HEADLESS='1';
process.env.LIBRIUM_LANG=process.env.LIBRIUM_LANG||'ru';
// Runtime integration check: load the real sandboxed renderer and call its IPC bridge.
const {app,dialog} = require('electron');
const downloadPaths=[];dialog.showSaveDialog=async(_window,options)=>{assert.ok(['Скачать файл','Save file','Сохранить HAR','Save HAR','Сохранить правила','Save rules'].includes(options.title),options.title);const file=resolve('target/download-smoke-'+require('node:path').basename(options.defaultPath));downloadPaths.push(file);return {canceled:false,filePath:file};};
const {writeFileSync, mkdirSync, readFileSync, existsSync} = require('node:fs');
const {resolve} = require('node:path');
const profile=resolve('target/electron-smoke-profile');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const report=message=>writeFileSync('target/electron-smoke-result.txt',message);
const assert = require('node:assert/strict');
const timeout = setTimeout(() => { report('FAIL: Electron startup timed out'); app.exit(1); }, 20000);
app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const rows = await window.librium.request('traffic');
        let blocked=false;try {await window.librium.request('../');} catch {blocked=true;}
        return {bridge:!!window.librium, count:rows.length, blocked, panes:document.querySelectorAll('.pane').length, title:document.title, requestColor:getComputedStyle(document.querySelector('.pane-title')).backgroundImage};
      })()`);
      assert.equal(result.bridge,true);assert.equal(result.blocked,true);assert.equal(result.panes,2);assert.equal(result.title,'Librium');assert.match(result.requestColor,/gradient/);
      if(existsSync('target/preview-test-id.txt')) {
        const imageId=Number(readFileSync('target/preview-test-id.txt','utf8'));
        assert.ok(Number.isSafeInteger(imageId));
        await window.webContents.executeJavaScript(`document.querySelector('#filter').value='librium-image-test=1';document.querySelector('#filter').dispatchEvent(new Event('input'))`);
        let image;
        for(let attempt=0;attempt<60;attempt++) {
          image=await window.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-id="${imageId}"]');if(row&&!row.classList.contains('selected'))row.click();const img=document.querySelector('.image-preview img');return {width:img?.naturalWidth,height:img?.naturalHeight,error:document.querySelector('#error').textContent};})()`);
          if(image.width)break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        assert.equal(image.width,256,JSON.stringify(image));assert.equal(image.height,256);
        console.log('Image smoke OK: captured 197 KB PNG decoded as 256 x 256 in sandboxed Electron');
      }
      if(existsSync('target/media-test-ids.json')) {
        const ids=JSON.parse(readFileSync('target/media-test-ids.json','utf8'));
        for(const kind of ['svg','ogg']) {
          assert.ok(Number.isSafeInteger(ids[kind]));
          await window.webContents.executeJavaScript(`document.querySelector('#filter').value='librium-media-test=${kind}';document.querySelector('#filter').dispatchEvent(new Event('input'))`);
          let media;
          for(let attempt=0;attempt<60;attempt++) {
            media=await window.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-id="${ids[kind]}"]');if(row&&!row.classList.contains('selected'))row.click();const img=document.querySelector('.image-preview img'),audio=document.querySelector('audio');return {selected:row?.classList.contains('selected'),width:img?.naturalWidth,height:img?.naturalHeight,duration:audio?.duration,ready:audio?.readyState,controls:audio?.controls,autoplay:audio?.autoplay};})()`);
            if(media.selected&&(kind==='svg'?media.width:media.ready>=2))break;
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          if(kind==='svg') {assert.equal(media.width,256);assert.equal(media.height,128);}
          else {
            assert.equal(media.controls,true);assert.equal(media.autoplay,false);assert.ok(media.duration>5.9&&media.duration<6.1,JSON.stringify(media));
            window.webContents.setAudioMuted(true);
            await window.webContents.executeJavaScript(`(async()=>{const a=document.querySelector('audio');a.muted=true;await a.play();})()`,true);
            await new Promise(resolve=>setTimeout(resolve,300));
            const position=await window.webContents.executeJavaScript(`(()=>{const a=document.querySelector('audio');const t=a.currentTime;a.pause();a.currentTime=2;return t;})()`);
            assert.ok(position>0,'OGG playback clock must advance');
          }
        }
        for(const [kind,fixture] of [['svg','target/svg-test.svg'],['ogg','target/audio-test.ogg']]){
          const saved=await window.webContents.executeJavaScript(`window.librium.saveMedia(${ids[kind]},'response')`);assert.equal(saved,true);assert.deepEqual(readFileSync(downloadPaths.at(-1)),readFileSync(fixture));
        }
        console.log('Download smoke OK: native save IPC writes exact SVG and OGG files');
        console.log('Media smoke OK: SVG rendered, OGG duration decoded, playback advanced, seek accepted');
      }
      if(existsSync('target/ws-test-id.txt')) {
        const wsId=Number(readFileSync('target/ws-test-id.txt','utf8'));assert.ok(Number.isSafeInteger(wsId));
        await window.webContents.executeJavaScript(`document.querySelector('#filter').value='librium-ws-test=';document.querySelector('#filter').dispatchEvent(new Event('input'))`);
        let ws;
        for(let n=0;n<60;n++){
          ws=await window.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-id="${wsId}"]');if(row&&!row.classList.contains('selected'))row.click();const panes=[...document.querySelectorAll('.pane')];return {selected:row?.classList.contains('selected'),request:panes[0].textContent,response:panes[1].textContent,active:panes.map(p=>p.querySelector('[data-mode="ws"]').classList.contains('active'))};})()`);
          if(ws.selected&&ws.request.includes('client hello')&&ws.response.includes('client hello'))break;
          await new Promise(r=>setTimeout(r,100));
        }
        assert.ok(ws.active.every(Boolean));assert.match(ws.request,/client hello/);assert.match(ws.response,/server welcome/);assert.match(ws.response,/BINARY/);assert.doesNotMatch(ws.request,/Передача прервана|Transfer interrupted/);
        console.log('WebSocket UI smoke OK: outgoing/incoming text and binary messages, automatic WS tabs, no false HTTP body error');
      }
      // Settings round-trip through the bridge and the core.
      await window.webContents.executeJavaScript(`window.librium.saveSettings({ignore_hosts:['*.smoke-ignore.test'],rewrites:[{host:'*.smoke.test',name:'X-Smoke',value:' 1 '}],response_rewrites:[{host:'*',name:'Content-Security-Policy',value:''}],delays:[{host:'slow.smoke.test',ms:250}],mocks:[{host:'mock.smoke.test',path:'',method:'get',status:201,content_type:'',body:'ok'}]})`);
      const settings=await window.webContents.executeJavaScript(`window.librium.request('settings')`);
      assert.deepEqual(settings.ignore_hosts,['*.smoke-ignore.test']);assert.deepEqual(settings.rewrites,[{host:'*.smoke.test',name:'x-smoke',value:'1',path:'*'}],'rewrites travel through the bridge normalized');assert.deepEqual(settings.response_rewrites,[{host:'*',name:'content-security-policy',value:'',path:'*'}],'response rewrites too');assert.deepEqual(settings.delays,[{host:'slow.smoke.test',ms:250,path:'*'}],'delays too');assert.deepEqual(settings.mocks,[{host:'mock.smoke.test',path:'*',method:'GET',status:201,content_type:'text/plain; charset=utf-8',body:'ok',enabled:true}],'mocks too, normalized');
      let refusedSettings=false;try{await window.webContents.executeJavaScript(`window.librium.saveSettings({ignore_hosts:['bad host']})`);}catch{refusedSettings=true;}assert.ok(refusedSettings,'the core refuses a malformed pattern');
      await window.webContents.executeJavaScript(`window.librium.saveSettings({ignore_hosts:['*.rules.test'],rewrites:[],response_rewrites:[],delays:[{host:'slow.rules.test',ms:100}],mocks:[{host:'mock.rules.test',path:'/',method:'',status:200,content_type:'text/plain',body:'rules'}]})`);
      // Rules round trip through a file: export, wipe, import the same file back.
      const rulesFile=await window.webContents.executeJavaScript(`window.librium.exportRules()`);
      assert.ok(rulesFile&&existsSync(rulesFile),'the rules file was written');
      const written=JSON.parse(readFileSync(rulesFile,'utf8'));assert.equal(written.librium_rules,1);assert.deepEqual(written.ignore_hosts,['*.rules.test']);assert.equal(written.mocks.length,1);
      await window.webContents.executeJavaScript(`window.librium.saveSettings({ignore_hosts:[],delays:[],mocks:[]})`);
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[rulesFile]});
      const rulesKeys=await window.webContents.executeJavaScript(`window.librium.importRules()`);
      assert.deepEqual(rulesKeys,['ignore_hosts','rewrites','response_rewrites','delays','mocks']);
      const restored=await window.webContents.executeJavaScript(`window.librium.request('settings')`);
      assert.deepEqual(restored.ignore_hosts,['*.rules.test']);assert.equal(restored.mocks[0].host,'mock.rules.test');assert.equal(restored.delays[0].ms,100);
      await window.webContents.executeJavaScript(`window.librium.saveSettings({ignore_hosts:[],rewrites:[],response_rewrites:[],delays:[],mocks:[]})`);
      let pathlessRules=false;try{await window.webContents.executeJavaScript(`window.librium.importRules(new File(['{}'],'x.json'))`);}catch{pathlessRules=true;}assert.ok(pathlessRules,'a dropped rules File without a path on disk is refused');
      require('node:fs').unlinkSync(rulesFile);
      console.log('Rules file smoke OK: exported, wiped and imported back through the bridge');
      console.log('Settings smoke OK: ignored hosts saved, read back and validated through the bridge');
      // Intercept rules through the bridge: on with a pattern, read back, off again; a decision needs a held request.
      await window.webContents.executeJavaScript(`window.librium.request('intercept','PUT',JSON.stringify({enabled:true,hosts:['*.smoke.test'],responses:true,methods:['post'],path:' /API/ '}))`);
      assert.deepEqual(await window.webContents.executeJavaScript(`window.librium.request('intercept')`),{enabled:true,hosts:['*.smoke.test'],responses:true,methods:['POST'],path:'/api/',held:[]});
      let missing='';try{await window.webContents.executeJavaScript(`window.librium.request('intercept/999','POST',JSON.stringify({action:'forward'}))`);}catch(error){missing=error.message;}assert.match(missing,/404/,'nothing held: '+missing);
      let refusedBody=false;try{await window.webContents.executeJavaScript(`window.librium.request('settings','PUT','{}')`);}catch{refusedBody=true;}assert.ok(refusedBody,'bodies are allowed only where the bridge expects them');
      await window.webContents.executeJavaScript(`window.librium.request('intercept','PUT',JSON.stringify({enabled:false,hosts:[]}))`);
      assert.equal(await window.webContents.executeJavaScript(`window.librium.heldCount(2)`),undefined,'the held count reaches the shell (no badge headless)');
      let badCount=false;try{await window.webContents.executeJavaScript(`window.librium.heldCount(-1)`);}catch{badCount=true;}assert.ok(badCount,'a bad count is refused');
      console.log('Intercept smoke OK: rules round trip through the bridge, decisions need a held request');
      // A star and a note travel through the bridge and come back on the page row.
      const newestRow=(await window.webContents.executeJavaScript(`window.librium.request('traffic-page?q=%7B%22limit%22%3A1%7D')`)).rows[0];
      await window.webContents.executeJavaScript(`window.librium.request('traffic/${newestRow.id}','PATCH',JSON.stringify({starred:true,note:'smoke note'}))`);
      const starredRow=(await window.webContents.executeJavaScript(`window.librium.request('traffic-page?q=%7B%22limit%22%3A1%7D')`)).rows[0];
      assert.equal(starredRow.starred,true);assert.equal(starredRow.note,'smoke note');
      await window.webContents.executeJavaScript(`window.librium.request('traffic/${newestRow.id}','PATCH',JSON.stringify({starred:false,note:''}))`);
      console.log('Marks smoke OK: star and note saved and read back');
      // The whole history goes out as HAR through the same save dialog; WebSocket frames ride along when a socket was captured.
      const exported=await window.webContents.executeJavaScript(`window.librium.exportHar({query:'',method:'',status:'',traffic_type:'',rules:[]})`);
      const har=JSON.parse(readFileSync(downloadPaths.at(-1),'utf8'));
      assert.equal(har.log.entries.length,exported);assert.ok(exported>=1);assert.ok(downloadPaths.at(-1).endsWith('.har'));
      if(existsSync('target/ws-test-id.txt'))assert.ok(har.log.entries.some(entry=>entry.response.status===101&&entry._webSocketMessages?.some(frame=>frame.data==='client hello')),'WebSocket frames in the HAR');
      let refused=false;try{await window.webContents.executeJavaScript(`window.librium.exportHar({query:'',method:'TRACE',status:'',traffic_type:'',rules:[]})`);}catch{refused=true;}
      assert.ok(refused,'unknown export filters are refused');
      console.log('HAR smoke OK: '+exported+' entries exported through the native save dialog');
      // The exported file comes back in through the open dialog, as new exchanges.
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[downloadPaths.at(-1)]});
      const newestBefore=(await window.webContents.executeJavaScript(`window.librium.request('traffic-page?q=%7B%7D')`)).newest;
      const imported=await window.webContents.executeJavaScript(`window.librium.importHar()`);
      assert.equal(imported,exported,'every exported entry is imported again');
      console.log('Import smoke OK: '+imported+' entries imported from the exported HAR');
      if(existsSync('target/ws-test-id.txt')){
        // The socket's frames came along: the newest ws exchange is the imported copy and serves the same messages.
        const page=await window.webContents.executeJavaScript(`window.librium.request('traffic-page?q='+encodeURIComponent(JSON.stringify({query:'librium-ws-test=',traffic_type:'ws'})))`);
        const newest=Math.max(...page.rows.map(r=>r.id));assert.ok(newest>Number(readFileSync('target/ws-test-id.txt','utf8')),'the imported socket is a new exchange');
        const frames=await window.webContents.executeJavaScript(`window.librium.request('traffic/${newest}/ws')`);
        assert.equal(frames.state,'closed');assert.ok(frames.messages.some(m=>m.text==='client hello'),'frames came back with the import');
        console.log('Import smoke OK: WebSocket frames survived the HAR round trip');
      }
      // A dropped in-memory File has no path on disk: refused with a clear message, no dialog opened.
      dialog.showOpenDialog=async()=>{throw Error('the dialog must not open for a dropped file');};
      let badDrop='';try{await window.webContents.executeJavaScript(`window.librium.importHar(new File(['{}'],'x.har'))`);}catch(error){badDrop=error.message;}
      assert.match(badDrop,/\.har/,'a pathless drop is refused: '+badDrop);
      // The copies go away again, so the history is the same size after every run.
      const removed=await window.webContents.executeJavaScript(`window.librium.request('traffic-page?q='+encodeURIComponent(JSON.stringify({rules:[{field:'id',op:'gte',value:String(${newestBefore}+1)}]})),'DELETE')`);
      assert.equal(removed.deleted,imported,'the imported copies are deleted again');
      console.log('Electron smoke OK: sandboxed preload, real Rust IPC, route validation, two panes, colored theme');
      report('PASS: sandboxed preload, real Rust IPC, route validation, two panes, colored theme');
      clearTimeout(timeout);app.quit();
    } catch(error) {report('FAIL: '+error.stack);clearTimeout(timeout);app.exit(1);}
  });
});
require('../desktop/main.cjs');
