// Electron starts its own core (no attach mode) on the ports from the environment, then quits: the core must be
// gone and the history closed cleanly (no -wal file left behind). Run with an isolated LIBRIUM_DATA_DIR and free ports:
//   LIBRIUM_DATA_DIR=target/quit-smoke-data LIBRIUM_UI_PORT=3003 LIBRIUM_PROXY_PORT=8090 npx electron scripts/quit-smoke.cjs
process.env.LIBRIUM_HEADLESS='1';
const {app}=require('electron');const {resolve}=require('node:path');const fs=require('node:fs');
const profile=resolve('target/quit-smoke-profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const timer=setTimeout(()=>{console.error('FAIL: timed out');app.exit(1);},30000);
app.on('browser-window-created',(_e,window)=>{window.hide();window.webContents.once('did-finish-load',async()=>{
  const rows=await window.webContents.executeJavaScript(`window.librium.request('state')`);
  console.log('core answered with revision',rows.revision);
  const started=Date.now();app.once('will-quit',()=>console.log('quit sequence took',Date.now()-started,'ms'));
  clearTimeout(timer);app.quit();
  // The checks below run in a detached process: Electron's own exit is not delayed by them.
  const dataDir=process.env.LIBRIUM_DATA_DIR,uiPort=process.env.LIBRIUM_UI_PORT||'3000';
  require('node:child_process').spawn(process.env.npm_node_execpath||'node',['-e',`
    const fs=require('node:fs'),net=require('node:net');
    setTimeout(()=>{
      const socket=net.connect(${uiPort},'127.0.0.1');
      socket.on('connect',()=>{console.error('FAIL: the core still listens on ${uiPort}');socket.destroy();process.exit(1);});
      socket.on('error',()=>{const wal=${JSON.stringify(dataDir||'')}&&fs.existsSync(${JSON.stringify((dataDir||'')+'/history.sqlite3-wal')})?fs.statSync(${JSON.stringify((dataDir||'')+'/history.sqlite3-wal')}).size:0;if(wal){console.error('FAIL: WAL left behind, '+wal+' bytes');process.exit(1);}console.log('Quit smoke OK: core stopped and history checkpointed');});
    },1500);`],{detached:true,stdio:'inherit'}).unref();
});});
require('../desktop/main.cjs');
