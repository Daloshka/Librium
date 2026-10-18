const { app, BrowserWindow, ipcMain, dialog, clipboard, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const {CoreClient}=require('./core-client.cjs');
const fs = require('node:fs');
const { Mobile } = require('./mobile.cjs');
const { CaptureController } = require('./capture-controller.cjs');
const { CaptureTarget } = require('./launch-target.cjs');
const coreClient=new CoreClient();
let child, window, childError = '', coreStarting;
function ensureCore(){
  if(!coreStarting)coreStarting=startCore().finally(()=>{coreStarting=null;});
  return coreStarting;
}
const mobile = new Mobile({getCertificate: async () => {
  try {const info=JSON.parse(await request('/api/info'));if(!info.phone_lan)throw Error();}
  catch {throw Error('Нужно обновить Rust-ядро: останови старый Librium и запусти новую сборку.');}
  return request('/api/ca');
}});
let mobileOperation=Promise.resolve();
const page = pathToFileURL(join(__dirname, '../ui/index.html')).href;
function logError(message){
  try{const dir=join(app.getPath('userData'),'logs');fs.mkdirSync(dir,{recursive:true});const file=join(dir,'desktop.log');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fs.renameSync(file,join(dir,'desktop.previous.log'));fs.appendFileSync(file,new Date().toISOString()+' '+String(message).slice(0,8000)+'\n');}catch{}
}

// Node HTTP goes directly to loopback, independently of the Windows proxy.
function request(path, method = 'GET', authenticated = true, body, signal) {
  return coreClient.request(path,method,authenticated,body,signal);
}
const capture = new CaptureController({ingest:async event=>JSON.parse(await request('/api/capture','POST',true,event))});
let captureOperation=Promise.resolve();
let selectedCaptureTarget;
function captureTarget(){return selectedCaptureTarget ||= new CaptureTarget(join(app.getPath('userData'),'capture-target.json'));}
function serializeCapture(action){const result=captureOperation.then(action);captureOperation=result.catch(()=>{});return result;}
async function captureReady(){
  await ensureCore();
  const info=JSON.parse(await request('/api/info'));
  if(!info.external_capture||!info.capture_sources)throw Error('Запущено старое Rust-ядро. Закрой Librium и запусти обновлённую сборку.');
}
async function connect() {
  await coreClient.connect();
}
async function startCore() {
  try { await connect(); return; } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
  }
  if(process.env.LIBRIUM_ATTACH_ONLY==='1')throw Error('Для проверки нужно запущенное Rust-ядро');
  childError='';
  const binary = app.isPackaged ? join(process.resourcesPath, 'core/librium.exe') : join(__dirname, '../target/release/librium.exe');
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
  child.stderr.on('data', chunk => { childError = (childError + chunk).slice(-4000);logError(chunk); });
  child.on('error', error => { childError = error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await connect(); return; } catch(error) { if(error.code==='LIBRIUM_CORE_INCOMPATIBLE')throw error; }
    if (child.exitCode !== null || childError.includes('ENOENT')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(childError || 'Не удалось запустить Rust-ядро. Проверь порты 3000 и 8080.');
}
function validate(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page) throw Error('Недопустимый источник');
}
ipcMain.handle('api', async (event, path, method, body) => {
  validate(event);
  if(method!=='POST'&&body!==undefined)throw Error('Недопустимое тело команды');
  if (!(method === 'GET' && /^(?:traffic\/\d+\/ws\/\d+\/inflate\?codec=(?:gzip|zlib|deflate)&offset=\d+(?:&length=\d+)?|traffic\/\d+\/ws\/\d+(?:\/(?:context|cdp-related|socketio-related|json-fields))?|traffic\/\d+\/ws\/\d+\/jsonrpc-related(?:\?entry=\d+)?|traffic\/\d+\/ws-json-values\?pointer=[A-Za-z0-9%_.!~*\x27()-]*|traffic\/\d+\/ws-socketio-events|traffic\/\d+\/(?:ws-summary|ws-profile)|traffic(?:\/\d+(?:\/ws(?:\?(?:before=\d+|q=[A-Za-z0-9%_.!~*'()-]+))?)?)?|capture-contexts\?q=[A-Za-z0-9%_.!~*'()-]+|traffic-page\?q=[A-Za-z0-9%_.!~*'()-]+)$/.test(path)) && !(method === 'DELETE' && path === 'traffic') && !(method==='POST'&&/^(?:ws-archive-search|traffic\/\d+\/(?:ws-search|ws-field-values))$/.test(path)&&body&&typeof body==='object'&&!Array.isArray(body)&&JSON.stringify(body).length<=1000000)) throw Error('Недопустимая операция');
  try { const data = await request('/api/' + path, method,true,body); return data ? JSON.parse(data) : null; }
  catch (error) {
    if (error.message === 'API: 401' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
      await ensureCore();const data=await request('/api/'+path,method,true,body);return data?JSON.parse(data):null;
    }
    throw error;
  }
});
ipcMain.handle('copy', (event, text) => { validate(event); if (typeof text !== 'string' || text.length > 500000) throw Error('Недопустимый текст'); clipboard.writeText(text); });
ipcMain.handle('capture-status',event=>{validate(event);return capture.status();});
ipcMain.handle('capture-target',event=>{validate(event);return captureTarget().status();});
ipcMain.handle('capture-select',event=>{
  validate(event);return serializeCapture(async()=>{
    const selected=await dialog.showOpenDialog(window,{title:'Выбрать приложение Electron или package.json проекта',properties:['openFile'],filters:[{name:'Electron: приложение или проект',extensions:['exe','json']}]});
    return selected.canceled?captureTarget().status():captureTarget().select(selected.filePaths[0]);
  });
});
ipcMain.handle('capture-launch',(event,port,captureStartup=false)=>{
  validate(event);return serializeCapture(async()=>{
    await captureReady();const target=captureTarget(),spec=target.read();if(!spec)throw Error('Сначала выбери приложение или проект Electron');
    return capture.launchAndConnect(port,{launch:(value,options)=>target.launch(value,options),label:spec.label,captureStartup});
  });
});
ipcMain.handle('capture-connect',(event,port,mode,startup=false)=>{validate(event);return serializeCapture(async()=>{await captureReady();return capture.connect(port,mode,{startup:mode==='node'?startup:false});});});
ipcMain.handle('capture-disconnect',event=>{validate(event);return serializeCapture(()=>capture.disconnect());});
ipcMain.handle('capture-majestic',(event,port,captureStartup=false)=>{
  validate(event);return serializeCapture(async()=>{
    await captureReady();
    return capture.launchAndConnect(port,{captureStartup});
  });
});
ipcMain.handle('filter-sessions-load',event=>{validate(event);return require('./filter-store.cjs').read(join(app.getPath('userData'),'filter-sessions.json'));});
ipcMain.handle('filter-sessions-save',(event,value)=>{validate(event);require('./filter-store.cjs').write(join(app.getPath('userData'),'filter-sessions.json'),value);});
ipcMain.handle('save-media',async(event,id,side)=>{
  validate(event);if(!Number.isSafeInteger(id)||id<1||!['request','response'].includes(side))throw Error('Неверный запрос');
  const detail=JSON.parse(await request('/api/traffic/'+id));
  const media=require('./media-save.cjs').mediaFile(detail,side);
  const result=await dialog.showSaveDialog(window,{title:'Скачать файл',defaultPath:join(app.getPath('downloads'),media.name)});
  if(result.canceled)return false;
  await writeFile(result.filePath,media.bytes);return true;
});
let exportingWs=false,wsExportTask=null,wsExportAbort=null;
let wsMessageBusy=false,wsMessageTask=null;
ipcMain.handle('save-ws-message',async(event,id,messageId)=>{
  validate(event);if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(messageId)||messageId<1)throw Error('Неверное сообщение WebSocket');
  if(wsMessageBusy)throw Error('Сохранение сообщения уже выполняется');wsMessageBusy=true;
  try{
    const message=JSON.parse(await request(`/api/traffic/${id}/ws/${messageId}`));
    const payload=require('../ui/ws-message.js').payloadFile(id,message);
    const selected=await dialog.showSaveDialog(window,{title:payload.truncated?'Сохранить доступный фрагмент сообщения':'Сохранить байты сообщения',defaultPath:join(app.getPath('downloads'),payload.name),filters:[{name:message.kind==='TEXT'?'Text payload':'Binary payload',extensions:[message.kind==='TEXT'?'txt':'bin']}]});
    if(selected.canceled||quitting)return false;
    if(typeof selected.filePath!=='string'||!selected.filePath)throw Error('Файл не выбран');
    wsMessageTask=require('./ws-message-save.cjs').writePayload(selected.filePath,payload.bytes);await wsMessageTask;
    return {bytes:payload.bytes.length,truncated:payload.truncated};
  }finally{wsMessageBusy=false;wsMessageTask=null;}
});
ipcMain.handle('export-ws',async(event,id)=>{
  validate(event);if(!Number.isSafeInteger(id)||id<1)throw Error('Неверный WebSocket');
  if(exportingWs)throw Error('Экспорт WebSocket уже выполняется');exportingWs=true;
  try{
    const info=JSON.parse(await request('/api/info'));if(!info.ws_export)throw Error('Запущено старое Rust-ядро. Закрой Librium и запусти обновлённую сборку.');
    const selected=await dialog.showSaveDialog(window,{title:'Экспорт всех сообщений WebSocket',defaultPath:join(app.getPath('downloads'),`librium-ws-${id}.jsonl`),filters:[{name:'JSON Lines',extensions:['jsonl']}]});
    if(selected.canceled||quitting)return false;if(typeof selected.filePath!=='string'||!selected.filePath)throw Error('Файл не выбран');
    wsExportAbort=new AbortController();const signal=wsExportAbort.signal;
    wsExportTask=require('./ws-export.cjs').exportFile({id,filePath:selected.filePath,request:async route=>JSON.parse(await request('/api/'+route,'GET',true,undefined,signal)),signal});return await wsExportTask;
  }finally{exportingWs=false;wsExportTask=null;wsExportAbort=null;}
});
ipcMain.handle('save-ws-inflated',async(event,id,messageId,params)=>{
  validate(event);const helpers=require('../ui/ws-message.js'),route=helpers.inflateRequest(id,messageId,params);
  if(wsMessageBusy)throw Error('Сохранение сообщения уже выполняется');if(quitting)return false;wsMessageBusy=true;
  try{
    const result=JSON.parse(await request('/api/'+route)),payload=helpers.inflatedPayload(id,messageId,params,result);
    if(quitting)return false;
    const selected=await dialog.showSaveDialog(window,{title:'Сохранить распакованные байты',defaultPath:join(app.getPath('downloads'),payload.name),filters:[{name:'Unpacked binary payload',extensions:['bin']}]});
    if(selected.canceled||quitting)return false;if(typeof selected.filePath!=='string'||!selected.filePath)throw Error('Файл не выбран');
    wsMessageTask=require('./ws-message-save.cjs').writePayload(selected.filePath,payload.bytes);await wsMessageTask;
    return {bytes:payload.bytes.length,name:payload.name};
  }finally{wsMessageBusy=false;wsMessageTask=null;}
});
ipcMain.handle('open-url', (event, value) => {
  validate(event);
  if (typeof value !== 'string' || value.length > 16384) throw Error('Недопустимый URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Разрешены только HTTP и HTTPS адреса');
  return shell.openExternal(url.href);
});
ipcMain.handle('mobile-status', event => {validate(event);return mobile.status();});
ipcMain.handle('report-error',(event,message)=>{validate(event);if(typeof message==='string')logError(message);});
ipcMain.handle('mobile-enable', (event,address) => {validate(event);const action=mobileOperation.then(()=>mobile.enable(address));mobileOperation=action.catch(()=>{});return action;});
ipcMain.handle('mobile-disable', event => {validate(event);const action=mobileOperation.then(()=>mobile.disable());mobileOperation=action.catch(()=>{});return action;});
ipcMain.handle('save-ca', async event => {
  validate(event);
  const result = await dialog.showSaveDialog(window, { defaultPath: 'librium-ca.crt', filters: [{name:'Certificate', extensions:['crt']}] });
  if (!result.canceled) await writeFile(result.filePath, await request('/api/ca'));
  return !result.canceled;
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(window) { if(window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      await ensureCore();
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window = new BrowserWindow({ width: 1540, height: 980, minWidth: 1040, minHeight: 680, title: 'Librium', icon: join(__dirname, 'assets', 'icon.ico'), backgroundColor: '#101216', autoHideMenuBar: true,
        webPreferences: { preload: join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
      window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
      window.webContents.on('render-process-gone',(_event,details)=>logError('Renderer stopped: '+JSON.stringify(details)));
      window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)logError('Renderer: '+message);});
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(join(__dirname, '../ui/index.html'));
      const lanArgument=process.argv.find(argument=>argument.startsWith('--phone-lan='));
      if(lanArgument){try{await mobile.enable(lanArgument.slice('--phone-lan='.length));}catch(error){logError(error.message);dialog.showErrorBox('Подключение телефона',error.message);}}
    } catch(error) { dialog.showErrorBox('Librium — ошибка запуска', error.message); app.quit(); }
  });
}
app.on('window-all-closed', () => app.quit());
let quitting=false;
app.on('before-quit', event => {
  if(quitting)return;
  event.preventDefault();quitting=true;
  wsExportAbort?.abort();
  Promise.allSettled([mobile.disable(),capture.disconnect(),wsExportTask,wsMessageTask]).then(()=>coreClient.connected?request('/api/storage-flush','POST'):undefined).catch(()=>{}).finally(()=>{if(child && child.exitCode===null)child.kill();app.quit();});
});
