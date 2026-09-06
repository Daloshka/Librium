process.env.LIBRIUM_ATTACH_ONLY='1';
const {app}=require('electron');
const {resolve}=require('node:path');
const fs=require('node:fs'),assert=require('node:assert/strict');
app.setPath('userData',resolve('target/preferences-smoke-profile'));
const verify=process.argv.includes('--verify');
const state={version:1,activeId:'ws',sessions:[{id:'all',name:'Все',query:'',method:'',status:'',type:'',rules:[]},{id:'ws',name:'Мои сокеты',query:'socket',method:'GET',status:'',type:'ws',rules:[{field:'status',op:'eq',value:'101'}]}]};
const timeout=setTimeout(()=>app.exit(1),15000);
app.on('browser-window-created',(_e,window)=>{
 window.hide();window.webContents.once('did-finish-load',async()=>{try{
  if(!verify)await window.webContents.executeJavaScript(`window.librium.saveFilterSessions(${JSON.stringify(state)})`);
  const read=await window.webContents.executeJavaScript('window.librium.loadFilterSessions()');assert.deepEqual(read,state);
  if(verify){
   let controls;
   for(let n=0;n<30;n++){controls=await window.webContents.executeJavaScript(`({session:document.querySelector('#filter-session').value,query:document.querySelector('#filter').value,type:document.querySelector('#traffic-type').value,side:document.querySelector('#panes').classList.contains('side-by-side'),layout:!!document.querySelector('#layout'),wrap:!!document.querySelector('#wrap')})`);if(controls.session==='ws')break;await new Promise(r=>setTimeout(r,100));}
   assert.deepEqual(controls,{session:'ws',query:'socket',type:'ws',side:true,layout:false,wrap:false});
  }
  fs.writeFileSync('target/preferences-smoke-result.txt',verify?'PASS: filter sessions restored after restarting Electron':'PASS: sessions written');console.log(verify?'Filter sessions restored after restarting Electron':'Filter sessions saved');clearTimeout(timeout);app.quit();
 }catch(e){fs.writeFileSync('target/preferences-smoke-result.txt',e.stack);console.error(e);clearTimeout(timeout);app.exit(1);}});
});
require('../desktop/main.cjs');
