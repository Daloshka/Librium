// Drives the real renderer against an already running core (LIBRIUM_UI_PORT / LIBRIUM_PROXY_PORT): scrolls the history,
// pushes new traffic through the proxy and checks that the row under the reader stays put, while at scrollTop 0 the
// newest traffic is visible. Seeds ~90 synthetic requests into the running history; use an isolated LIBRIUM_DATA_DIR.
process.env.LIBRIUM_ATTACH_ONLY='1';
process.env.LIBRIUM_HEADLESS='1';
const {app}=require('electron');
const http=require('node:http');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
const PROXY_PORT=Number(process.env.LIBRIUM_PROXY_PORT||8080);
const profile=resolve('target/anchor-smoke-profile');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const origin=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('ok '+req.url);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function viaProxy(url){return new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:PROXY_PORT,path:url,headers:{host:new URL(url).host}},r=>{r.resume();r.on('end',resolve);}).on('error',reject));}
const timer=setTimeout(()=>{console.error('FAIL: timed out');app.exit(1);},60000);
app.on('browser-window-created',(_e,window)=>{
  window.hide();
  window.webContents.once('did-finish-load',async()=>{
    try{
      await new Promise(r=>origin.listen(0,'127.0.0.1',r));
      const base=`http://127.0.0.1:${origin.address().port}`;
      for(let i=0;i<80;i++)await viaProxy(`${base}/anchor-seed/${i}`);
      await sleep(2500);
      const js=fn=>window.webContents.executeJavaScript(`(${fn})()`);
      const count=await js(()=>document.querySelectorAll('#rows tr[data-id]').length);
      assert.ok(count>=80,'seed rows rendered: '+count);
      // Scroll down and remember the first visible row.
      if(process.env.NO_BROWSER_ANCHOR)await js(()=>{document.querySelector('.table-scroll').style.overflowAnchor='none';});
      const before=await js(()=>{const s=document.querySelector('.table-scroll');s.scrollTop=600;const top=s.getBoundingClientRect().top;for(const tr of document.querySelectorAll('#rows tr[data-id]')){const r=tr.getBoundingClientRect();if(r.bottom>top)return {id:tr.dataset.id,top:r.top,scrollTop:s.scrollTop,first:document.querySelector('#rows tr[data-id]').dataset.id};}});
      assert.ok(before.scrollTop>0,'list is scrollable');
      for(let i=0;i<7;i++)await viaProxy(`${base}/anchor-new/${i}`);
      await sleep(2500);
      const state=await window.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.table-scroll');const tr=document.querySelector('#rows tr[data-id="${before.id}"]');return {top:tr&&tr.getBoundingClientRect().top,scrollTop:s.scrollTop,first:document.querySelector('#rows tr[data-id]').dataset.id,rows:document.querySelectorAll('#rows tr[data-id]').length};})()`);
      assert.ok(state.top!==null,'anchored row still rendered');
      assert.ok(Math.abs(state.top-before.top)<=1,`row ${before.id} moved from ${before.top} to ${state.top}`);
      assert.ok(state.scrollTop>before.scrollTop,'scrollTop compensated for inserted rows');
      assert.ok(state.rows>=Math.min(500,count+7),'new rows were inserted (page capped at 500)');
      // Back at the top the newest traffic must be visible.
      await js(()=>{document.querySelector('.table-scroll').scrollTop=0;});
      for(let i=0;i<3;i++)await viaProxy(`${base}/anchor-top/${i}`);
      await sleep(2500);
      const topState=await js(()=>({scrollTop:document.querySelector('.table-scroll').scrollTop,first:document.querySelector('#rows tr[data-id]').dataset.id,firstUrl:document.querySelector('#rows tr[data-id] td:nth-child(4)').title}));
      assert.equal(topState.scrollTop,0);
      assert.match(topState.firstUrl,/anchor-top\/2/);
      console.log('Anchor check OK:',{anchored:before.id,scrollBefore:before.scrollTop,scrollAfter:state.scrollTop,rows:state.rows,newestVisible:topState.firstUrl});
      clearTimeout(timer);origin.close();app.quit();
    }catch(error){console.error('FAIL:',error.message);clearTimeout(timer);app.exit(1);}
  });
});
require('../desktop/main.cjs');
