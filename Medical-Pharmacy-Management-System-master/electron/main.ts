/**
 * BrainTech Pharmacy AI - Electron main process.
 *
 * Modes:  standalone  backend on this computer, loopback only
 *         host        backend on this computer, reachable by paired computers on the LAN (HTTPS)
 *         client      no local backend or database; every API call goes to the paired host (HTTPS, pinned)
 * The window always shows the app's own bundled pages (app://braintech/...), in every mode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, protocol, session, shell, WebContents } from 'electron';
import { z } from 'zod';
import { BackendSupervisor } from './backend';
import { ensureLocalCertificate, renewLocalCertificate } from './certs';
import { Connection, ORIGIN, registerAppScheme } from './connection';
import { handle, S, appInfo, confirm } from './ipc';
import { dataRoot, loadConfig, saveConfig, paths, protect, unprotect, log, DesktopConfig, canEncrypt } from './store';
import { pinnedJson, pairWithHost } from '../server/lan/pinnedClient';
import { shortFingerprint } from '../server/lan/tls';
import { startDiscoveryResponder, discoverHosts } from '../server/lan/discovery';
import { importLegacyDatabase } from '../server/db/legacyImport';

if (process.env.BRAINTECH_USER_DATA) app.setPath('userData', path.resolve(process.env.BRAINTECH_USER_DATA));
app.setName('BrainTech Pharmacy AI');
registerAppScheme();

const EXTERNAL_ALLOWED = [/^https:\/\/wa\.me\//i, /^https:\/\/api\.whatsapp\.com\//i, /^sms:/i, /^tel:/i, /^mailto:/i];
const isAppUrl = (u: string) => u === ORIGIN || u.startsWith(`${ORIGIN}/`);

let cfg: DesktopConfig;
let backend: BackendSupervisor | null = null;
let discovery: { close: () => void } | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
const conn = new Connection({ renderer: path.join(__dirname, '..', 'dist'), ui: path.join(__dirname, 'ui') });

// ---------------------------------------------------------------------------------------------
// single instance
// ---------------------------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(boot).catch((e) => fatal('The application could not start', e));
}

function fatal(title: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  log('fatal', `${title}: ${msg}`);
  dialog.showErrorBox(title, `${msg}\n\nLogs: ${safeLogDir()}`);
}
const safeLogDir = () => { try { return paths.logs(); } catch { return '(unavailable)'; } };

// ---------------------------------------------------------------------------------------------
// security for every web contents
// ---------------------------------------------------------------------------------------------
function hardenContents(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') {
      // existing print popups (document.write + print()); IPC from about:blank is refused by the sender check
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
        },
      };
    }
    void openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    void openExternalSafely(url);
  });
  contents.on('will-redirect', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

async function openExternalSafely(url: string) {
  if (!EXTERNAL_ALLOWED.some((r) => r.test(url))) { log('security', `blocked navigation to ${url.slice(0, 80)}`); return; }
  const ok = await confirm(mainWindow, 'Open outside the app?', `${url.slice(0, 300)}\n\nThis opens your web browser or messaging app and needs an internet connection.`, 'Open');
  if (ok) await shell.openExternal(url);
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const fromApp = isAppUrl(details.requestingUrl || wc.getURL());
    // camera for barcode scanning only; nothing else (no geolocation, notifications, mic, ...)
    const ok = fromApp && permission === 'media' && (details as any).mediaTypes?.every((t: string) => t === 'video');
    if (!ok) log('security', `denied permission ${permission} for ${String(details.requestingUrl).slice(0, 60)}`);
    cb(!!ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isAppUrl(origin));
  ses.on('will-download', (_e, item) => {
    // automated tests only: save without a dialog so the test can check the file
    if (process.env.BRAINTECH_E2E === '1' && process.env.BRAINTECH_E2E_DOWNLOADS) {
      item.setSavePath(path.join(process.env.BRAINTECH_E2E_DOWNLOADS, item.getFilename()));
      return;
    }
    item.setSaveDialogOptions({ title: 'Save file', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
}

// ---------------------------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------------------------
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'BrainTech Pharmacy AI',
    backgroundColor: '#0f172a',
    icon: fs.existsSync(path.join(__dirname, 'ui', 'icon.png')) ? path.join(__dirname, 'ui', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.BRAINTECH_DEVTOOLS === '1',
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', async (e) => {
    if (quitting || conn.inFlightSales === 0) return;
    e.preventDefault();
    const leave = await confirm(win, 'A sale is still being saved', 'Closing now may leave the sale unconfirmed. Wait a moment, then check the Sales Register.', 'Close anyway');
    if (leave) { quitting = true; win.close(); }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  return win;
}

function show(page: 'app' | 'setup' | 'manage') {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  const url = page === 'app' ? `${ORIGIN}/index.html` : `${ORIGIN}/__app/setup.html${page === 'manage' ? '#manage' : ''}`;
  void mainWindow.loadURL(url);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Connection && Server Settings', accelerator: 'CmdOrCtrl+,', click: () => show('manage') },
        { label: 'Back to Pharmacy', accelerator: 'CmdOrCtrl+Home', click: () => show('app') },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: () => void shell.openPath(paths.logs()) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])] },
    { label: 'Help', submenu: [{ label: 'About BrainTech Pharmacy AI', click: () => void dialog.showMessageBox({ title: 'About', message: `BrainTech Pharmacy AI ${app.getVersion()}`, detail: `Mode: ${cfg?.mode ?? 'not set up'}\nData folder: ${dataRoot()}` }) }] },
  ]));
}

// ---------------------------------------------------------------------------------------------
// local backend (standalone / host)
// ---------------------------------------------------------------------------------------------
async function startLocal(mode: 'standalone' | 'host') {
  await stopLocal();
  const cert = await ensureLocalCertificate();
  backend = new BackendSupervisor({ mode, hostPort: cfg.hostPort, cert });
  backend.onEvent((ev) => {
    if (ev.type === 'restarting') conn.setState({ status: 'BACKEND_RESTARTING', detail: 'The pharmacy backend stopped unexpectedly and is restarting...', isLocal: true });
    if (ev.type === 'failed') { conn.setState({ status: 'BACKEND_FAILED', detail: ev.detail, isLocal: true }); log('backend', ev.detail || 'failed'); }
    if (ev.type === 'started' && backend?.info) conn.setTarget({ base: `https://127.0.0.1:${backend.info.port}`, fingerprint: backend.info.fingerprint, isLocal: true }, os.hostname());
  });
  await backend.start();
  if (mode === 'host') {
    try {
      discovery = await startDiscoveryResponder(() => ({ hostName: os.hostname(), port: backend?.info?.port ?? cfg.hostPort, fingerprintShort: shortFingerprint(cert.fingerprint), appVersion: app.getVersion() }));
    } catch (e: any) {
      log('discovery', `responder not started (${e.message}); clients can still connect by IP address`);
    }
  }
}

async function stopLocal() {
  discovery?.close();
  discovery = null;
  if (backend) await backend.stop();
  backend = null;
}

async function local<T = any>(p: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  if (!backend?.info) throw new Error('The pharmacy backend is not running on this computer.');
  return pinnedJson<T>(`https://127.0.0.1:${backend.info.port}${p}`, backend.info.fingerprint, {
    method,
    headers: { 'x-local-token': backend.info.localToken, 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function connectClient(): Promise<boolean> {
  const c = cfg.client;
  if (!c) return false;
  const token = await unprotect({ enc: c.clientTokenEnc, plain: c.clientTokenPlain });
  if (!token) { log('client', 'stored client token cannot be decrypted; pairing again is required'); return false; }
  const host = c.address.includes(':') ? `[${c.address}]` : c.address;
  conn.setTarget({ base: `https://${host}:${c.port}`, fingerprint: c.fingerprint, clientToken: token, isLocal: false }, c.hostName);
  return true;
}

// ---------------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------------
function registerIpc() {
  handle('app:info', S.none, () => ({ ...appInfo(), mode: cfg.mode }));
  handle('conn:state', S.none, () => conn.state);

  handle('setup:state', S.none, async () => {
    const out: any = { mode: cfg.mode, computerName: cfg.computerName || os.hostname(), hasDatabase: fs.existsSync(paths.db()), encryptionAvailable: await canEncrypt(), hostPort: cfg.hostPort };
    if (cfg.mode && cfg.mode !== 'client' && backend?.info) {
      const st = await local('/api/setup/status');
      out.needsSetup = st.body?.needsSetup;
      out.storeName = st.body?.storeName;
    }
    if (cfg.mode === 'client' && cfg.client) out.client = { address: cfg.client.address, port: cfg.client.port, hostName: cfg.client.hostName, fingerprintShort: shortFingerprint(cfg.client.fingerprint) };
    out.connection = conn.state;
    return out;
  });

  handle('setup:start-local', S.localMode, async ({ mode }) => {
    if (cfg.mode && cfg.mode !== mode) throw new Error(`This computer is already set up in ${cfg.mode} mode. Use "Change mode" in Connection & Server Settings.`);
    cfg = { ...cfg, mode, computerName: cfg.computerName || os.hostname() };
    saveConfig(cfg);
    await startLocal(mode);
    const st = await local('/api/setup/status');
    return { needsSetup: st.body?.needsSetup, storeName: st.body?.storeName };
  });

  handle('setup:import-legacy', S.localMode, async ({ mode }, e) => {
    if (fs.existsSync(paths.db())) {
      const st = backend?.info ? (await local('/api/setup/status')).body : null;
      if (!st?.needsSetup) throw new Error('This computer already has a pharmacy database. Importing would replace it, so it was not done.');
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Choose the database from the previous version (khushi_pharmacy.sqlite)',
      properties: ['openFile'],
      filters: [{ name: 'Pharmacy database', extensions: ['sqlite', 'db'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { imported: false };
    await stopLocal();
    // an empty database created a moment ago by the backend is moved aside, never deleted
    if (fs.existsSync(paths.db())) {
      const aside = `${paths.db()}.empty-before-import-${Date.now()}`;
      for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(paths.db() + ext)) fs.renameSync(paths.db() + ext, aside + ext);
    }
    const result = await importLegacyDatabase(pick.filePaths[0], paths.db()); // copy only: the source is never modified
    log('import', `imported legacy database (${Object.values(result.rowCounts).reduce((a, b) => a + b, 0)} rows), source unchanged`);
    cfg = { ...cfg, mode, computerName: cfg.computerName || os.hostname() };
    saveConfig(cfg);
    await startLocal(mode); // migrations run here, with their own verified backup
    const st = await local('/api/setup/status');
    return { imported: true, rowCounts: result.rowCounts, needsSetup: st.body?.needsSetup, storeName: st.body?.storeName };
  });

  handle('setup:create-admin', S.createAdmin, async (data) => {
    const r = await local('/api/setup/initial-admin', 'POST', data);
    if (r.status !== 200) throw new Error(r.body?.error || `Setup failed (HTTP ${r.status})`);
    return r.body;
  });

  handle('setup:discover', S.none, () => discoverHosts({ timeoutMs: 2000 }));

  handle('setup:pair', S.pair, async ({ host, port, code, computerName }) => {
    if (cfg.mode && cfg.mode !== 'client') throw new Error('This computer is set up as a server. Change the mode first.');
    const p = await pairWithHost({ host, port, code, clientName: computerName });
    const tok = await protect(p.clientToken);
    cfg = { ...cfg, mode: 'client', computerName, client: { address: host, port, fingerprint: p.fingerprint, clientId: p.clientId, hostName: p.hostName, clientTokenEnc: tok.enc, clientTokenPlain: tok.plain } };
    saveConfig(cfg);
    await connectClient();
    conn.startMonitoring();
    log('client', `paired with ${p.hostName} at ${host}:${port}`);
    return { hostName: p.hostName, fingerprintShort: shortFingerprint(p.fingerprint), serverVersion: p.appVersion };
  });

  handle('setup:finish', S.none, () => { show('app'); return { ok: true }; });

  handle('setup:reset-connection', S.none, async (_a, e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const ok = await confirm(win, 'Change how this computer is used?', cfg.mode === 'client'
      ? 'This computer will forget the pharmacy server it is paired with. No pharmacy data is deleted (it is stored on the server).'
      : 'The pharmacy server on this computer will stop. The database and backups stay in the data folder and are NOT deleted.', 'Change mode');
    if (!ok) return { reset: false };
    await stopLocal();
    conn.setTarget(null);
    cfg = { ...cfg, mode: null, client: undefined };
    saveConfig(cfg);
    show('setup');
    return { reset: true };
  });

  handle('server:status', S.none, async () => {
    if (!backend?.info) return { running: false, mode: cfg.mode, connection: conn.state, client: cfg.client ? { address: cfg.client.address, port: cfg.client.port, hostName: cfg.client.hostName, fingerprintShort: shortFingerprint(cfg.client.fingerprint) } : null };
    const r = await local('/api/local/host-status');
    return { running: true, ...r.body, dataFolder: dataRoot(), firewallHint: cfg.mode === 'host' ? `Allow TCP ${cfg.hostPort} and UDP 3748 on Private networks` : null };
  });
  handle('server:rotate-code', S.none, async () => (await local('/api/local/pairing/rotate', 'POST', {})).body);
  handle('server:revoke-client', S.revoke, async ({ id }, e) => {
    const ok = await confirm(BrowserWindow.fromWebContents(e.sender), 'Remove this computer?', 'It will no longer be able to use the pharmacy server until it is paired again.', 'Remove');
    return ok ? (await local(`/api/local/clients/${id}/revoke`, 'POST', {})).body : { revoked: false };
  });

  handle('window:connection-settings', S.none, () => { show('manage'); return { ok: true }; });

  handle('print:printers', S.none, async (_a, e) => {
    const list = await e.sender.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: (p as any).isDefault ?? false }));
  });
  handle('print:html', S.printHtml, async ({ html, printer, silent, landscape, pageSize }) => {
    // printed in a hidden, sandboxed window with JavaScript disabled
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const size = pageSize === '80mm' ? { width: 80000, height: 297000 } : pageSize === '58mm' ? { width: 58000, height: 297000 } : pageSize;
      return await new Promise((resolve) => {
        w.webContents.print({ silent: !!silent, deviceName: printer, landscape: !!landscape, pageSize: size as any, printBackground: true }, (success, failureReason) => resolve({ success, failureReason }));
      });
    } finally {
      w.destroy();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// boot / quit
// ---------------------------------------------------------------------------------------------
async function boot() {
  hardenSession();
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  protocol.handle('app', (req) => conn.handle(req));
  cfg = loadConfig();
  log('app', `starting ${app.getVersion()} in ${cfg.mode ?? 'setup'} mode, data folder ${dataRoot()}`);
  registerIpc();
  buildMenu();

  if (!cfg.mode) return show('setup');
  if (cfg.mode === 'client') {
    if (!(await connectClient())) return show('manage');
    conn.startMonitoring();
    return show('app');
  }
  try {
    await startLocal(cfg.mode);
  } catch (e: any) {
    // Show the settings page with the reason (never a blocking box before any window exists)
    log('fatal', `backend could not start: ${e.message}`);
    conn.setState({ status: 'BACKEND_FAILED', detail: `${e.message} Logs: ${safeLogDir()}`, isLocal: true });
    return show('manage');
  }
  conn.startMonitoring();
  const st = await local('/api/setup/status').catch(() => null);
  show(st?.body?.needsSetup ? 'setup' : 'app');
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (!backend) return;
  e.preventDefault();
  quitting = true;
  conn.stopMonitoring();
  const b = backend;
  backend = null;
  discovery?.close();
  b.stop().finally(() => app.quit());
});

// expose for diagnostics in tests only
if (process.env.BRAINTECH_E2E === '1') (globalThis as any).__braintech = { conn, get cfg() { return cfg; }, renewLocalCertificate, z };
