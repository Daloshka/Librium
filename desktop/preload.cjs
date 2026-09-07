const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('librium', {
  request: (path, method = 'GET') => ipcRenderer.invoke('api', path, method),
  saveCertificate: () => ipcRenderer.invoke('save-ca'),
  copy: text => ipcRenderer.invoke('copy', text),
  saveMedia: (id,side) => ipcRenderer.invoke('save-media',id,side),
  loadFilterSessions: () => ipcRenderer.invoke('filter-sessions-load'),
  saveFilterSessions: value => ipcRenderer.invoke('filter-sessions-save',value),
  openUrl: url => ipcRenderer.invoke('open-url', url),
  mobileStatus: () => ipcRenderer.invoke('mobile-status'),
  mobileEnable: address => ipcRenderer.invoke('mobile-enable', address),
  mobileDisable: () => ipcRenderer.invoke('mobile-disable'),
  reportError: message => ipcRenderer.invoke('report-error', message),
  platform: process.platform,
});
