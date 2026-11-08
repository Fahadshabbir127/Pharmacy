/**
 * Khushi Medical Hall POS - Electron Main Process
 * Electron launcher with local Express server & IPC bridges.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Khushi Medical Hall - Store POS',
    icon: path.join(__dirname, 'public/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load Express server running on localhost:3000
  const serverUrl = 'http://localhost:3000';

  const loadApp = () => {
    mainWindow.loadURL(serverUrl).catch(() => {
      setTimeout(loadApp, 500);
    });
  };

  loadApp();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startLocalServer() {
  const isDev = process.env.NODE_ENV !== 'production';
  const serverScript = isDev ? 'server.ts' : path.join(__dirname, 'dist/server.cjs');

  if (isDev) {
    serverProcess = spawn('npx', ['tsx', serverScript], {
      shell: true,
      stdio: 'inherit'
    });
  } else {
    serverProcess = spawn('node', [serverScript], {
      stdio: 'inherit'
    });
  }
}

app.whenReady().then(() => {
  startLocalServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

// Native IPC Listeners for ESC/POS Printing and Dialogs
ipcMain.handle('show-save-dialog', async (event, options) => {
  return await dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  return await dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle('print-receipt-thermal', async (event, receiptContent) => {
  console.log('[ELECTRON-IPC] Thermal print requested:', receiptContent);
  return { success: true };
});
