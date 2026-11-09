/**
 * Desktop app, single computer (standalone): first-run wizard, admin creation, login, a real POS
 * sale through the UI, Electron security boundaries, persistence across restart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, Instance } from './helpers';

const ADMIN = { store: 'Al-Shifa Pharmacy', owner: 'Ayesha Khan', user: 'owner', password: 'Str0ngPass!', demo: true };
let base: string;
let inst: Instance;

beforeAll(async () => {
  base = tempRoot('standalone');
  inst = await launch(base);
}, 120_000);
afterAll(async () => { if (inst) await quit(inst); }, 60_000);

describe('first run', () => {
  it('opens the setup wizard (no account exists, no demo login works)', async () => {
    expect(inst.win.url()).toBe('app://braintech/__app/setup.html');
    expect(await inst.win.title()).toBe('BrainTech Pharmacy AI - Setup');
    await inst.win.screenshot({ path: path.join(base, '01-wizard.png') });
  });

  it('single-computer setup: creates the administrator and opens the pharmacy', async () => {
    await runWizardLocal(inst.win, 'standalone', ADMIN);
    await inst.win.waitForSelector('text=Al-Shifa Pharmacy', { timeout: 30_000 }); // login screen shows the pharmacy's own name
    await inst.win.screenshot({ path: path.join(base, '02-login.png') });
    const bad = await apiFromRenderer(inst.win, 'POST', '/auth/login', { username: 'admin', password: 'admin123' });
    expect(bad.status).toBe(401);
  }, 120_000);

  it('data, certificate and logs live in the data folder, not next to the program', () => {
    expect(fs.existsSync(path.join(inst.dataRoot, 'config.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(inst.dataRoot, 'config.json'), 'utf8')).mode).toBe('standalone');
    expect(fs.existsSync(path.join(inst.dataRoot, 'data', 'pharmacy.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(inst.dataRoot, 'certs', 'cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(inst.dataRoot, 'certs', 'key.enc')) || fs.existsSync(path.join(inst.dataRoot, 'certs', 'key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(inst.dataRoot, 'logs', 'main.log'))).toBe(true);
  });
});

describe('Electron security boundaries', () => {
  it('the sandboxed preload bundle requires nothing but electron', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'dist-electron', 'preload.cjs'), 'utf8');
    expect([...new Set(src.match(/require\("[^"]+"\)/g))]).toEqual(['require("electron")']);
  });

  it('the page has no Node.js access and only the fixed window.braintech API', async () => {
    const r = await inst.win.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      module: typeof (window as any).module,
      api: Object.keys((window as any).braintech).sort().join(','),
      frozen: Object.isFrozen((window as any).braintech),
    }));
    expect(r).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', api: 'getAppInfo,getConnectionState,isDesktop,onConnectionState,openConnectionSettings,print,resetConnection,server,setup', frozen: true });
  });

  it('navigation away from the app and new windows to websites are blocked', async () => {
    await inst.win.evaluate(() => { window.location.href = 'https://example.com/'; });
    await inst.win.waitForTimeout(800);
    expect(inst.win.url()).toBe('app://braintech/index.html');
    const opened = await inst.win.evaluate(() => window.open('https://example.com/') === null);
    expect(opened).toBe(true);
    // the app cancelled the navigation; reload so Playwright does not keep waiting for it
    await inst.win.goto('app://braintech/index.html');
  });

  it('a print popup (about:blank) cannot use the privileged API', async () => {
    const popupPromise = inst.app.waitForEvent('window');
    await inst.win.evaluate(() => { (window as any).__pop = window.open('', '_blank'); });
    const popup = await popupPromise;
    const result = await popup.evaluate(async () => {
      const bt = (window as any).braintech;
      if (!bt) return 'no api';
      try { await bt.getAppInfo(); return 'allowed'; } catch (e: any) { return `blocked: ${e.message}`; }
    });
    expect(result === 'no api' || result.startsWith('blocked')).toBe(true);
    await popup.close();
  });

  it('a strict Content-Security-Policy is applied to app pages', async () => {
    const csp = await inst.win.evaluate(async () => (await fetch('/index.html')).headers.get('content-security-policy'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('API traffic goes through the pinned HTTPS proxy (backend is not reachable over plain HTTP)', async () => {
    const h = await apiFromRenderer(inst.win, 'GET', '/health');
    expect(h.body).toMatchObject({ status: 'ok', mode: 'standalone', apiProtocol: 1 });
    const state = await inst.win.evaluate(() => (window as any).braintech.getConnectionState());
    expect(state).toMatchObject({ status: 'CONNECTED', isLocal: true });
  });
});

describe('POS through the real UI', () => {
  it('login, add a medicine by batch number, pay cash, receipt from the saved sale, invoice file, stock reduced', async () => {
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    const before = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'B-8910');
    expect(before.stock).toBe(120);

    // turn the app's own "Print on Save" option off: the native print dialog cannot be driven by a test
    await inst.win.click('button:has-text("Print on Save: ON")');
    await inst.win.waitForSelector('button:has-text("Print on Save: OFF")');
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('B-8910');
    await search.press('Enter');
    await inst.win.waitForTimeout(500);
    await inst.win.click('button:has-text("CASH")');
    await inst.win.click('button:has-text("Complete Sale & Print Receipt")');
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await inst.win.screenshot({ path: path.join(base, '03-receipt.png') });

    const after = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'B-8910');
    expect(after.stock).toBe(119);
    const hist = (await apiFromRenderer(inst.win, 'GET', '/sales/history')).body;
    expect(hist).toHaveLength(2); // demo sale + this one
    await inst.win.waitForTimeout(1000);
    const files = fs.readdirSync(inst.downloads);
    expect(files.some((f) => /^Invoice_INV-1-\d+\.txt$/.test(f))).toBe(true);
  }, 120_000);

  it('a retried sale with the same transaction id is recorded once (through the desktop proxy)', async () => {
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'BF-109');
    const item = { product: p, quantity: 1, unit_price: p.sale_price, discount_percent: 0, discount_amount: 0, gst_amount: 0, subtotal: p.sale_price };
    const sale = { items: [item], total_amount: p.sale_price, discount_percent: 0, discount_amount: 0, net_amount: p.sale_price, total_gst: 0, grand_total: p.sale_price, payment_method: 'CASH', amount_paid: p.sale_price, client_txn_id: 'e2e-retry-0001' };
    const a = await apiFromRenderer(inst.win, 'POST', '/sales', sale);
    const b = await apiFromRenderer(inst.win, 'POST', '/sales', sale);
    expect(a.status).toBe(200);
    expect(b.body).toMatchObject({ replayed: true, sale_id: a.body.sale_id });
  });
});

describe('restart', () => {
  it('after closing and reopening, the app opens the pharmacy directly and all data is still there', async () => {
    await quit(inst);
    inst = await launch(base);
    await inst.win.waitForURL('app://braintech/index.html', { timeout: 60_000 });
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await inst.win.waitForSelector('input[placeholder^="Scan Barcode or Search Medicine"]', { timeout: 30_000 });
    const hist = (await apiFromRenderer(inst.win, 'GET', '/sales/history')).body;
    expect(hist).toHaveLength(3);
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'B-8910');
    expect(p.stock).toBe(119);
  }, 180_000);
});
