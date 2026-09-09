// Installs the Librium CA into the current user's trust store with the platform's own tool. Both tools
// ask the user for confirmation in a system dialog; nothing runs silently, and nothing needs sudo.
const {execFile}=require('node:child_process');
const {t}=require('./i18n.cjs');
function command(platform,home,file){
  if(platform==='darwin')return {command:'security',args:['add-trusted-cert','-r','trustRoot','-k',`${home}/Library/Keychains/login.keychain-db`,file]};
  if(platform==='win32')return {command:'certutil',args:['-user','-addstore','Root',file]};
  return null;
}
async function install({platform=process.platform,home=require('node:os').homedir(),file,run=execFile}){
  const spec=command(platform,home,file);
  if(!spec)throw Error(t('ca.unsupported'));
  return new Promise((resolve,reject)=>{
    run(spec.command,spec.args,{timeout:120000,windowsHide:true},(error,stdout,stderr)=>{
      if(error)reject(Error(t('ca.failed',{detail:(String(stderr||stdout||error.message)).trim().slice(0,400)})));
      else resolve({command:[spec.command,...spec.args].join(' ')});
    });
  });
}
module.exports={command,install};
