process.env.LIBRIUM_ATTACH_ONLY='1';
const {app,dialog}=require('electron'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const profile=path.resolve('target/core-compat-profile-'+Date.now()+'-'+process.pid);fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const calls=[];let alerted=false,createdWindow=false;
const timeout=setTimeout(()=>{console.error('Compatibility startup check timed out');app.exit(1);},15000);
app.on('browser-window-created',()=>{createdWindow=true;});
dialog.showErrorBox=(_title,message)=>{assert.match(message,/Несовместимое Rust-ядро/);alerted=true;};
const server=http.createServer((req,res)=>{calls.push([req.method,req.url]);req.resume();if(req.url==='/')res.end(`Librium<script>const token='${'a'.repeat(32)}'</script>`);else if(req.url==='/api/info')res.end(JSON.stringify({version:'0.5.2',persistent_history:true,external_capture:true,capture_sources:true,ws_export:true}));else res.end('[]');});
server.listen(0,'127.0.0.1',()=>{
  const module=require('../desktop/core-client.cjs'),Original=module.CoreClient;
  module.CoreClient=class extends Original{constructor(){super({base:'http://127.0.0.1:'+server.address().port});}};
  app.once('will-quit',event=>{clearTimeout(timeout);server.close();try{assert.equal(alerted,true);assert.equal(createdWindow,false);assert.deepEqual(calls,[['GET','/'],['GET','/api/info']]);console.log('PASS: real desktop rejects old core before opening UI or reading history, and shutdown sends no flush/capture writes');}catch(error){console.error(error);event.preventDefault();app.exit(1);}});
  require('../desktop/main.cjs');
});
