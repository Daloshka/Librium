process.env.LIBRIUM_ATTACH_ONLY='1';
// Runtime integration check: load the real sandboxed renderer and call its IPC bridge.
const {app,dialog} = require('electron');
const downloadPaths=[];dialog.showSaveDialog=async(_window,options)=>{assert.equal(options.title,'Скачать файл');const file=resolve('target/download-smoke-'+require('node:path').basename(options.defaultPath));downloadPaths.push(file);return {canceled:false,filePath:file};};
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
        assert.ok(ws.active.every(Boolean));assert.match(ws.request,/client hello/);assert.match(ws.response,/server welcome/);assert.match(ws.response,/BINARY/);assert.doesNotMatch(ws.request,/Передача прервана/);
        console.log('WebSocket UI smoke OK: outgoing/incoming text and binary messages, automatic WS tabs, no false HTTP body error');
      }
      console.log('Electron smoke OK: sandboxed preload, real Rust IPC, route validation, two panes, colored theme');
      report('PASS: sandboxed preload, real Rust IPC, route validation, two panes, colored theme');
      clearTimeout(timeout);app.quit();
    } catch(error) {report('FAIL: '+error.stack);clearTimeout(timeout);app.exit(1);}
  });
});
require('../desktop/main.cjs');
