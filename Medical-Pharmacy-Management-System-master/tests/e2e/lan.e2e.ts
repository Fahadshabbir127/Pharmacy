/**
 * Two real desktop app instances on one machine: a HOST (owns the database) and a CLIENT
 * (no local database), paired over HTTPS through the real wizard.
 *
 * Limits of this environment (documented in TESTING_REPORT.md):
 *  - both instances run on one computer, so the client reaches the host over 127.0.0.1;
 *    the "paired client token required from the LAN" rule is covered by unit tests
 *  - UDP discovery cannot be exercised here (the container's only interface is not a private LAN)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, printOff, Instance, sleep } from './helpers';

const ADMIN = { store: 'Shifa Medical Store', owner: 'Owner', user: 'owner', password: 'Str0ngPass!', demo: true };
let hostBase: string;
let clientBase: string;
let host: Instance;
let client: Instance;
let crashMarker: string;
const hostEnv = () => ({ PHARMACY_TEST_CRASH: 'after-commit:POST /api/sales', PHARMACY_TEST_CRASH_ONCE_FILE: crashMarker });

async function waitForState(i: Instance, status: string, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await i.win.evaluate(() => (window as any).braintech.getConnectionState());
    if (s.status === status) return s;
    if (Date.now() > until) throw new Error(`connection state stayed ${s.status} (wanted ${status})`);
    await sleep(500);
  }
}

beforeAll(async () => {
  hostBase = tempRoot('host');
  clientBase = tempRoot('client');
  crashMarker = path.join(hostBase, 'crash-once.marker');
  fs.writeFileSync(crashMarker, 'armed later'); // disarmed until the crash test removes it
  host = await launch(hostBase, hostEnv());
  await runWizardLocal(host.win, 'host', ADMIN);
  await loginUi(host.win, ADMIN.user, ADMIN.password);
  client = await launch(clientBase);
}, 240_000);

afterAll(async () => {
  if (client) await quit(client);
  if (host) await quit(host);
}, 90_000);

describe('pairing', () => {
  it('the host shows its pairing details; the client pairs through the wizard with the code', async () => {
    const st = await host.win.evaluate(() => (window as any).braintech.server.status());
    expect(st).toMatchObject({ running: true, mode: 'host', port: 3747 });
    expect(st.pairing.code).toMatch(/^[A-Z2-9]{8}$/);

    await client.win.click('[data-mode="client"]');
    await client.win.fill('#pairForm [name=host]', '127.0.0.1');
    await client.win.fill('#pairForm [name=port]', '3747');
    await client.win.fill('#pairForm [name=code]', 'WRONGCOD');
    await client.win.fill('#pairForm [name=computerName]', 'Billing Counter');
    await client.win.click('#pairForm button[type=submit]');
    await client.win.waitForSelector('#error:not(.hidden)');
    expect(await client.win.textContent('#error')).toMatch(/code is wrong|intercepted/);

    await client.win.fill('#pairForm [name=code]', st.pairing.code);
    await client.win.click('#pairForm button[type=submit]');
    await client.win.waitForSelector('#step-done:not(.hidden)', { timeout: 30_000 });
    expect(await client.win.textContent('#doneSummary')).toMatch(/Connected to/);
    await client.win.screenshot({ path: path.join(clientBase, '01-paired.png') });
    await client.win.click('#finish');
    await client.win.waitForURL('app://braintech/index.html');

    const after = await host.win.evaluate(() => (window as any).braintech.server.status());
    expect(after.clients.map((c: any) => c.name)).toEqual(['Billing Counter']);
    const cfg = JSON.parse(fs.readFileSync(path.join(client.dataRoot, 'config.json'), 'utf8'));
    expect(cfg.mode).toBe('client');
    expect(cfg.client.fingerprint).toBe(st.fingerprint);
    expect(fs.existsSync(path.join(client.dataRoot, 'data', 'pharmacy.sqlite'))).toBe(false); // a client keeps no database
  }, 120_000);
});

describe('shared data between the two computers', () => {
  it('the client signs in with the host\'s account and sees the host\'s stock', async () => {
    await loginUi(client.win, ADMIN.user, ADMIN.password);
    const inv = (await apiFromRenderer(client.win, 'GET', '/inventory')).body;
    expect(inv).toHaveLength(12);
    const state = await waitForState(client, 'CONNECTED');
    expect(state.isLocal).toBe(false);
  }, 60_000);

  it('a sale made in the client UI updates the host; a stock change on the host is seen by the client', async () => {
    await client.win.click('button:has-text("Print on Save: ON")');
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('RK-221'); // Risek, stock 60
    await search.press('Enter');
    await client.win.waitForTimeout(400);
    await client.win.click('button:has-text("CASH")');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await client.win.click('button:text-is("Close")');

    const onHost = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'RK-221');
    expect(onHost.stock).toBe(59);
    const hist = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body;
    expect(hist.length).toBe(2);

    const adj = await apiFromRenderer(host.win, 'POST', '/inventory/adjust', { product_id: onHost.id, adjustment_type: 'ADD', quantity: 10, reason: 'Delivery' });
    expect(adj.status).toBe(200);
    const onClient = (await apiFromRenderer(client.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'RK-221');
    expect(onClient.stock).toBe(69);
  }, 90_000);
});

describe('Phase 6: batches across host and client', () => {
  it('a client UI sale spanning two batches is allocated on the host; both computers see the same batch quantities', async () => {
    const brufen = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'BF-109');
    expect(brufen.stock).toBe(80);
    const pur = await apiFromRenderer(host.win, 'POST', '/purchases', { supplier_id: brufen.supplier_id, items: [{ product_id: brufen.id, quantity: 2, purchase_price: 130, batch_number: 'BF-EARLY', expiry_date: '2026-12-31' }] });
    expect(pur.status).toBe(200);

    await client.win.goto('app://braintech/index.html'); // reload the POS product list
    await loginUi(client.win, ADMIN.user, ADMIN.password);
    await printOff(client.win);
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('BF-EARLY');
    await search.press('Enter');
    await client.win.locator('input[title="Click to type quantity manually"]').fill('3');
    await client.win.waitForTimeout(300);
    await client.win.click('button:has-text("CASH")');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    const cell = (await client.win.locator('[data-testid="receipt-batches"]').first().innerText()).replace(/\s+/g, ' ');
    expect(cell).toContain('BF-EARLY ×2');
    expect(cell).toContain('BF-109 ×1');
    await client.win.screenshot({ path: path.join(clientBase, '05-client-multibatch.png') });
    await client.win.click('button:text-is("Close")');

    const view = async (i: Instance) => (await apiFromRenderer(i.win, 'GET', `/inventory/${brufen.id}/batches?include_empty=true`)).body.batches.map((b: any) => [b.batch_number, b.qty_on_hand]);
    expect(await view(host)).toEqual([['BF-EARLY', 0], ['BF-109', 79]]);
    expect(await view(client)).toEqual(await view(host));
  }, 120_000);

  it('host and client sell the last unit at the same moment: exactly one sale succeeds, the other is refused, stock is 0 on both', async () => {
    const c = await apiFromRenderer(host.win, 'POST', '/inventory', { name: 'E2E Last Vial', unit: 'Vial', purchase_price: 100, sale_price: 150 });
    await apiFromRenderer(host.win, 'POST', '/inventory/adjust', { product_id: c.body.id, adjustment_type: 'ADD', quantity: 1, reason: 'E2E', reason_code: 'COUNT_CORRECTION', batch_number: 'V-1', expiry_date: '2027-06-30' });
    const p = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((x: any) => x.id === c.body.id);
    const sale = { items: [{ product: p, quantity: 1, unit_price: 150, discount_percent: 0, discount_amount: 0, gst_amount: 0, subtotal: 150 }], total_amount: 150, discount_percent: 0, discount_amount: 0, net_amount: 150, total_gst: 0, grand_total: 150, payment_method: 'CASH', amount_paid: 150 };
    const [a, b] = await Promise.all([apiFromRenderer(host.win, 'POST', '/sales', sale), apiFromRenderer(client.win, 'POST', '/sales', sale)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', requested: 1, available: 0 });
    for (const i of [host, client]) {
      const now = (await apiFromRenderer(i.win, 'GET', '/inventory')).body.find((x: any) => x.id === c.body.id);
      expect(now).toMatchObject({ stock: 0, sellable_stock: 0 });
    }
  }, 60_000);
});

describe('Phase 7 Batch 1: the host prices sales made on a client', () => {
  it('a price changed on the host while the client cart is open: the client shows and charges the host price; both computers agree', async () => {
    await client.win.goto('app://braintech/index.html');
    await loginUi(client.win, ADMIN.user, ADMIN.password);
    await printOff(client.win);
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('AG-442'); // Augmentin, Rs. 380 in the client's loaded list
    await search.press('Enter');
    await client.win.waitForSelector('input[title="Click to type quantity manually"]');
    const p = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'AG-442');
    expect((await apiFromRenderer(host.win, 'PUT', `/inventory/${p.id}`, { ...p, sale_price: 400 })).status).toBe(200);

    await client.win.click('button:has-text("CASH")');
    await client.win.waitForSelector('[data-testid="price-notice"]', { timeout: 15_000 });
    expect(await client.win.locator('[data-testid="server-grand-total"]').innerText()).toBe('Rs. 400.00');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await client.win.click('button:text-is("Close")');

    const latest = async (i: Instance) => {
      const hist = (await apiFromRenderer(i.win, 'GET', '/sales/history')).body;
      const s = hist.reduce((a: any, b: any) => (a.id > b.id ? a : b));
      return (await apiFromRenderer(i.win, 'GET', `/sales/${s.id}`)).body;
    };
    const onHost = await latest(host);
    expect(onHost).toMatchObject({ grand_total: 400, amount_paid: 400, payment_status: 'PAID' });
    expect(onHost.items[0]).toMatchObject({ sale_price: 400, subtotal: 400 });
    const onClient = await latest(client);
    expect({ id: onClient.id, total: onClient.grand_total, items: onClient.items.map((i: any) => [i.product_id, i.sale_price, i.subtotal]) })
      .toEqual({ id: onHost.id, total: onHost.grand_total, items: onHost.items.map((i: any) => [i.product_id, i.sale_price, i.subtotal]) });
  }, 120_000);
});

describe('host crash after saving a sale, before answering (the hardest case)', () => {
  it('the client shows SALE NOT CONFIRMED, keeps the cart; "Check status" finds the saved sale exactly once', async () => {
    fs.rmSync(crashMarker); // arm the one-shot crash: the host backend dies right after COMMIT of the next sale
    const before = (await apiFromRenderer(client.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'HY-908').stock;
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('HY-908'); // Hydryllin
    await search.press('Enter');
    await client.win.waitForTimeout(400);
    await client.win.click('button:has-text("CASH")');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');

    await client.win.waitForSelector('text=SALE NOT CONFIRMED', { timeout: 40_000 });
    await client.win.screenshot({ path: path.join(clientBase, '02-not-confirmed.png') });
    expect(fs.existsSync(crashMarker)).toBe(true); // the host really crashed

    // the host app restarts its backend by itself; the client reconnects
    await waitForState(client, 'CONNECTED', 60_000);
    await client.win.click('button:has-text("Check status")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await client.win.screenshot({ path: path.join(clientBase, '03-confirmed-after-check.png') });

    const after = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'HY-908').stock;
    expect(after).toBe(before - 1); // recorded exactly once
    const sales = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body;
    expect(sales.length).toBe(6); // demo + client sale + client multi-batch sale + last-unit race winner + host-priced client sale + this one
  }, 180_000);
});

describe('host computer switched off', () => {
  it('the client blocks selling while the host is away and recovers when it is back', async () => {
    await quit(host);
    await waitForState(client, 'DISCONNECTED', 40_000);
    await client.win.waitForSelector('[data-testid="connection-overlay"]', { timeout: 10_000 });
    await client.win.screenshot({ path: path.join(clientBase, '04-host-away.png') });
    const attempt = await apiFromRenderer(client.win, 'GET', '/inventory');
    expect(attempt.status).toBe(503);
    expect(attempt.body).toMatchObject({ code: 'HOST_UNREACHABLE', outcome: 'UNKNOWN' });

    host = await launch(hostBase, hostEnv());
    await waitForState(client, 'CONNECTED', 60_000);
    await client.win.waitForSelector('[data-testid="connection-overlay"]', { state: 'detached', timeout: 10_000 });
    expect((await apiFromRenderer(client.win, 'GET', '/inventory')).status).toBe(200);
  }, 180_000);
});
