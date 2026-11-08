/**
 * Preload script for safe IPC exposure in Electron
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  printThermalReceipt: (content) => ipcRenderer.invoke('print-receipt-thermal', content)
});
