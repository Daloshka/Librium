const { contextBridge, ipcRenderer } = require('electron');
// The main process passes its language here, so the renderer starts in the same one.
const supplied = (process.argv.find(argument => argument.startsWith('--librium-lang=')) || '').slice('--librium-lang='.length);
contextBridge.exposeInMainWorld('librium', {
  request: (path, method = 'GET') => ipcRenderer.invoke('api', path, method),
  saveCertificate: () => ipcRenderer.invoke('save-ca'),
  copy: text => ipcRenderer.invoke('copy', text),
  saveMedia: (id,side) => ipcRenderer.invoke('save-media',id,side),
  loadFilterSessions: () => ipcRenderer.invoke('filter-sessions-load'),
  saveFilterSessions: value => ipcRenderer.invoke('filter-sessions-save',value),
  openUrl: url => ipcRenderer.invoke('open-url', url),
  openBrowser: () => ipcRenderer.invoke('open-browser'),
  mobileStatus: () => ipcRenderer.invoke('mobile-status'),
  mobileEnable: address => ipcRenderer.invoke('mobile-enable', address),
  mobileDisable: () => ipcRenderer.invoke('mobile-disable'),
  reportError: message => ipcRenderer.invoke('report-error', message),
  setLanguage: lang => ipcRenderer.invoke('set-language', lang),
  reload: () => ipcRenderer.invoke('reload-window'),
  language: supplied === 'ru' || supplied === 'en' ? supplied : '',
  platform: process.platform,
});
