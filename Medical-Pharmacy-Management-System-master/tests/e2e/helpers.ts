/**
 * Launch the real desktop app (Electron + bundled UI + utilityProcess backend) with Playwright.
 * Each instance gets its own data folder and Electron profile, so a host and a client can run
 * side by side on one machine. Requires `npm run build:desktop` first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(__filename);
// Playwright is provided by the environment (global install), not a project dependency; only its Electron
// driver is used, which needs no downloaded browsers. Loose types keep the project typecheck independent of it.
const { _electron } = require_('playwright') as { _electron: { launch(o: Record<string, unknown>): Promise<any> } };
type ElectronApplication = any;
type Page = any;
export const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = require_(path.join(ROOT, 'node_modules', 'electron')) as unknown as string;

export interface Instance { app: ElectronApplication; win: Page; dataRoot: string; downloads: string; logs: string[] }

export function tempRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bt-e2e-${name}-`));
}

export async function launch(base: string, extraEnv: Record<string, string> = {}): Promise<Instance> {
  const dataRoot = path.join(base, 'data');
  const downloads = path.join(base, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, BRAINTECH_DATA_ROOT: dataRoot, BRAINTECH_USER_DATA: path.join(base, 'profile'), BRAINTECH_E2E: '1', BRAINTECH_E2E_DOWNLOADS: downloads, PHARMACY_TEST_LEGACY_SEED: '',
      // fixed pharmacy date (tests only; the backend logs a warning): the demo catalogue's expiry dates must not decide test outcomes
      PHARMACY_TEST_TODAY: '2026-06-01', ...extraEnv },
    timeout: 90_000,
  });
  const logs: string[] = [];
  app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.process().stderr?.on('data', (d) => logs.push(String(d)));
  const win = await app.firstWindow();
  win.on('console', (m) => logs.push(`[renderer ${m.type()}] ${m.text()}`));
  win.on('dialog', (d) => void d.accept()); // window.confirm() in the app
  await win.waitForLoadState('domcontentloaded');
  return { app, win, dataRoot, downloads, logs };
}

/** Close the app gracefully (backend closes the database) and wait for the process to end. */
export async function quit(i: Instance): Promise<void> {
  const proc = i.app.process();
  await Promise.race([i.app.close(), new Promise((r) => setTimeout(r, 20_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

export async function runWizardLocal(win: Page, mode: 'standalone' | 'host', admin: { store: string; owner: string; user: string; password: string; demo?: boolean }) {
  await win.click(`[data-mode="${mode}"]`);
  await win.click('#startFresh');
  await win.waitForSelector('#step-admin:not(.hidden)', { timeout: 60_000 });
  await win.fill('#adminForm [name=storeName]', admin.store);
  await win.fill('#adminForm [name=ownerName]', admin.owner);
  await win.fill('#adminForm [name=username]', admin.user);
  await win.fill('#adminForm [name=password]', admin.password);
  await win.fill('#adminForm [name=password2]', admin.password);
  if (admin.demo) await win.check('#adminForm [name=loadDemoData]');
  await win.click('#adminForm button[type=submit]');
  await win.waitForSelector('#step-done:not(.hidden)', { timeout: 30_000 });
  await win.click('#finish');
  await win.waitForURL('app://braintech/index.html', { timeout: 30_000 });
}

export async function loginUi(win: Page, user: string, password: string) {
  // a still-valid session opens the POS directly
  const first = await Promise.race([
    win.waitForSelector('input[placeholder="Enter username or email"]', { timeout: 30_000 }).then(() => 'login'),
    win.waitForSelector('input[placeholder^="Scan Barcode or Search Medicine"]', { timeout: 30_000 }).then(() => 'pos'),
  ]);
  if (first === 'pos') return;
  await win.fill('input[placeholder="Enter username or email"]', user);
  await win.fill('input[type=password]', password);
  await win.click('form button[type=submit]');
  try {
    await win.waitForSelector('input[placeholder^="Scan Barcode or Search Medicine"]', { timeout: 30_000 });
  } catch (e) {
    await win.screenshot({ path: path.join(os.tmpdir(), `bt-e2e-login-failure-${Date.now()}.png`) });
    throw new Error(`login did not reach the POS screen; visible text: ${(await win.evaluate(() => document.body.innerText)).slice(0, 400)}`);
  }
}

/** Turn the app's "Print on Save" off (the native print dialog cannot be driven by a test and blocks the window). */
export async function printOff(win: Page) {
  await win.waitForSelector('button:has-text("Print on Save:")', { timeout: 30_000 });
  if (await win.locator('button:has-text("Print on Save: ON")').count()) {
    await win.click('button:has-text("Print on Save: ON")');
    await win.waitForSelector('button:has-text("Print on Save: OFF")');
  }
}

/** Call the backend from inside the renderer, exactly like the app does (app://braintech/api via the pinned proxy). */
export async function apiFromRenderer(win: Page, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: any }> {
  return win.evaluate(async ([m, e, b]) => {
    const token = localStorage.getItem('khushi_token');
    const r = await fetch(`/api${e}`, {
      method: m as string,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: parsed };
  }, [method, endpoint, body] as const);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
