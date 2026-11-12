/**
 * Desktop app, single computer (standalone): first-run wizard, admin creation, login, a real POS
 * sale through the UI, Electron security boundaries, persistence across restart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, printOff, Instance } from './helpers';

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
    expect(h.body).toMatchObject({ status: 'ok', mode: 'standalone', apiProtocol: 4 });
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

describe('Phase 6: batches through the real UI (pharmacy date 2026-06-01)', () => {
  const cartQty = () => inst.win.locator('input[title="Click to type quantity manually"]');
  const posReload = async () => {
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await printOff(inst.win);
  };
  const completeCashSale = async () => {
    await inst.win.click('button:has-text("CASH")');
    await inst.win.click('button:has-text("Complete Sale & Print Receipt")');
  };

  it('a purchase entered in the Purchases screen becomes a new batch; the older batch is unchanged', async () => {
    await posReload(); // closes the receipt left open by the previous test
    await inst.win.click('button:has-text("Purchases & Stock-In")');
    await inst.win.waitForSelector('text=Add Purchased Medicine Items', { timeout: 30_000 });
    const panadol = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((p: any) => p.name.startsWith('Panadol'));
    await inst.win.locator('select').filter({ hasText: 'Select Item...' }).selectOption(String(panadol.id));
    await inst.win.fill('input[aria-label="Purchase quantity"]', '3');
    await inst.win.fill('input[aria-label="Batch number"]', 'B-EARLY-UI');
    await inst.win.fill('input[aria-label="Expiry date"]', '2026-09-30');
    await inst.win.fill('input[aria-label="Manufacturing date"]', '2026-01-15');
    await inst.win.getByRole('button', { name: 'Add', exact: true }).click();
    await inst.win.waitForSelector('td:has-text("B-EARLY-UI")');
    await inst.win.click('button:has-text("Confirm Stock-In & Update Inventory")');
    const until = Date.now() + 20_000;
    let batches: any[] = [];
    while (Date.now() < until) {
      batches = (await apiFromRenderer(inst.win, 'GET', `/inventory/${panadol.id}/batches`)).body.batches;
      if (batches.length === 2) break;
      await inst.win.waitForTimeout(300);
    }
    expect(batches.map((b: any) => [b.batch_number, b.expiry_date, b.mfg_date, b.qty_on_hand, b.source])).toEqual([
      ['B-EARLY-UI', '2026-09-30', '2026-01-15', 3, 'PURCHASE'],
      ['B-8910', '2027-10-15', null, 119, 'OPENING'],
    ]);
    await inst.win.screenshot({ path: path.join(base, '04-purchase.png') });
  }, 120_000);

  it('a POS sale of 5 takes 3 from the earlier-expiring batch and 2 from the next; the receipt shows both', async () => {
    await posReload();
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('B-EARLY-UI'); // the product now shows the batch FEFO sells next
    await search.press('Enter');
    await cartQty().fill('5');
    await inst.win.waitForTimeout(300);
    await completeCashSale();
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    const cell = (await inst.win.locator('[data-testid="receipt-batches"]').first().innerText()).replace(/\s+/g, ' ');
    expect(cell).toContain('B-EARLY-UI ×3');
    expect(cell).toContain('B-8910 ×2');
    await inst.win.screenshot({ path: path.join(base, '05-multibatch-receipt.png') });
    await inst.win.click('button:has-text("Close")');

    const hist = (await apiFromRenderer(inst.win, 'GET', '/sales/history')).body;
    const latest = hist.reduce((a: any, b: any) => (a.id > b.id ? a : b));
    const detail = (await apiFromRenderer(inst.win, 'GET', `/sales/${latest.id}`)).body;
    expect(detail.items[0].batches.map((b: any) => [b.batch_number, b.quantity])).toEqual([['B-EARLY-UI', 3], ['B-8910', 2]]);
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.name.startsWith('Panadol'));
    expect(p).toMatchObject({ stock: 117, batch_number: 'B-8910' });
  }, 120_000);

  it('expired stock cannot be put in the cart; a sale the server refuses (409) keeps the cart and explains why', async () => {
    const mk = async (name: string, qty: number, batch: string, expiry: string) => {
      const c = await apiFromRenderer(inst.win, 'POST', '/inventory', { name, unit: 'Bottle', purchase_price: 50, sale_price: 80 });
      expect(c.status).toBe(200);
      const a = await apiFromRenderer(inst.win, 'POST', '/inventory/adjust', { product_id: c.body.id, adjustment_type: 'ADD', quantity: qty, reason: 'E2E stock', reason_code: 'COUNT_CORRECTION', batch_number: batch, expiry_date: expiry });
      expect(a.status).toBe(200);
      return c.body.id as number;
    };
    await mk('E2E Expired Syrup', 4, 'OLD-1', '2026-05-01');
    const lastId = await mk('E2E Last Units', 2, 'LAST-1', '2027-01-31');
    await posReload();

    await inst.win.click('h4:has-text("E2E Expired Syrup")');
    const refusal = inst.win.locator('[data-testid="stock-refusal"]');
    await refusal.waitFor({ timeout: 10_000 });
    expect(await refusal.innerText()).toMatch(/has expired and cannot be sold/);
    await inst.win.screenshot({ path: path.join(base, '06-expired-refused.png') });
    await refusal.locator('button:has-text("OK")').click();
    expect(await cartQty().count()).toBe(0);

    // two units in the cart; meanwhile another counter sells one of them
    await inst.win.click('h4:has-text("E2E Last Units")');
    await inst.win.click('h4:has-text("E2E Last Units")');
    expect(await cartQty().inputValue()).toBe('2');
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.id === lastId);
    const other = await apiFromRenderer(inst.win, 'POST', '/sales', { items: [{ product: p, quantity: 1, unit_price: 80, discount_percent: 0, discount_amount: 0, gst_amount: 0, subtotal: 80 }], total_amount: 80, discount_percent: 0, discount_amount: 0, net_amount: 80, total_gst: 0, grand_total: 80, payment_method: 'CASH', amount_paid: 80, client_txn_id: 'e2e-other-counter-0001' });
    expect(other.status).toBe(200);

    // Phase 7: the payment screen asks the server first, so the shortage is caught before any money is taken
    await inst.win.click('button:has-text("CASH")');
    await refusal.waitFor({ timeout: 15_000 });
    const msg = await refusal.innerText();
    expect(msg).toMatch(/Sale not saved/);
    expect(msg).toMatch(/2 requested, 1 available/);
    await inst.win.screenshot({ path: path.join(base, '07-sale-refused-409.png') });
    await refusal.locator('button:has-text("OK")').click();
    expect(await cartQty().inputValue()).toBe('2'); // the cart is kept

    await cartQty().fill('1');
    await inst.win.waitForTimeout(300);
    await completeCashSale();
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await inst.win.click('button:has-text("Close")');
    const after = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.id === lastId);
    expect(after).toMatchObject({ stock: 0, sellable_stock: 0 });
  }, 180_000);
});

describe('Phase 6: inventory screen (batches panel, expiry tracker, write-off per batch)', () => {
  it('shows the batches of a product, lists expired stock in the tracker, and writes it off from the right batch', async () => {
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await inst.win.click('button:has-text("Inventory & Stock")');
    await inst.win.waitForSelector('text=Store Inventory Management', { timeout: 30_000 });

    await inst.win.locator('tr', { hasText: 'Panadol Extra' }).getByRole('button', { name: 'Batches' }).click();
    const rows = inst.win.locator('[data-testid="batch-row"]');
    await rows.first().waitFor({ timeout: 15_000 });
    expect(await rows.count()).toBe(1); // B-EARLY-UI is empty and hidden by default
    expect(await rows.first().innerText()).toContain('B-8910');
    await inst.win.check('text=show empty batches');
    await inst.win.waitForFunction(() => document.querySelectorAll('[data-testid="batch-row"]').length === 2);
    await inst.win.screenshot({ path: path.join(base, '08-batch-panel.png') });
    await inst.win.click('button[aria-label="Close batches"]');

    await inst.win.click('button:has-text("Expiry Tracker")');
    const expired = inst.win.locator('[data-testid="expiry-expired"]');
    await expired.waitFor({ timeout: 15_000 });
    expect(await expired.innerText()).toContain('E2E Expired Syrup');
    await inst.win.screenshot({ path: path.join(base, '09-expiry-tracker.png') });
    await inst.win.click('button[aria-label="Close expiry tracker"]');

    await inst.win.locator('tr', { hasText: 'E2E Expired Syrup' }).getByRole('button', { name: 'Adjust' }).click();
    await inst.win.click('button:has-text("- Deduct Stock")');
    await inst.win.waitForFunction(() => !!Array.from(document.querySelectorAll('select[aria-label="Batch"] option')).find((o) => o.textContent?.includes('OLD-1')));
    await inst.win.locator('form', { hasText: 'Stock Adjustment' }).locator('input[type=number]').fill('4');
    await inst.win.selectOption('form:has-text("Stock Adjustment") select:not([aria-label="Batch"])', 'Expired Product Disposal');
    await inst.win.click('button:has-text("Confirm Adjustment")');
    await inst.win.waitForSelector('text=Confirm Adjustment', { state: 'detached', timeout: 15_000 });
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.name === 'E2E Expired Syrup');
    expect(p).toMatchObject({ stock: 0, expired_stock: 0 });
  }, 120_000);
});

describe('Phase 7 Batch 1: the host prices every sale (real UI)', () => {
  const reload = async () => {
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await printOff(inst.win);
  };
  const latestSale = async () => {
    const hist = (await apiFromRenderer(inst.win, 'GET', '/sales/history')).body;
    return hist.reduce((a: any, b: any) => (a.id > b.id ? a : b));
  };

  it('a price changed on the host while the cart is open: the payment screen shows the server total and the sale is charged at it', async () => {
    await reload();
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('BF-109'); // Brufen, Rs. 175 when the POS loaded its list
    await search.press('Enter');
    await inst.win.waitForSelector('input[title="Click to type quantity manually"]');
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'BF-109');
    expect((await apiFromRenderer(inst.win, 'PUT', `/inventory/${p.id}`, { ...p, sale_price: 180 })).status).toBe(200);

    await inst.win.click('button:has-text("CASH")');
    await inst.win.waitForSelector('[data-testid="price-notice"]', { timeout: 15_000 });
    expect(await inst.win.locator('[data-testid="server-grand-total"]').innerText()).toBe('Rs. 180.00');
    await inst.win.screenshot({ path: path.join(base, '10-server-total-price-changed.png') });
    await inst.win.click('button:has-text("Complete Sale & Print Receipt")');
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await inst.win.click('button:has-text("Close")');
    const s = await latestSale();
    expect(s).toMatchObject({ grand_total: 180, amount_paid: 180, payment_status: 'PAID' });
  }, 120_000);

  it('a staff cashier needs an administrator to authorize a discount; the sale is charged the server figure', async () => {
    const created = await apiFromRenderer(inst.win, 'POST', '/users', { username: 'counter1', password: 'Counter123', fullName: 'Counter One', role: 'STAFF' });
    expect(created.status).toBe(200);
    // sign in as the staff cashier
    const login = await apiFromRenderer(inst.win, 'POST', '/auth/login', { username: 'counter1', password: 'Counter123' });
    expect(login.status).toBe(200);
    await inst.win.evaluate((b: any) => { localStorage.setItem('khushi_token', b.token); localStorage.setItem('khushi_user', JSON.stringify(b.user)); }, login.body);
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, 'counter1', 'Counter123');
    await printOff(inst.win);

    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('RK-221'); // Risek, Rs. 310
    await search.press('Enter');
    await inst.win.waitForSelector('input[title="Click to type quantity manually"]');
    await inst.win.fill('input[title^="Discounts above the staff limit"]', '10');
    await inst.win.click('button:has-text("CASH")');
    const box = inst.win.locator('[data-testid="discount-approval"]');
    await box.waitFor({ timeout: 15_000 });
    expect(await box.innerText()).toMatch(/above the staff limit \(0%\)/);
    expect(await inst.win.locator('button:has-text("Complete Sale & Print Receipt")').isDisabled()).toBe(true);

    await inst.win.fill('input[aria-label="Discount reason"]', 'regular customer');
    await inst.win.fill('input[aria-label="Administrator username"]', ADMIN.user);
    await inst.win.fill('input[aria-label="Administrator password"]', 'wrong-password1');
    await inst.win.click('button:has-text("Authorize discount")');
    await inst.win.waitForSelector('text=Administrator name or password is wrong', { timeout: 15_000 });
    await inst.win.fill('input[aria-label="Administrator password"]', ADMIN.password);
    await inst.win.click('button:has-text("Authorize discount")');
    await inst.win.waitForSelector(`text=Authorized by ${ADMIN.owner}`, { timeout: 15_000 });
    expect(await inst.win.locator('[data-testid="server-grand-total"]').innerText()).toBe('Rs. 279.00');
    await inst.win.screenshot({ path: path.join(base, '11-discount-authorized.png') });
    await inst.win.click('button:has-text("Complete Sale & Print Receipt")');
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await inst.win.click('button:has-text("Close")');
    expect(await latestSale()).toMatchObject({ grand_total: 279, discount_percent: 10, discount_amount: 31 });

    // back to the owner for the remaining tests
    await inst.win.evaluate(() => { localStorage.removeItem('khushi_token'); localStorage.removeItem('khushi_user'); });
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    const auditRows = (await apiFromRenderer(inst.win, 'GET', '/audit-logs?limit=50')).body;
    const rows = Array.isArray(auditRows) ? auditRows : auditRows.logs || [];
    expect(rows.some((r: any) => r.action_type === 'DISCOUNT_OVERRIDE' && /Authorized by .*Reason: regular customer/.test(r.description))).toBe(true);
    expect(rows.some((r: any) => r.action_type === 'DISCOUNT_AUTH_FAILED')).toBe(true);
  }, 180_000);
});

describe('restart', () => {
  it('after closing and reopening, the app opens the pharmacy directly and all data is still there', async () => {
    await quit(inst);
    inst = await launch(base);
    await inst.win.waitForURL('app://braintech/index.html', { timeout: 60_000 });
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await inst.win.waitForSelector('input[placeholder^="Scan Barcode or Search Medicine"]', { timeout: 30_000 });
    const hist = (await apiFromRenderer(inst.win, 'GET', '/sales/history')).body;
    expect(hist).toHaveLength(8); // demo + POS + retry + multi-batch + other counter + final + price-changed + staff discount
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'B-8910');
    expect(p.stock).toBe(117);
    const b = (await apiFromRenderer(inst.win, 'GET', `/inventory/${p.id}/batches?include_empty=true`)).body.batches;
    expect(b.map((x: any) => [x.batch_number, x.qty_on_hand])).toEqual([['B-EARLY-UI', 0], ['B-8910', 117]]);
  }, 180_000);
});
