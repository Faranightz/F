const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fDesktop', {
  isElectron: true,
  platform: process.platform,
  openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
  savePdfDialog: (defaultName, bytes) =>
    ipcRenderer.invoke('dialog:savePdf', { defaultName, bytes }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  yousign: {
    getConfig: () => ipcRenderer.invoke('yousign:getConfig'),
    saveConfig: (cfg) => ipcRenderer.invoke('yousign:saveConfig', cfg),
    send: (req) => ipcRenderer.invoke('yousign:send', req),
    status: (record) => ipcRenderer.invoke('yousign:status', record),
    download: (record) => ipcRenderer.invoke('yousign:download', record),
  },
});
