const {app,BrowserWindow}=require('electron');
const {mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const profile=resolve(process.env.LIBRIUM_FIXTURE_PROFILE||'target/startup-fixture-profile');
mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const origin=process.env.LIBRIUM_FIXTURE_ORIGIN,marker=process.env.LIBRIUM_FIXTURE_MARKER||'startup';
let window;
globalThis.startupComplete=false;
const httpDone=fetch(origin+'/startup-http?'+marker).then(response=>response.text());
const wsDone=new Promise((resolve,reject)=>{
  const Client=process.env.LIBRIUM_FIXTURE_LIBRARY==='ws'?require('ws'):WebSocket;
  const ws=new Client(origin.replace('http:','ws:')+'/startup-ws?'+marker);
  ws.onopen=()=>{ws.send('first message from main');ws.send(new Uint8Array([0,255,17]));};
  let count=0;ws.onmessage=()=>{if(++count===2)ws.close(1000,'startup complete');};
  ws.onclose=resolve;ws.onerror=reject;
});
Promise.all([httpDone,wsDone]).then(()=>{globalThis.startupComplete=true;process.send?.({started:true});});
app.whenReady().then(async()=>{
  window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL(origin+'/startup-page?'+marker);
});
app.on('window-all-closed',()=>app.quit());
