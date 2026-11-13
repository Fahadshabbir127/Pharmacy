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
    const [a, b] = await Promise.all([apiFromRenderer(host.win, 'POST', '/sales', { ...sale, client_txn_id: 'e2e-race-host-0001' }), apiFromRenderer(client.win, 'POST', '/sales', { ...sale, client_txn_id: 'e2e-race-client-0001' })]);
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

describe('Phase 7 Batch 2c: payments between host and client', () => {
  it('a payment recorded in the client UI is on the host at once; a host payment is seen in the client UI; a simultaneous double payment of the same balance is accepted once', async () => {
    await client.win.goto('app://braintech/index.html');
    await loginUi(client.win, ADMIN.user, ADMIN.password);
    await printOff(client.win);
    await client.win.click('button:has-text("Customers & Udhar")');
    await client.win.click('text=Chaudhry Muhammad Ali >> visible=true'); // owes 2450 on INV-1001
    await client.win.click('button:has-text("Receive Payment")');
    await client.win.fill('input[aria-label="Payment amount"]', '450');
    await client.win.click('[data-testid="record-payment"]');
    await client.win.waitForSelector('[data-testid="payment-new-balance"]:has-text("Rs. 2000.00")', { timeout: 15_000 });
    await client.win.screenshot({ path: path.join(clientBase, '06-client-customer-payment.png') });
    await client.win.click('button:has-text("Done")');

    const cust = (await apiFromRenderer(host.win, 'GET', '/customers')).body.find((c: any) => c.name === 'Chaudhry Muhammad Ali');
    expect(cust.current_balance).toBe(2000);
    const onHost = (await apiFromRenderer(host.win, 'GET', `/customers/${cust.id}/payments`)).body;
    // (order-independent: the demo sale is stamped 10:30 of the setup day)
    expect(onHost.map((p: any) => [p.kind, p.amount, p.allocations.map((a: any) => a.invoice_number)]).sort()).toEqual([['CUSTOMER_PAYMENT', 450, ['INV-1001']], ['SALE_TENDER', 200, ['INV-1001']]]);

    // the host records an invoice payment; the client's Sales Register shows it
    const sale = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body.find((s: any) => s.invoice_number === 'INV-1001');
    expect((await apiFromRenderer(host.win, 'POST', `/sales/${sale.id}/payments`, { amount: 300, method: 'CARD', client_txn_id: 'e2e-host-inv-pay-0001' })).status).toBe(200);
    await client.win.click('button:has-text("Sales Register")');
    const panel = client.win.locator('[data-testid="invoice-payments-INV-1001"]');
    await expect.poll(async () => panel.locator('[data-testid="balance-due"]').innerText(), { timeout: 15_000 }).toBe('Rs. 1700.00');
    await client.win.screenshot({ path: path.join(clientBase, '07-client-sales-register-after-host-payment.png') });

    // host and client pay the remaining 1700 at the same moment: exactly one is accepted
    const [a, b] = await Promise.all([
      apiFromRenderer(host.win, 'POST', `/sales/${sale.id}/payments`, { amount: 1700, method: 'CASH', client_txn_id: 'e2e-race-pay-host-01' }),
      apiFromRenderer(client.win, 'POST', `/sales/${sale.id}/payments`, { amount: 1700, method: 'CASH', client_txn_id: 'e2e-race-pay-client-01' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect((a.status === 400 ? a : b).body.code).toBe('OVERPAYMENT');
    for (const i of [host, client]) {
      const d = (await apiFromRenderer(i.win, 'GET', `/sales/${sale.id}`)).body;
      expect(d).toMatchObject({ balance_due: 0, settlement_status: 'PAID' });
      expect((await apiFromRenderer(i.win, 'GET', '/customers')).body.find((c: any) => c.id === cust.id).current_balance).toBe(0);
    }
    await client.win.click('button:has-text("Billing / POS")');
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

describe('Phase 7 Batch 2e: invoice numbers after voids (R4 fixed), across host and client', () => {
  it('older invoices voided by the administrator on the client: new sales from both computers, at the same moment, get new unique numbers; no number is reused', async () => {
    // the host app was restarted above; sign in again if its window needs it
    if ((await apiFromRenderer(host.win, 'GET', '/sales/history')).status === 401) await loginUi(host.win, ADMIN.user, ADMIN.password);
    const before: any[] = (await apiFromRenderer(client.win, 'GET', '/sales/history')).body;
    const issued = new Set(before.map((s) => s.invoice_number));
    // void the oldest voidable invoice and a middle one (paid in full at the sale, so no later payments)
    const voidable = [...before].sort((a, b) => a.id - b.id).filter((s) => s.id > 1 && s.amount_due === 0);
    expect(voidable.length).toBeGreaterThanOrEqual(3);
    const targets = [voidable[0], voidable[Math.floor(voidable.length / 2)]];
    for (const s of targets) {
      const r = await apiFromRenderer(client.win, 'DELETE', `/sales/${s.id}`);
      expect(r.status, `void ${s.invoice_number}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const p = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'BF-109' || x.sellable_stock > 5);
    const sale = (txn: string) => ({ items: [{ product: p, quantity: 1, unit_price: p.sale_price, discount_percent: 0, discount_amount: 0, gst_amount: 0, subtotal: p.sale_price }], total_amount: p.sale_price, discount_percent: 0, discount_amount: 0, net_amount: p.sale_price, total_gst: 0, grand_total: p.sale_price, payment_method: 'CASH', amount_paid: p.sale_price, client_txn_id: txn });
    const res = await Promise.all([
      ...[1, 2, 3].map((i) => apiFromRenderer(host.win, 'POST', '/sales', sale(`e2e-2e-host-${i}`))),
      ...[1, 2, 3].map((i) => apiFromRenderer(client.win, 'POST', '/sales', sale(`e2e-2e-client-${i}`))),
    ]);
    expect(res.map((r) => r.status), JSON.stringify(res.map((r) => r.body))).toEqual([200, 200, 200, 200, 200, 200]);
    const nums = res.map((r) => r.body.invoice_number as string);
    expect(new Set(nums).size).toBe(6);
    for (const n of nums) expect(issued.has(n), `${n} was already issued`).toBe(false);
    const highestBefore = Math.max(...before.map((s) => Number(String(s.invoice_number).split('-').pop())));
    expect(nums.map((n) => Number(n.split('-').pop())).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6].map((i) => highestBefore + i));
    // both computers list the same invoices; the voided numbers are gone and were not issued again
    const onHost = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body.map((s: any) => s.invoice_number).sort();
    const onClient = (await apiFromRenderer(client.win, 'GET', '/sales/history')).body.map((s: any) => s.invoice_number).sort();
    expect(onClient).toEqual(onHost);
    for (const t of targets) expect(onHost).not.toContain(t.invoice_number);
    console.log('[2e LAN] voided', targets.map((t) => t.invoice_number).join(', '), '-> new', [...nums].sort().join(', '));
  }, 120_000);
});
