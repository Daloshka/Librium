const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {startStartupWatchdog}=require('./startup-watchdog.cjs');

function portNumber(value) {
  if(!Number.isInteger(value)||value<1024||value>65535||[3000,8080,8081].includes(value))throw Error('Укажи свободный порт от 1024 до 65535, например 9333');
  return value;
}
function targetSpec(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)||file.length>32767||file.includes('\0'))throw Error('Выбери исполняемый файл Electron или package.json проекта');
  let stat;try{stat=fs.statSync(file);}catch{throw Error('Выбранный файл недоступен. Выбери приложение снова.');}
  if(!stat.isFile())throw Error('Выбранный путь не является файлом');
  if(path.extname(file).toLowerCase()==='.exe')return {kind:'executable',path:file,label:path.basename(file),executable:file,args:[],cwd:path.dirname(file)};
  if(path.basename(file).toLowerCase()!=='package.json')throw Error('Для проекта Electron выбери его package.json');
  if(stat.size>1024*1024)throw Error('package.json превышает 1 МиБ');
  let metadata;try{metadata=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('Не удалось прочитать package.json проекта');}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Неверный package.json проекта');
  const cwd=path.dirname(file),executable=path.join(cwd,'node_modules','electron','dist','electron.exe');
  if(!fs.existsSync(executable)||!fs.statSync(executable).isFile())throw Error('В проекте не найден node_modules/electron/dist/electron.exe. Установи зависимости проекта и выбери его снова.');
  const name=typeof metadata.productName==='string'?metadata.productName:typeof metadata.name==='string'?metadata.name:path.basename(cwd);
  return {kind:'project',path:file,label:(name.trim()||path.basename(cwd)).slice(0,120),executable,args:[cwd],cwd};
}
async function launchElectron(spec,port,{spawnProcess=spawn,captureStartup=false}={}) {
  if(typeof captureStartup!=='boolean')throw Error('Неверный режим начала запуска');
  portNumber(port);portNumber(port+1);
  for(const value of [port,port+1])await new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',()=>reject(Error(`Отладочный порт ${value} занят. Выбери другой порт или используй «Подключиться к порту».`)));
    probe.listen(value,'127.0.0.1',()=>probe.close(resolve));
  });
  const guard=captureStartup?await startStartupWatchdog():null;
  const args=[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--inspect${captureStartup?'-brk':''}=127.0.0.1:${port+1}`,'--experimental-network-inspection',...spec.args];
  try{
    const child=spawnProcess(spec.executable,args,{cwd:spec.cwd,detached:true,windowsHide:true,stdio:'ignore',shell:false});
    if(Number.isInteger(child.pid))guard?.arm(child.pid,port+1);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Не удалось запустить выбранное приложение Electron')));});child.unref();
  }catch(error){guard?.cancel();throw error;}
}
class CaptureTarget {
  constructor(file){this.file=file;}
  read(){
    if(!fs.existsSync(this.file))return null;
    if(fs.statSync(this.file).size>65536)throw Error('Настройки запуска повреждены. Выбери приложение снова.');
    let value;try{value=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw Error('Настройки запуска повреждены. Выбери приложение снова.');}
    if(value?.version!==1||typeof value.path!=='string')throw Error('Настройки запуска повреждены. Выбери приложение снова.');
    return targetSpec(value.path);
  }
  status(){
    try{const spec=this.read();return {target:spec?{kind:spec.kind,path:spec.path,label:spec.label}:null,available:Boolean(spec),error:null};}
    catch{return {target:null,available:false,error:'Выбранное приложение недоступно. Выбери его снова.'};}
  }
  select(file){
    const spec=targetSpec(file);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,path:spec.path}));fs.renameSync(this.file+'.tmp',this.file);
    return this.status();
  }
  async launch(port,options){const spec=this.read();if(!spec)throw Error('Сначала выбери приложение или проект Electron');await launchElectron(spec,port,options);}
}
module.exports={CaptureTarget,targetSpec,launchElectron,portNumber};
