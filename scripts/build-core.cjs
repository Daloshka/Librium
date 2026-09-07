const {spawnSync}=require('node:child_process');
const {existsSync}=require('node:fs'),{join}=require('node:path');
const windows=process.platform==='win32';
const home=process.env[windows?'USERPROFILE':'HOME']||require('node:os').homedir();
const fallback=home?join(home,'.cargo','bin',windows?'cargo.exe':'cargo'):'';
const args=['build','--release','--locked'],options={cwd:join(__dirname,'..'),stdio:'inherit'};
let result=spawnSync('cargo',args,options);
if(result.error?.code==='ENOENT'&&fallback&&existsSync(fallback))result=spawnSync(fallback,args,options);
if(result.error){console.error('Rust is required: install it from https://rustup.rs, then run this command again.');process.exit(1);}
process.exit(result.status??1);
