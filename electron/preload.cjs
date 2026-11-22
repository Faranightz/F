const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fDesktop', {
  isElectron: true,
  platform: process.platform,
  openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
  savePdfDialog: (defaultName, bytes) =>
    ipcRenderer.invoke('dialog:savePdf', { defaultName, bytes }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onFileOpened: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('file:opened', handler);
    return () => ipcRenderer.removeListener('file:opened', handler);
  },
  certificates: {
    choose: () => ipcRenderer.invoke('cert:choose'),
    inspect: (id, password) => ipcRenderer.invoke('cert:inspect', id, password),
    create: (req) => ipcRenderer.invoke('cert:create', req),
    sign: (req) => ipcRenderer.invoke('cert:sign', req),
  },
  secureStore: {
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
  },
  yousign: {
    getConfig: () => ipcRenderer.invoke('yousign:getConfig'),
    saveConfig: (cfg) => ipcRenderer.invoke('yousign:saveConfig', cfg),
    send: (req) => ipcRenderer.invoke('yousign:send', req),
    status: (record) => ipcRenderer.invoke('yousign:status', record),
    download: (record) => ipcRenderer.invoke('yousign:download', record),
  },
});
