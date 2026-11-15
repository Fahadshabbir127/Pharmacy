/**
 * Phase 8c, real desktop app (standalone, throw-away data folder, demo data): live refresh of the Customers and
 * Reports screens, hidden screens refreshing once when shown again, and a purchase being entered surviving a live
 * refresh. Changes are made through the API (as another computer would); nothing is clicked on the screen under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, printOff, Instance } from './helpers';

const ADMIN = { store: 'Live Screens Pharmacy', owner: 'Live Owner', user: 'owner', password: 'Str0ngPass!', demo: true };
let inst: Instance;
const w = () => inst.win;
const nav = (label: string) => w().click(`button:has-text("${label}")`);
const customers = async () => (await apiFromRenderer(w(), 'GET', '/customers')).body as any[];
const pay = async (customerId: number, amount: number) => {
  const r = await apiFromRenderer(w(), 'POST', `/customers/${customerId}/payment`, { amount, method: 'CASH', client_txn_id: crypto.randomUUID() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** counts the window's own API requests (the app's api.ts calls the global fetch) */
const countRequests = () => w().evaluate(() => {
  const win = window as any;
  win.__requests = [] as string[];
  if (!win.__fetchWrapped) {
    const orig = window.fetch.bind(window);
    window.fetch = ((input: any, init?: any) => { win.__requests.push(`${(init?.method || 'GET').toUpperCase()} ${typeof input === 'string' ? input : input.url}`); return orig(input, init); }) as typeof fetch;
    win.__fetchWrapped = true;
  }
});
const requests = () => w().evaluate(() => (window as any).__requests as string[]);

beforeAll(async () => {
  inst = await launch(tempRoot('live-screens'));
  await runWizardLocal(inst.win, 'standalone', ADMIN);
  await loginUi(inst.win, ADMIN.user, ADMIN.password);
  await printOff(inst.win);
}, 180_000);
afterAll(async () => { if (inst) await quit(inst); }, 60_000);

describe('Customers screen', () => {
  it('a payment recorded elsewhere updates the list and the selected customer at once; the selection and the search stay', async () => {
    const all = await customers();
    const tariq = all.find((c) => c.name === 'Tariq Mahmood');
    await nav('Customers & Udhar');
    const row = w().locator(`[data-testid="customer-row-${tariq.id}"]`);
    const selected = async (id: number) => /border-emerald-500/.test((await w().locator(`[data-testid="customer-row-${id}"]`).getAttribute('class')) || '');
    // 1. no search: select Tariq (not necessarily the first customer); a refresh keeps him selected
    await row.click();
    await expect.poll(() => selected(tariq.id)).toBe(true);
    await pay(tariq.id, 100);
    await expect.poll(() => row.innerText(), { timeout: 10_000, interval: 150 }).toContain(`Rs. ${Math.round(tariq.current_balance - 100)}`);
    expect(await selected(tariq.id)).toBe(true);
    for (const o of all.filter((c) => c.id !== tariq.id)) expect(await selected(o.id), `${o.name} became selected`).toBe(false);
    // 2. with a search: the refresh keeps the search text and its filtered list
    const search = w().locator('input[placeholder="Search customer by name or phone..."]');
    await search.fill('Tariq');
    await search.press('Enter');
    for (const o of all.filter((c) => c.id !== tariq.id)) await expect.poll(() => w().locator(`[data-testid="customer-row-${o.id}"]`).count()).toBe(0);
    await pay(tariq.id, 50);
    await expect.poll(() => row.innerText(), { timeout: 10_000, interval: 150 }).toContain(`Rs. ${Math.round(tariq.current_balance - 150)}`);
    expect(await search.inputValue()).toBe('Tariq');
    for (const o of all.filter((c) => c.id !== tariq.id)) expect(await w().locator(`[data-testid="customer-row-${o.id}"]`).count(), `${o.name} shown despite the search`).toBe(0);
    expect(await selected(tariq.id)).toBe(true);
  }, 120_000);
});

describe('hidden screens', () => {
  it('a hidden (visited) Customers screen does not reload while hidden; it reloads exactly once when shown again', async () => {
    const tariq = (await customers()).find((c) => c.name === 'Tariq Mahmood');
    await nav('Billing / POS'); // Customers stays mounted but hidden (search "Tariq" still set)
    await countRequests();
    for (const amount of [10, 20, 30]) await pay(tariq.id, amount);
    await new Promise((r) => setTimeout(r, 1500)); // well past the refresh debounce
    const own = (rs: string[]) => rs.filter((r) => r.startsWith('GET ') && (r.includes('search=Tariq') || r.includes(`/customers/${tariq.id}/ledger`)));
    expect(own(await requests()), 'Customers screen reloaded while hidden').toEqual([]);

    await nav('Customers & Udhar');
    const row = w().locator(`[data-testid="customer-row-${tariq.id}"]`);
    await expect.poll(() => row.innerText(), { timeout: 10_000, interval: 150 }).toContain(`Rs. ${Math.round(tariq.current_balance - 60)}`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = own(await requests());
    expect(after.filter((r) => r.includes('search=Tariq'))).toHaveLength(1); // one reload for three changes
    expect(after.filter((r) => r.includes('/ledger'))).toHaveLength(1);
  }, 120_000);
});

describe('Reports screen', () => {
  it('a sale made elsewhere updates the report at once; the chosen dates stay', async () => {
    await nav('Sales & Profit Reports');
    const start = w().locator('input[aria-label="Report start date"]');
    await start.fill('2020-01-01');
    const total = w().locator('[data-testid="report-total-orders"]');
    await expect.poll(() => total.count()).toBe(1);
    const before = Number((await total.innerText()).match(/\d+/)![0]);
    const end = await w().locator('input[aria-label="Report end date"]').inputValue();
    const p = (await apiFromRenderer(w(), 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'BF-109');
    const sale = { items: [{ product: p, quantity: 1, unit_price: p.sale_price, discount_percent: 0, discount_amount: 0, gst_amount: 0, subtotal: p.sale_price }], total_amount: p.sale_price, discount_percent: 0, discount_amount: 0, net_amount: p.sale_price, total_gst: 0, grand_total: p.sale_price, payment_method: 'CASH', amount_paid: p.sale_price, client_txn_id: crypto.randomUUID() };
    expect((await apiFromRenderer(w(), 'POST', '/sales', sale)).status).toBe(200);
    await expect.poll(() => total.innerText(), { timeout: 10_000, interval: 150 }).toBe(`${before + 1} Orders`);
    expect(await start.inputValue()).toBe('2020-01-01');
    expect(await w().locator('input[aria-label="Report end date"]').inputValue()).toBe(end);
  }, 120_000);
});

describe('Purchases screen', () => {
  it('a purchase being entered keeps its rows, supplier, selected item and quantity when the medicine list refreshes', async () => {
    await nav('Purchases & Stock-In');
    const inv = (await apiFromRenderer(w(), 'GET', '/inventory')).body as any[];
    const brufen = inv.find((x) => x.batch_number === 'BF-109');
    const augmentin = inv.find((x) => x.batch_number === 'AG-442');
    const supplier = w().locator('select[aria-label="Supplier"]');
    const item = w().locator('select[aria-label="Medicine item"]');
    await expect.poll(() => item.locator('option').count()).toBeGreaterThan(2);
    const supplierValues = await supplier.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const chosenSupplier = supplierValues[supplierValues.length - 1];
    await supplier.selectOption(chosenSupplier);
    // one row added, and a second item half-entered
    await item.selectOption(String(brufen.id));
    await w().fill('input[aria-label="Purchase quantity"]', '7');
    await w().fill('input[aria-label="Batch number"]', 'P-LIVE-8C');
    await w().locator('button:visible', { hasText: /^\s*Add\s*$/ }).click(); // the item bar's "Add" (other screens are mounted but hidden)
    const rows = w().locator('[data-testid="purchase-rows"]');
    await expect.poll(() => rows.innerText()).toContain('P-LIVE-8C');
    await item.selectOption(String(augmentin.id));
    await w().fill('input[aria-label="Purchase quantity"]', '3');

    // another computer adds Augmentin stock: the medicine list must refresh (its option shows the new stock)
    const adj = await apiFromRenderer(w(), 'POST', '/inventory/adjust', { product_id: augmentin.id, adjustment_type: 'ADD', quantity: 5, reason: 'Live purchase-form test', reason_code: 'COUNT_CORRECTION', batch_number: 'LIVE-PUR', expiry_date: '2027-06-30' });
    expect(adj.status).toBe(200);
    const option = item.locator(`option[value="${augmentin.id}"]`);
    await expect.poll(() => option.innerText(), { timeout: 10_000, interval: 150 }).toContain(`Cur. Stock: ${augmentin.stock + 5}`);

    expect(await rows.innerText()).toContain('P-LIVE-8C');
    expect(await supplier.inputValue()).toBe(chosenSupplier);
    expect(await item.inputValue()).toBe(String(augmentin.id));
    expect(await w().locator('input[aria-label="Purchase quantity"]').inputValue()).toBe('3');
  }, 120_000);
});
