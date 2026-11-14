/**
 * POS draft cart recovery fix, real desktop app (standalone, throw-away data folder, demo data).
 * Was: the POS's own empty-cart autosave deleted the draft as soon as the screen opened, so "Resume" restored nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, printOff, Instance } from './helpers';

const ADMIN = { store: 'Draft Test Pharmacy', owner: 'Draft Owner', user: 'owner', password: 'Str0ngPass!', demo: true };
const STAFF = { username: 'counter2', password: 'Counter2pass!' };
let inst: Instance;
let ownerKey: string;
let ownerId: number;
let storeId: string;

const w = () => inst.win;
const SEARCH = 'input[placeholder^="Scan Barcode or Search Medicine"]';
const QTY = 'input[title="Click to type quantity manually"]';
const getItem = (k: string) => w().evaluate((key: string) => localStorage.getItem(key), k) as Promise<string | null>;
const setItem = (k: string, v: string) => w().evaluate(([key, val]: string[]) => localStorage.setItem(key, val), [k, v]);
const draftOf = async (k: string) => { const raw = await getItem(k); return raw ? JSON.parse(raw) : null; };
const me = async () => JSON.parse((await getItem('khushi_user'))!) as { id: number; tenant_id: number | null };
const keyFor = (u: { id: number; tenant_id: number | null }) => `khushi_pos_draft_cart:${u.tenant_id ?? 'none'}:${u.id}`;
const addByCode = async (code: string, times = 1) => {
  for (let i = 0; i < times; i++) {
    await w().fill(SEARCH, code);
    await w().press(SEARCH, 'Enter');
    await w().waitForTimeout(150);
  }
};
const qtys = async () => (await w().locator(QTY).all()).length ? Promise.all((await w().locator(QTY).all()).map((l: any) => l.inputValue())) : [];
const reloadPos = async () => {
  await w().reload();
  await w().waitForSelector(SEARCH, { timeout: 30_000 });
  await printOff(w());
};
const product = async (batch: string) => (await apiFromRenderer(w(), 'GET', '/inventory')).body.find((p: any) => p.batch_number === batch);
const draft = (lines: { productId: number; quantity: number }[], over: Record<string, unknown> = {}) => JSON.stringify({
  version: 2, storeId, userId: ownerId, savedAt: new Date().toISOString(), customerId: null, customerName: null, discountPercent: 0,
  lines: lines.map((l) => ({ productName: `#${l.productId}`, discountPercent: 0, ...l })), ...over,
});

beforeAll(async () => {
  inst = await launch(tempRoot('draft'));
  await runWizardLocal(inst.win, 'standalone', ADMIN);
  await loginUi(inst.win, ADMIN.user, ADMIN.password);
  await printOff(inst.win);
  const u = await me();
  ownerId = u.id;
  storeId = String(u.tenant_id ?? 'none');
  ownerKey = keyFor(u);
}, 180_000);
afterAll(async () => { if (inst) await quit(inst); }, 60_000);

describe('draft recovery after the POS is reopened', () => {
  it('items, quantities, customer and discount come back on Resume; the opening empty cart does not delete the draft; autosave continues afterwards', async () => {
    const augmentin = await product('AG-442');
    const brufen = await product('BF-109');
    const customer = (await apiFromRenderer(w(), 'GET', '/customers')).body[0];
    await addByCode('AG-442');
    await addByCode('BF-109', 3);
    await w().selectOption('select[aria-label="POS customer"]', String(customer.id));
    await w().fill('input[aria-label="Bill discount percent"]', '5');
    await expect.poll(async () => (await draftOf(ownerKey))?.discountPercent).toBe(5);
    const saved = await draftOf(ownerKey);
    expect(saved).toMatchObject({ version: 2, storeId, userId: ownerId, customerId: customer.id, discountPercent: 5,
      lines: [{ productId: augmentin.id, quantity: 1 }, { productId: brufen.id, quantity: 3 }] });

    await reloadPos(); // previous session ends with items in the cart
    // (1) the recovery alert appears, the cart is empty
    await w().waitForSelector('[data-testid="draft-alert"]', { timeout: 30_000 });
    expect(await w().locator('[data-testid="draft-alert"]').innerText()).toMatch(/2 items, customer /);
    expect(await qtys()).toEqual([]);
    // (6) the empty cart of the freshly opened POS did NOT delete the pending draft
    await w().waitForTimeout(1500);
    expect(await getItem(ownerKey)).toBe(JSON.stringify(saved));

    // (2, 3) Resume restores the items, quantities, customer and discount
    await w().click('[data-testid="draft-resume"]:not([disabled])');
    await w().waitForSelector('[data-testid="draft-alert"]', { state: 'detached' });
    expect(await qtys()).toEqual(['1', '3']);
    expect(await w().locator('select[aria-label="POS customer"]').inputValue()).toBe(String(customer.id));
    expect(await w().locator('input[aria-label="Bill discount percent"]').inputValue()).toBe('5');
    expect(await w().locator('[data-testid="draft-notice"]').innerText()).toMatch(/Draft restored: 2 items with current prices and stock/);

    // (7) autosave works again after Resume
    await addByCode('BF-109');
    await expect.poll(async () => (await draftOf(ownerKey))?.lines.map((l: any) => [l.productId, l.quantity])).toEqual([[augmentin.id, 1], [brufen.id, 4]]);
  }, 120_000);

  it('a draft that cannot be restored stays saved with a clear error; Discard deletes it', async () => {
    const bad = draft([{ productId: 999999, quantity: 2 }]);
    await setItem(ownerKey, bad);
    await reloadPos();
    await w().waitForSelector('[data-testid="draft-alert"]', { timeout: 30_000 });
    await w().click('[data-testid="draft-resume"]:not([disabled])');
    // (4) restoration failed: error shown, alert still offered, draft still saved, cart untouched
    await expect.poll(async () => w().locator('[data-testid="draft-notice"]').innerText()).toMatch(/could not be restored: none of its items can be sold now.*The draft was kept/s);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(1);
    expect(await getItem(ownerKey)).toBe(bad);
    expect(await qtys()).toEqual([]);
    // (5) Discard deletes it
    await w().click('[data-testid="draft-discard"]');
    await w().waitForSelector('[data-testid="draft-alert"]', { state: 'detached' });
    expect(await getItem(ownerKey)).toBeNull();
    await reloadPos();
    await w().waitForTimeout(1500);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(0);
  }, 120_000);

  it('Resume uses current stock: a quantity above today\'s stock is reduced and explained', async () => {
    const brufen = await product('BF-109');
    await setItem(ownerKey, draft([{ productId: brufen.id, quantity: brufen.sellable_stock + 5 }]));
    await reloadPos();
    await w().waitForSelector('[data-testid="draft-alert"]', { timeout: 30_000 });
    await w().click('[data-testid="draft-resume"]:not([disabled])');
    await expect.poll(async () => w().locator('[data-testid="draft-notice"]').innerText()).toMatch(new RegExp(`quantity reduced from ${brufen.sellable_stock + 5} to ${brufen.sellable_stock}`));
    expect(await qtys()).toEqual([String(brufen.sellable_stock)]);
    await w().click('button:has-text("Remove")');
    await expect.poll(() => getItem(ownerKey)).toBeNull(); // emptying the cart after Resume clears the draft as before
  }, 120_000);
});

describe('drafts and sales', () => {
  it('(8) a successfully saved sale clears its draft', async () => {
    await addByCode('AG-442');
    await expect.poll(() => getItem(ownerKey)).not.toBeNull();
    await w().click('button:has-text("CASH")');
    await w().waitForSelector('[data-testid="server-grand-total"]:has-text("Rs.")');
    await w().click('button:has-text("Complete Sale & Print Receipt")');
    await w().waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    expect(await getItem(ownerKey)).toBeNull();
    await w().click('button:has-text("Close")');
  }, 120_000);

  it('(9) a sale the server refuses keeps the cart and its draft', async () => {
    await addByCode('BF-109');
    const brufen = await product('BF-109');
    await expect.poll(async () => (await draftOf(ownerKey))?.lines[0]?.productId).toBe(brufen.id);
    await w().click('button:has-text("CASH")');
    await w().waitForSelector('[data-testid="server-grand-total"]:has-text("Rs.")');
    // the price changes on the server after the total was shown: the sale is refused (PRICE_MISMATCH), nothing saved
    expect((await apiFromRenderer(w(), 'PUT', `/inventory/${brufen.id}`, { ...brufen, sale_price: brufen.sale_price + 10 })).status).toBe(200);
    const salesBefore = (await apiFromRenderer(w(), 'GET', '/sales/history')).body.length;
    await w().click('button:has-text("Complete Sale & Print Receipt")');
    await w().waitForSelector('text=Sale not saved', { timeout: 30_000 });
    expect((await apiFromRenderer(w(), 'GET', '/sales/history')).body.length).toBe(salesBefore);
    expect((await draftOf(ownerKey))?.lines.map((l: any) => [l.productId, l.quantity])).toEqual([[brufen.id, 1]]);
    await w().click('[aria-label="Close payment"]');
    await w().click('button:has-text("Remove")');
    await expect.poll(() => getItem(ownerKey)).toBeNull();
  }, 120_000);
});

describe('(10) users and stores never see each other\'s drafts', () => {
  it('another user does not get the owner\'s draft; a draft of another store, or one recording another owner, is never offered', async () => {
    expect((await apiFromRenderer(w(), 'POST', '/users', { username: STAFF.username, password: STAFF.password, fullName: 'Counter Two', role: 'STAFF' })).status).toBe(200);
    await addByCode('AG-442');
    await expect.poll(() => getItem(ownerKey)).not.toBeNull();
    const ownerDraft = await getItem(ownerKey);

    await w().click('button:has-text("EXIT")');
    await loginUi(w(), STAFF.username, STAFF.password);
    const staff = await me();
    const staffKey = keyFor(staff);
    expect(staffKey).not.toBe(ownerKey);
    await w().waitForTimeout(1500);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(0);
    expect(await qtys()).toEqual([]);
    expect(await getItem(ownerKey)).toBe(ownerDraft); // untouched by the other user's POS

    // another store's draft for this user, and a draft in this user's key that records another store
    const otherStoreKey = `khushi_pos_draft_cart:999:${staff.id}`;
    const foreign = JSON.stringify({ version: 2, storeId: '999', userId: staff.id, savedAt: new Date().toISOString(), customerId: null, customerName: null, discountPercent: 0, lines: [{ productId: 1, productName: 'x', quantity: 1, discountPercent: 0 }] });
    await setItem(otherStoreKey, foreign);
    await setItem(staffKey, foreign);
    await reloadPos();
    await w().waitForTimeout(1500);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(0);
    expect(await w().locator('[data-testid="draft-notice"]').innerText()).toMatch(/removed because it belongs to a different user or store/);
    expect(await getItem(staffKey)).toBeNull();
    expect(await getItem(otherStoreKey)).toBe(foreign); // not this user's to delete
    expect(await getItem(ownerKey)).toBe(ownerDraft);

    // the owner gets their own draft back
    await w().click('button:has-text("EXIT")');
    await loginUi(w(), ADMIN.user, ADMIN.password);
    await printOff(w());
    await w().waitForSelector('[data-testid="draft-alert"]', { timeout: 30_000 });
    await w().click('[data-testid="draft-discard"]');
    expect(await getItem(ownerKey)).toBeNull();
  }, 180_000);
});

describe('(11, 12) legacy and expired drafts', () => {
  it('a legacy draft (no owner recorded) is never shown and is removed, with a notice', async () => {
    const brufen = await product('BF-109');
    await setItem('khushi_pos_draft_cart', JSON.stringify({ cart: [{ product: brufen, quantity: 2 }], discountPercent: 0, timestamp: new Date().toISOString() }));
    await reloadPos();
    await expect.poll(async () => w().locator('[data-testid="draft-notice"]').innerText()).toMatch(/older version of the app.*not shown and was removed/);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(0);
    expect(await getItem('khushi_pos_draft_cart')).toBeNull();
    expect(await qtys()).toEqual([]);
  }, 120_000);

  it('a draft older than 24 hours is removed with a notice; a 23-hour-old draft is still offered', async () => {
    const brufen = await product('BF-109');
    await setItem(ownerKey, draft([{ productId: brufen.id, quantity: 1 }], { savedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    await reloadPos();
    await expect.poll(async () => w().locator('[data-testid="draft-notice"]').innerText()).toMatch(/older than 24 hours and was removed/);
    expect(await w().locator('[data-testid="draft-alert"]').count()).toBe(0);
    expect(await getItem(ownerKey)).toBeNull();

    await setItem(ownerKey, draft([{ productId: brufen.id, quantity: 1 }], { savedAt: new Date(Date.now() - 23 * 3600_000).toISOString() }));
    await reloadPos();
    await w().waitForSelector('[data-testid="draft-alert"]', { timeout: 30_000 });
    await w().click('[data-testid="draft-resume"]:not([disabled])');
    await w().waitForSelector('[data-testid="draft-alert"]', { state: 'detached' });
    expect(await qtys()).toEqual(['1']);
  }, 120_000);
});
