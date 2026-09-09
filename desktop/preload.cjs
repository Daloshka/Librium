const { contextBridge, ipcRenderer, webUtils } = require('electron');
// The main process passes its language here, so the renderer starts in the same one.
const supplied = (process.argv.find(argument => argument.startsWith('--librium-lang=')) || '').slice('--librium-lang='.length);
contextBridge.exposeInMainWorld('librium', {
  request: (path, method = 'GET', body) => ipcRenderer.invoke('api', path, method, body),
  saveCertificate: () => ipcRenderer.invoke('save-ca'),
  installCertificate: () => ipcRenderer.invoke('install-ca'),
  copy: text => ipcRenderer.invoke('copy', text),
  saveMedia: (id,side) => ipcRenderer.invoke('save-media',id,side),
  exportHar: (query, options) => ipcRenderer.invoke('export-har', query, options),
  // Without a file the main process asks for one; a dropped File is passed by its path (an in-memory File has none).
  importHar: file => { let path = null; if (file) { try { path = webUtils.getPathForFile(file) || ''; } catch { path = ''; } } return ipcRenderer.invoke('import-har', path); },
  replay: (id, edit) => ipcRenderer.invoke('replay', id, edit),
  decodeBody: (id, side) => ipcRenderer.invoke('decode-body', id, side),
  saveSettings: value => ipcRenderer.invoke('save-settings', value),
  exportRules: () => ipcRenderer.invoke('export-rules'),
  // Like importHar: without a file the main process asks for one; a dropped File goes by its path.
  importRules: file => { let path = null; if (file) { try { path = webUtils.getPathForFile(file) || ''; } catch { path = ''; } } return ipcRenderer.invoke('import-rules', path); },
  loadFilterSessions: () => ipcRenderer.invoke('filter-sessions-load'),
  saveFilterSessions: value => ipcRenderer.invoke('filter-sessions-save',value),
  openUrl: url => ipcRenderer.invoke('open-url', url),
  openBrowser: () => ipcRenderer.invoke('open-browser'),
  mobileStatus: () => ipcRenderer.invoke('mobile-status'),
  mobileEnable: address => ipcRenderer.invoke('mobile-enable', address),
  mobileDisable: () => ipcRenderer.invoke('mobile-disable'),
  reportError: message => ipcRenderer.invoke('report-error', message),
  // The dock badge and a window flash while requests are held, so a blocked browser is not a mystery.
  heldCount: count => ipcRenderer.invoke('held-count', count),
  setLanguage: lang => ipcRenderer.invoke('set-language', lang),
  reload: () => ipcRenderer.invoke('reload-window'),
  language: supplied === 'ru' || supplied === 'en' ? supplied : '',
  platform: process.platform,
});
