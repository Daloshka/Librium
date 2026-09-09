const { app, BrowserWindow, ipcMain, dialog, clipboard, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const http = require('node:http');
const fs = require('node:fs');
const { Mobile } = require('./mobile.cjs');
const i18n = require('./i18n.cjs');
const t = (key, params) => i18n.t(key, params);
function portFromEnv(name, fallback, max = 65535) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw Error(t('main.badPort', {name, value, max}));
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
  catch {throw Error(t('main.coreOutdated'));}
  return request('/api/ca');
}, corePort: PROXY_PORT, proxyPort: PROXY_PORT, certificatePort: certificatePort(PROXY_PORT), controlPorts: [UI_PORT, PROXY_PORT, certificatePort(PROXY_PORT)]});
let mobileOperation=Promise.resolve();
const page = pathToFileURL(join(__dirname, '../ui/index.html')).href;
function logError(message){
  try{const dir=join(app.getPath('userData'),'logs');fs.mkdirSync(dir,{recursive:true});const file=join(dir,'desktop.log');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fs.renameSync(file,join(dir,'desktop.previous.log'));fs.appendFileSync(file,new Date().toISOString()+' '+String(message).slice(0,8000)+'\n');}catch{}
}

// Node HTTP goes directly to loopback, independently of the system proxy.
function request(path, method = 'GET', authenticated = true, body = null, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const headers = authenticated ? {'x-librium-token': token} : {};
    if (body !== null) headers['content-type'] = 'application/json';
    let answered = false;
    const req = http.request(base + path, { method, headers }, res => {
      answered = true;
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) req.destroy(Error(t('main.responseTooLarge'))); else chunks.push(chunk); });
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`API: ${res.statusCode}`)));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Error(t('main.coreTimeout'))));
    // A core that answers (say, 404) before a large body is fully sent closes the socket: the answer matters, not the EPIPE.
    req.on('error', error => { if (!answered) reject(error); }); req.end(body === null ? undefined : body);
  });
}
async function connect() {
  const html = await request('/', 'GET', false);
  const match = html.match(/const token\s*=\s*'([a-f0-9-]+)'/);
  if (!match || !html.includes('Librium')) throw Error(t('main.portBusy', {port: UI_PORT}));
  token = match[1];
  // One small answer proves the core speaks our API; a core from before /api/state still answers the history route.
  let state;
  try { state = JSON.parse(await request('/api/state')); }
  catch (error) { if (error.message !== 'API: 404') throw error; state = {revision: Array.isArray(JSON.parse(await request('/api/traffic'))) ? 0 : null}; }
  if (!Number.isInteger(state?.revision)) throw Error(t('main.badCoreResponse'));
  // An already running core may use another proxy port than our environment says: follow it, so the phone relay targets the real proxy.
  const port = JSON.parse(await request('/api/info')).proxy_port;
  if (Number.isInteger(port) && port !== mobile.corePort && !mobile.active) Object.assign(mobile, {corePort: port, proxyPort: port, certificatePort: certificatePort(port), controlPorts: [UI_PORT, port, certificatePort(port)]});
}
async function startCore() {
  try { await connect(); return; } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
  }
  if(process.env.LIBRIUM_ATTACH_ONLY==='1')throw Error(t('main.attachOnly'));
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
  throw Error(childError || t('main.coreStartFailed', {ui: UI_PORT, proxy: PROXY_PORT}));
}
function validate(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page) throw Error(t('main.badSource'));
}
ipcMain.handle('api', async (event, path, method, body) => {
  validate(event);
  const ARG = "[A-Za-z0-9%_.!~*'()-]+";
  const reads = new RegExp(`^(?:info|state|settings|intercept|recording|traffic(?:\\/\\d+(?:\\/ws(?:\\?(?:before|after)=\\d+)?)?)?|traffic-page\\?q=${ARG}|traffic-stats\\?q=${ARG})$`);
  const deletes = new RegExp(`^(?:traffic(?:\\/\\d+)?|traffic-page\\?q=${ARG})$`);
  const allowed = (method === 'GET' && body === undefined && reads.test(path))
    || (method === 'DELETE' && body === undefined && deletes.test(path))
    || (method === 'PUT' && path === 'intercept' && typeof body === 'string' && body.length <= 64 * 1024)
    || (method === 'PUT' && path === 'recording' && typeof body === 'string' && body.length <= 64)
    || (method === 'POST' && /^intercept\/\d+$/.test(path) && typeof body === 'string' && body.length <= 16 * 1024 * 1024)
    || (method === 'PATCH' && /^traffic\/\d+$/.test(path) && typeof body === 'string' && body.length <= 64 * 1024);
  if (!allowed) throw Error(t('main.badOperation'));
  const payload = body === undefined ? null : body;
  try { const data = await request('/api/' + path, method, true, payload); return data ? JSON.parse(data) : null; }
  catch (error) {
    if (error.message === 'API: 401' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
      await ensureCore();const data=await request('/api/'+path,method,true,payload);return data?JSON.parse(data):null;
    }
    throw error;
  }
});
ipcMain.handle('copy', (event, text) => { validate(event); if (typeof text !== 'string' || text.length > 500000) throw Error(t('main.badText')); clipboard.writeText(text); });
ipcMain.handle('filter-sessions-load',event=>{validate(event);return require('./filter-store.cjs').read(join(app.getPath('userData'),'filter-sessions.json'));});
ipcMain.handle('filter-sessions-save',(event,value)=>{validate(event);require('./filter-store.cjs').write(join(app.getPath('userData'),'filter-sessions.json'),value);});
ipcMain.handle('save-media',async(event,id,side)=>{
  validate(event);if(!Number.isSafeInteger(id)||id<1||!['request','response'].includes(side))throw Error(t('main.badRequest'));
  const detail=JSON.parse(await request('/api/traffic/'+id));
  const media=require('./media-save.cjs').mediaFile(detail,side);
  const result=await dialog.showSaveDialog(window,{title:t('main.saveFile'),defaultPath:join(app.getPath('downloads'),media.name)});
  if(result.canceled)return false;
  await writeFile(result.filePath,media.bytes);return true;
});
// The renderer hands over its current filters; the same allowlist that guards saved sessions decides what reaches the core.
function exportQuery(query) {
  if (!query || typeof query !== 'object') throw Error(t('main.badRequest'));
  const rules = Array.isArray(query.rules) ? query.rules.map(rule => ({field: String(rule?.field), op: String(rule?.op), value: String(rule?.value)})) : null;
  const clean = require('./filter-store.cjs').checkFilters({query: query.query, method: query.method, status: query.status, type: query.traffic_type, rules});
  return {query: clean.query, method: clean.method, status: clean.status, traffic_type: clean.type, rules: clean.rules};
}
// A HAR file becomes exchanges in the history; the core assigns the ids.
ipcMain.handle('import-har', async (event, dropped) => {
  validate(event);
  let file;
  if (dropped === null || dropped === undefined) {
    const result = await dialog.showOpenDialog(window, {title: t('main.importTitle'), properties: ['openFile'], filters: [{name: 'HAR', extensions: ['har', 'json']}]});
    if (result.canceled || !result.filePaths.length) return null;
    file = result.filePaths[0];
  } else {
    // A file dropped onto the window: only a real .har/.json path on disk counts.
    if (typeof dropped !== 'string' || !/\.(har|json)$/i.test(dropped) || !fs.existsSync(dropped)) throw Error(t('import.badDrop'));
    file = dropped;
  }
  if (fs.statSync(file).size > 512 * 1024 * 1024) throw Error(t('import.tooLarge'));
  const rows = require('./har.cjs').fromHar(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!rows.length) return 0;
  const reply = await request('/api/import', 'POST', true, JSON.stringify(rows), 10 * 60 * 1000);
  return JSON.parse(reply).imported;
});
let heldBefore = 0;
ipcMain.handle('held-count', (event, count) => {
  validate(event);
  if (!Number.isSafeInteger(count) || count < 0) throw Error(t('main.badRequest'));
  if (process.env.LIBRIUM_HEADLESS !== '1') {
    app.dock?.setBadge(count ? String(count) : '');
    if (count > heldBefore && window && !window.isFocused()) window.flashFrame(true);
  }
  heldBefore = count;
});
ipcMain.handle('export-har', async (event, query, options) => {
  validate(event);
  const clean = exportQuery(query);
  const redact = options === true || options?.redact === true;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const result = await dialog.showSaveDialog(window, {title: t('main.exportTitle'), defaultPath: join(app.getPath('downloads'), `librium-${stamp}.har`), filters: [{name: 'HAR', extensions: ['har']}]});
  if (result.canceled) return null;
  return require('./har.cjs').exportHar({fetchJson: async path => JSON.parse(await request('/api/' + path)), query: clean, file: result.filePath, redact});
});
// The renderer's DecompressionStream knows gzip and deflate only; brotli and zstd bodies are undone here.
ipcMain.handle('decode-body', async (event, id, side) => {
  validate(event); if (!Number.isSafeInteger(id) || id < 1 || !['request', 'response'].includes(side)) throw Error(t('main.badRequest'));
  const detail = JSON.parse(await request('/api/traffic/' + id));
  const {bytes, decoded, encoding} = require('./decode.cjs').decodeBody(detail[side]);
  return {decoded, encoding, size: bytes.length, base64: decoded ? bytes.toString('base64') : ''};
});
// Edits from the renderer are checked field by field: a known method, an http(s) URL, well-formed header lines, a bounded text body.
function replayEdit(edit) {
  if (edit === undefined || edit === null) return null;
  if (typeof edit !== 'object') throw Error(t('main.badRequest'));
  const clean = {};
  if (edit.method !== undefined) { if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(edit.method)) throw Error(t('main.badRequest')); clean.method = edit.method; }
  if (edit.url !== undefined) { let parsed; try { parsed = new URL(edit.url); } catch { throw Error(t('main.badUrl')); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || edit.url.length > 16384) throw Error(t('main.httpOnly')); clean.url = parsed.href; }
  if (edit.headers !== undefined) {
    if (!Array.isArray(edit.headers) || edit.headers.length > 200) throw Error(t('main.badRequest'));
    clean.headers = edit.headers.map(pair => { if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(pair[0]) || /[\r\n\0]/.test(pair[1]) || pair[1].length > 16384) throw Error(t('replay.badHeader', {name: String(pair?.[0]).slice(0, 60)})); return [pair[0], pair[1]]; });
  }
  if (edit.body !== undefined) { if (typeof edit.body !== 'string' || edit.body.length > 8 * 1024 * 1024) throw Error(t('main.badRequest')); clean.body = edit.body; }
  return clean;
}
// Settings travel as a whole; the core validates and stores them next to the history.
// The rule lists the interface may change; the same checks serve the settings dialog and an imported file.
const RULE_KEYS = ['ignore_hosts', 'rewrites', 'response_rewrites', 'delays', 'mocks'];
function rulesPayload(value) {
  // A partial update: only the fields given are sent, the core keeps the rest.
  if (!value || typeof value !== 'object') throw Error(t('main.badRequest'));
  const payload = {};
  if (value.ignore_hosts !== undefined) {
    if (!Array.isArray(value.ignore_hosts) || value.ignore_hosts.length > 200 || value.ignore_hosts.some(h => typeof h !== 'string' || h.length > 253)) throw Error(t('main.badRequest'));
    payload.ignore_hosts = value.ignore_hosts;
  }
  for (const key of ['rewrites', 'response_rewrites']) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 100 || list.some(r => !r || typeof r !== 'object' || [r.host, r.name, r.value].some(v => typeof v !== 'string' || v.length > 4096) || (r.path !== undefined && (typeof r.path !== 'string' || r.path.length > 2048)))) throw Error(t('main.badRequest'));
    payload[key] = list.map(r => ({host: r.host, name: r.name, value: r.value, path: typeof r.path === 'string' && r.path ? r.path : '*'}));
  }
  if (value.delays !== undefined) {
    if (!Array.isArray(value.delays) || value.delays.length > 100 || value.delays.some(d => !d || typeof d !== 'object' || typeof d.host !== 'string' || d.host.length > 253 || !Number.isInteger(d.ms) || d.ms < 1 || d.ms > 60000 || (d.path !== undefined && (typeof d.path !== 'string' || d.path.length > 2048)))) throw Error(t('main.badRequest'));
    payload.delays = value.delays.map(d => ({host: d.host, ms: d.ms, path: typeof d.path === 'string' && d.path ? d.path : '*'}));
  }
  if (value.mocks !== undefined) {
    const text = (v, max) => typeof v === 'string' && v.length <= max;
    if (!Array.isArray(value.mocks) || value.mocks.length > 100 || value.mocks.some(m => !m || typeof m !== 'object' || !text(m.host, 253) || !text(m.path, 2048) || !text(m.method, 16) || !text(m.content_type, 256) || !text(m.body, 1024 * 1024) || !Number.isInteger(m.status))) throw Error(t('main.badRequest'));
    payload.mocks = value.mocks.map(m => ({host: m.host, path: m.path, method: m.method, status: m.status, content_type: m.content_type, body: m.body, enabled: m.enabled !== false}));
  }
  return payload;
}
ipcMain.handle('save-settings', async (event, value) => {
  validate(event);
  const payload = rulesPayload(value);
  if (!Object.keys(payload).length) throw Error(t('main.badRequest'));
  await request('/api/settings', 'PUT', true, JSON.stringify(payload));
});
// The rule lists as one JSON file, to share mocks and rewrites; importing replaces the lists the file contains.
ipcMain.handle('export-rules', async event => {
  validate(event);
  const settings = JSON.parse(await request('/api/settings'));
  const rules = {librium_rules: 1};
  for (const key of RULE_KEYS) rules[key] = settings[key] || [];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const result = await dialog.showSaveDialog(window, {title: t('main.exportRulesTitle'), defaultPath: join(app.getPath('downloads'), `librium-rules-${stamp}.json`), filters: [{name: 'JSON', extensions: ['json']}]});
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, JSON.stringify(rules, null, 2));
  return result.filePath;
});
ipcMain.handle('import-rules', async (event, dropped) => {
  validate(event);
  let file;
  if (dropped === null || dropped === undefined) {
    const result = await dialog.showOpenDialog(window, {title: t('main.importRulesTitle'), properties: ['openFile'], filters: [{name: 'JSON', extensions: ['json']}]});
    if (result.canceled || !result.filePaths.length) return null;
    file = result.filePaths[0];
  } else {
    if (typeof dropped !== 'string' || !/\.json$/i.test(dropped) || !fs.existsSync(dropped)) throw Error(t('import.badDrop'));
    file = dropped;
  }
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error(t('import.tooLarge'));
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error(t('settings.rulesBadFile')); }
  if (!parsed || typeof parsed !== 'object') throw Error(t('settings.rulesBadFile'));
  const picked = {};
  for (const key of RULE_KEYS) if (parsed[key] !== undefined) picked[key] = parsed[key];
  const payload = rulesPayload(picked);
  const keys = Object.keys(payload);
  if (!keys.length) throw Error(t('settings.rulesBadFile'));
  await request('/api/settings', 'PUT', true, JSON.stringify(payload));
  return keys;
});
ipcMain.handle('replay', async (event, id, edit) => {
  validate(event);
  if (!Number.isSafeInteger(id) || id < 0) throw Error(t('main.badRequest'));
  const clean = replayEdit(edit);
  // id 0 is a request composed from scratch: everything comes from the edit.
  if (id === 0 && (!clean || !clean.url || !clean.method)) throw Error(t('main.badRequest'));
  const detail = id === 0 ? {summary: {id: 0, method: clean.method, url: clean.url, status: null}, request: {headers: [], size: 0, complete: true, truncated: false, base64: ''}} : JSON.parse(await request('/api/traffic/' + id));
  return require('./replay.cjs').replay({detail, edit: clean, proxyPort: mobile.corePort, caPem: await request('/api/ca')});
});
ipcMain.handle('open-url', (event, value) => {
  validate(event);
  if (typeof value !== 'string' || value.length > 16384) throw Error(t('main.badUrl'));
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(t('main.httpOnly'));
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
  if (!browser) throw Error(t('main.noBrowser', {port: mobile.corePort}));
  const profile = join(app.getPath('userData'), 'chrome-profile');
  const args = [...browser.prefix, `--proxy-server=127.0.0.1:${mobile.corePort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'http://example.com/'];
  const child = spawn(browser.command, args, {detached: true, stdio: 'ignore', windowsHide: true});
  child.on('error', error => logError('Browser launch: ' + error.message));
  child.unref();
  return true;
}
ipcMain.handle('open-browser', event => {validate(event);return openBrowser();});
ipcMain.handle('mobile-status', event => {validate(event);return mobile.status();});
ipcMain.handle('set-language',(event,lang)=>{validate(event);if(lang==='ru'||lang==='en')i18n.set(lang);});
// The renderer cannot reload itself: will-navigate is blocked above, so the language switch asks the main process.
ipcMain.handle('reload-window',event=>{validate(event);window.webContents.reload();});
ipcMain.handle('report-error',(event,message)=>{validate(event);if(typeof message==='string')logError(message);});
ipcMain.handle('mobile-enable', (event,address) => {validate(event);const action=mobileOperation.then(()=>mobile.enable(address));mobileOperation=action.catch(()=>{});return action;});
ipcMain.handle('mobile-disable', event => {validate(event);const action=mobileOperation.then(()=>mobile.disable());mobileOperation=action.catch(()=>{});return action;});
// The certificate is written under the app's own data directory and handed to the platform tool.
ipcMain.handle('install-ca', async event => {
  validate(event);
  const file = join(app.getPath('userData'), 'librium-ca.crt');
  await writeFile(file, await request('/api/ca'));
  return require('./ca-install.cjs').install({file});
});
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
      // LIBRIUM_HEADLESS=1 is for the smoke checks: no window on screen, no dock icon, no focus stealing.
      const headless = process.env.LIBRIUM_HEADLESS === '1';
      if (headless) app.dock?.hide();
      else if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(__dirname, 'assets', 'icon.png'));
      // The window comes back where it was left, as long as that place is still on a screen.
      const boundsFile = join(app.getPath('userData'), 'window.json');
      const remembered = (() => { try { const b = JSON.parse(fs.readFileSync(boundsFile, 'utf8')); const {screen} = require('electron'); const area = screen.getDisplayMatching(b).workArea; if ([b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 1040 && b.height >= 680 && b.x < area.x + area.width - 100 && b.y < area.y + area.height - 100 && b.x + b.width > area.x + 100) return b; } catch {} return {}; })();
      window = new BrowserWindow({ show: !headless, width: 1540, height: 980, ...remembered, minWidth: 1040, minHeight: 680, title: 'Librium', icon: join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), backgroundColor: '#101216', autoHideMenuBar: true,
        webPreferences: { preload: join(__dirname,'preload.cjs'), additionalArguments: ['--librium-lang='+i18n.lang], nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
      let boundsTimer;
      const rememberBounds = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(() => { try { if (!window.isMinimized() && !window.isFullScreen()) fs.writeFileSync(boundsFile, JSON.stringify(window.getNormalBounds())); } catch (error) { logError('Window bounds: ' + error.message); } }, 400); };
      window.on('resize', rememberBounds); window.on('move', rememberBounds);
      window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
      window.webContents.on('render-process-gone',(_event,details)=>logError('Renderer stopped: '+JSON.stringify(details)));
      window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)logError('Renderer: '+message);});
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(join(__dirname, '../ui/index.html'));
      const lanArgument=process.argv.find(argument=>argument.startsWith('--phone-lan='));
      if(lanArgument){try{await mobile.enable(lanArgument.slice('--phone-lan='.length));}catch(error){logError(error.message);dialog.showErrorBox(t('main.phoneTitle'),error.message);}}
    } catch(error) { dialog.showErrorBox(t('main.startupTitle'), error.message); app.quit(); }
  });
}
// A core we started is asked to exit on its own: child.kill() is TerminateProcess on Windows, which
// would drop the last moments of traffic and leave the WAL for recovery at the next start.
async function stopCore() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { await request('/api/shutdown', 'POST'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  if (child.exitCode === null) child.kill();
}
app.on('window-all-closed', () => app.quit());
let quitting=false;
app.on('before-quit', event => {
  if(quitting)return;
  event.preventDefault();quitting=true;
  Promise.allSettled([mobile.disable(),request('/api/storage-flush','POST')]).then(()=>stopCore()).then(()=>app.quit());
});
