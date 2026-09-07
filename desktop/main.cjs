const { app, BrowserWindow, ipcMain, dialog, clipboard, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const http = require('node:http');
const fs = require('node:fs');
const { Mobile } = require('./mobile.cjs');
function portFromEnv(name, fallback, max = 65535) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw Error(`Неверное значение ${name}=${value}: укажи порт от 1 до ${max}`);
  return Number(value);
}
let startupError = null;
const readPort = (name, fallback, max) => { try { return portFromEnv(name, fallback, max); } catch (error) { startupError ??= error; return fallback; } };
// The phone certificate page lives one port above the proxy, so the proxy cannot take the last port (the core enforces the same limit).
const UI_PORT = readPort('LIBRIUM_UI_PORT', 3000), PROXY_PORT = readPort('LIBRIUM_PROXY_PORT', 8080, 65534);
const certificatePort = proxyPort => Math.min(proxyPort + 1, 65535);
const base = 'http://127.0.0.1:' + UI_PORT;
let child, window, token, childError = '', coreStarting;
function ensureCore(){
  if(!coreStarting)coreStarting=startCore().finally(()=>{coreStarting=null;});
  return coreStarting;
}
const mobile = new Mobile({getCertificate: async () => {
  try {const info=JSON.parse(await request('/api/info'));if(!info.phone_lan)throw Error();}
  catch {throw Error('Нужно обновить Rust-ядро: останови старый Librium и запусти новую сборку.');}
  return request('/api/ca');
}, corePort: PROXY_PORT, proxyPort: PROXY_PORT, certificatePort: certificatePort(PROXY_PORT), controlPorts: [UI_PORT, PROXY_PORT, certificatePort(PROXY_PORT)]});
let mobileOperation=Promise.resolve();
const page = pathToFileURL(join(__dirname, '../ui/index.html')).href;
function logError(message){
  try{const dir=join(app.getPath('userData'),'logs');fs.mkdirSync(dir,{recursive:true});const file=join(dir,'desktop.log');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fs.renameSync(file,join(dir,'desktop.previous.log'));fs.appendFileSync(file,new Date().toISOString()+' '+String(message).slice(0,8000)+'\n');}catch{}
}

// Node HTTP goes directly to loopback, independently of the system proxy.
function request(path, method = 'GET', authenticated = true) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers: authenticated ? {'x-librium-token': token} : {} }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) req.destroy(Error('Ответ API слишком большой')); else chunks.push(chunk); });
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`API: ${res.statusCode}`)));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(Error('Ядро не отвечает')));
    req.on('error', reject); req.end();
  });
}
async function connect() {
  const html = await request('/', 'GET', false);
  const match = html.match(/const token\s*=\s*'([a-f0-9-]+)'/);
  if (!match || !html.includes('Librium')) throw Error(`Порт ${UI_PORT} занят другим приложением`);
  token = match[1];
  const rows = JSON.parse(await request('/api/traffic'));
  if (!Array.isArray(rows)) throw Error('Неверный ответ ядра');
  // An already running core may use another proxy port than our environment says: follow it, so the phone relay targets the real proxy.
  const port = JSON.parse(await request('/api/info')).proxy_port;
  if (Number.isInteger(port) && port !== mobile.corePort && !mobile.active) Object.assign(mobile, {corePort: port, proxyPort: port, certificatePort: certificatePort(port), controlPorts: [UI_PORT, port, certificatePort(port)]});
}
async function startCore() {
  try { await connect(); return; } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
  }
  if(process.env.LIBRIUM_ATTACH_ONLY==='1')throw Error('Для проверки нужно запущенное Rust-ядро');
  childError='';
  const name = process.platform === 'win32' ? 'librium.exe' : 'librium';
  const binary = app.isPackaged ? join(process.resourcesPath, 'core', name) : join(__dirname, '../target/release', name);
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore','ignore','pipe'], env: {...process.env, LIBRIUM_UI_PORT: String(UI_PORT), LIBRIUM_PROXY_PORT: String(PROXY_PORT)} });
  child.stderr.on('data', chunk => { childError = (childError + chunk).slice(-4000);logError(chunk); });
  child.on('error', error => { childError = error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await connect(); return; } catch {}
    if (child.exitCode !== null || childError.includes('ENOENT')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(childError || `Не удалось запустить Rust-ядро. Проверь порты ${UI_PORT} и ${PROXY_PORT}.`);
}
function validate(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page) throw Error('Недопустимый источник');
}
ipcMain.handle('api', async (event, path, method) => {
  validate(event);
  if (!(method === 'GET' && /^(?:info|traffic(?:\/\d+(?:\/ws(?:\?before=\d+)?)?)?|traffic-page\?q=[A-Za-z0-9%_.!~*'()-]+)$/.test(path)) && !(method === 'DELETE' && path === 'traffic')) throw Error('Недопустимая операция');
  try { const data = await request('/api/' + path, method); return data ? JSON.parse(data) : null; }
  catch (error) {
    if (error.message === 'API: 401' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
      await ensureCore();const data=await request('/api/'+path,method);return data?JSON.parse(data):null;
    }
    throw error;
  }
});
ipcMain.handle('copy', (event, text) => { validate(event); if (typeof text !== 'string' || text.length > 500000) throw Error('Недопустимый текст'); clipboard.writeText(text); });
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
ipcMain.handle('open-url', (event, value) => {
  validate(event);
  if (typeof value !== 'string' || value.length > 16384) throw Error('Недопустимый URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Разрешены только HTTP и HTTPS адреса');
  return shell.openExternal(url.href);
});
// A separate Chromium profile that talks to Librium directly: VPN tunnels and other clients ignore the system proxy, an explicit --proxy-server does not.
function browserCandidates() {
  if (process.platform === 'darwin') return ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'].filter(name => fs.existsSync(`/Applications/${name}.app`)).map(name => ({command: 'open', prefix: ['-na', name, '--args']}));
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'].flatMap(relative => roots.map(root => join(root, relative))).filter(path => fs.existsSync(path)).map(command => ({command, prefix: []}));
  }
  const dirs = (process.env.PATH || '').split(':');
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].flatMap(name => dirs.map(dir => join(dir, name))).filter(path => fs.existsSync(path)).map(command => ({command, prefix: []}));
}
function openBrowser() {
  const [browser] = browserCandidates();
  if (!browser) throw Error(`Не найден Chrome, Chromium, Edge или Brave. Укажи прокси 127.0.0.1:${mobile.corePort} в настройках браузера вручную.`);
  const profile = join(app.getPath('userData'), 'chrome-profile');
  const args = [...browser.prefix, `--proxy-server=127.0.0.1:${mobile.corePort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'http://example.com/'];
  const child = spawn(browser.command, args, {detached: true, stdio: 'ignore', windowsHide: true});
  child.on('error', error => logError('Browser launch: ' + error.message));
  child.unref();
  return true;
}
ipcMain.handle('open-browser', event => {validate(event);return openBrowser();});
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
      if (startupError) throw startupError;
      await ensureCore();
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(__dirname, 'assets', 'icon.png'));
      window = new BrowserWindow({ width: 1540, height: 980, minWidth: 1040, minHeight: 680, title: 'Librium', icon: join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), backgroundColor: '#101216', autoHideMenuBar: true,
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
  Promise.allSettled([mobile.disable(),request('/api/storage-flush','POST')]).then(()=>{if(child && child.exitCode===null)child.kill();app.quit();});
});
