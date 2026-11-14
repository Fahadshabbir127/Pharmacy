/**
 * POS draft cart recovery fix: ownership (store + user), legacy and expiry policy, and rebuilding the cart from
 * the CURRENT catalogue (src/lib/draftCart.ts). Pure logic with an in-memory storage.
 */
import { describe, it, expect } from 'vitest';
import {
  draftOwnerOf, draftKey, saveDraftCart, clearDraftCart, inspectDraft, removeUnusableDrafts, restoreDraftCart,
  LEGACY_DRAFT_KEY, DRAFT_MAX_AGE_HOURS, DraftCart,
} from '../../src/lib/draftCart';
import { priceLine } from '../../shared/pricing';

class Mem {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
const NOW = new Date('2026-11-14T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const product = (id: number, over: Record<string, unknown> = {}) => ({ id, name: `Med ${id}`, unit: 'Tab', sale_price: 100, gst_rate: 0, stock: 50, sellable_stock: 50, expired_stock: 0, ...over }) as any;
const item = (p: any, quantity: number, discount_percent = 0) => ({ product: p, quantity, unit_price: p.sale_price, discount_percent, discount_amount: 0, gst_percent: p.gst_rate, gst_amount: 0, subtotal: 0 }) as any;
const sellableOf = (p: any) => (typeof p.sellable_stock === 'number' ? p.sellable_stock : p.stock);
const expiredOnly = (p: any) => sellableOf(p) <= 0 && (p.expired_stock || 0) > 0;
const owner = draftOwnerOf({ id: 7, tenant_id: 1 })!;

describe('ownership: one draft per store and user', () => {
  it('uses khushi_pos_draft_cart:<storeId>:<userId>; a user without a store gets "none"; no user, no draft', () => {
    expect(draftKey(owner)).toBe('khushi_pos_draft_cart:1:7');
    expect(draftKey(draftOwnerOf({ id: 3, tenant_id: null })!)).toBe('khushi_pos_draft_cart:none:3');
    expect(draftOwnerOf(null)).toBeNull();
    expect(draftOwnerOf({ id: 0, tenant_id: 1 })).toBeNull();
  });

  it('another user of the same store and the same user in another store never see the draft', () => {
    const kv = new Mem();
    saveDraftCart(owner, [item(product(1), 2)], null, 0, NOW, kv);
    expect(inspectDraft(owner, NOW, kv).own.status).toBe('ok');
    expect(inspectDraft(draftOwnerOf({ id: 8, tenant_id: 1 }), NOW, kv).own).toEqual({ status: 'none' });
    expect(inspectDraft(draftOwnerOf({ id: 7, tenant_id: 2 }), NOW, kv).own).toEqual({ status: 'none' });
  });

  it('a draft placed under this user\'s key but recording another store or user is refused (and removed by housekeeping)', () => {
    const kv = new Mem();
    saveDraftCart(draftOwnerOf({ id: 7, tenant_id: 2 })!, [item(product(1), 1)], null, 0, NOW, kv);
    kv.setItem(draftKey(owner), kv.getItem('khushi_pos_draft_cart:2:7')!); // copied into store 1's key
    const found = inspectDraft(owner, NOW, kv);
    expect(found.own).toEqual({ status: 'invalid', reason: 'it belongs to a different user or store' });
    removeUnusableDrafts(owner, found, kv);
    expect(kv.getItem(draftKey(owner))).toBeNull();
    expect(kv.getItem('khushi_pos_draft_cart:2:7')).not.toBeNull(); // the real owner's draft is untouched
  });

  it('stores only ids, quantities and discounts (no prices or stock)', () => {
    const kv = new Mem();
    saveDraftCart(owner, [item(product(1, { sale_price: 999 }), 2, 5)], { id: 4, name: 'Ali' } as any, 3, NOW, kv);
    expect(JSON.parse(kv.getItem(draftKey(owner))!)).toEqual({
      version: 2, storeId: '1', userId: 7, savedAt: NOW.toISOString(), customerId: 4, customerName: 'Ali', discountPercent: 3,
      lines: [{ productId: 1, productName: 'Med 1', quantity: 2, discountPercent: 5 }],
    });
  });

  it('saving an empty cart writes nothing; clearing removes only this owner\'s draft', () => {
    const kv = new Mem();
    saveDraftCart(owner, [], null, 0, NOW, kv);
    expect(kv.m.size).toBe(0);
    saveDraftCart(owner, [item(product(1), 1)], null, 0, NOW, kv);
    saveDraftCart(draftOwnerOf({ id: 8, tenant_id: 1 })!, [item(product(1), 1)], null, 0, NOW, kv);
    clearDraftCart(owner, kv);
    expect([...kv.m.keys()]).toEqual(['khushi_pos_draft_cart:1:8']);
  });
});

describe('legacy and expiry policy', () => {
  it('a legacy draft (no owner recorded) is never offered and is removed by housekeeping', () => {
    const kv = new Mem();
    kv.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ cart: [item(product(1), 2)], customerId: 3, discountPercent: 0, timestamp: NOW.toISOString() }));
    const found = inspectDraft(owner, NOW, kv);
    expect(found).toEqual({ own: { status: 'none' }, legacyPresent: true });
    removeUnusableDrafts(owner, found, kv);
    expect(kv.getItem(LEGACY_DRAFT_KEY)).toBeNull();
  });

  it(`a draft up to ${DRAFT_MAX_AGE_HOURS} hours old is offered; an older one is "expired" and removed by housekeeping`, () => {
    const kv = new Mem();
    saveDraftCart(owner, [item(product(1), 1)], null, 0, hoursAgo(DRAFT_MAX_AGE_HOURS - 0.5), kv);
    expect(inspectDraft(owner, NOW, kv).own.status).toBe('ok');
    removeUnusableDrafts(owner, inspectDraft(owner, NOW, kv), kv);
    expect(kv.getItem(draftKey(owner))).not.toBeNull(); // a valid draft is never removed by housekeeping
    saveDraftCart(owner, [item(product(1), 1)], null, 0, hoursAgo(DRAFT_MAX_AGE_HOURS + 0.5), kv);
    const found = inspectDraft(owner, NOW, kv);
    expect(found.own.status).toBe('expired');
    removeUnusableDrafts(owner, found, kv);
    expect(kv.getItem(draftKey(owner))).toBeNull();
  });

  it('unreadable or incomplete drafts are reported as invalid; inspecting never changes storage', () => {
    const kv = new Mem();
    kv.setItem(draftKey(owner), '{not json');
    expect(inspectDraft(owner, NOW, kv).own).toEqual({ status: 'invalid', reason: 'it could not be read' });
    kv.setItem(draftKey(owner), JSON.stringify({ version: 2, storeId: '1', userId: 7, savedAt: NOW.toISOString(), lines: [] }));
    expect(inspectDraft(owner, NOW, kv).own).toEqual({ status: 'invalid', reason: 'it is incomplete' });
    expect(kv.getItem(draftKey(owner))).not.toBeNull();
  });
});

describe('restoring with current catalogue data', () => {
  const draft = (lines: DraftCart['lines'], over: Partial<DraftCart> = {}): DraftCart =>
    ({ version: 2, storeId: '1', userId: 7, savedAt: NOW.toISOString(), customerId: null, customerName: null, discountPercent: 0, lines, ...over });
  const line = (productId: number, quantity: number, discountPercent = 0) => ({ productId, productName: `Med ${productId}`, quantity, discountPercent });
  const ctx = (products: any[], customers: any[] = []) => ({ products, customers, sellableOf, expiredOnly });

  it('uses the current price and tax, keeps quantities and line discounts, restores customer and bill discount', () => {
    const r = restoreDraftCart(draft([line(1, 3, 10), line(2, 1)], { customerId: 4, customerName: 'Ali', discountPercent: 5 }),
      ctx([product(1, { sale_price: 120, gst_rate: 5 }), product(2)], [{ id: 4, name: 'Ali' }]));
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.cart.map((c) => [c.product.id, c.quantity, c.unit_price, c.gst_percent, c.discount_percent])).toEqual([[1, 3, 120, 5, 10], [2, 1, 100, 0, 0]]);
    expect(r.cart[0].subtotal).toBe(priceLine({ quantity: 3, unitPrice: 120, discountPercent: 10, gstPercent: 5 }).subtotal);
    expect(r.customer).toEqual({ id: 4, name: 'Ali' });
    expect(r.discountPercent).toBe(5);
    expect(r.notices).toEqual([]);
  });

  it('leaves out missing/archived, expired and out-of-stock products and reduces quantities above stock, each with a notice', () => {
    const r = restoreDraftCart(draft([line(1, 9), line(2, 1), line(3, 1), line(4, 1)]),
      ctx([product(1, { sellable_stock: 4 }), product(3, { sellable_stock: 0, expired_stock: 6 }), product(4, { sellable_stock: 0 })]));
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.cart.map((c) => [c.product.id, c.quantity])).toEqual([[1, 4]]);
    expect(r.notices).toEqual([ // in cart order
      '"Med 1": only 4 Tab in stock now; quantity reduced from 9 to 4.',
      '"Med 2" is no longer in the medicine list (removed or archived) and was left out.',
      '"Med 3" was left out: all remaining stock has expired.',
      '"Med 4" is out of stock and was left out.',
    ]);
  });

  it('merges duplicate lines (then checks stock) and refuses invalid quantities and discounts', () => {
    const r = restoreDraftCart(draft([line(1, 2), line(1, 3), line(2, 0), line(5, 1.5), line(6, 2, 150)], { discountPercent: -4 }),
      ctx([product(1), product(2), product(5), product(6)]));
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.cart.map((c) => [c.product.id, c.quantity, c.discount_percent])).toEqual([[1, 5, 0], [6, 2, 0]]);
    expect(r.discountPercent).toBe(0);
    expect(r.notices).toEqual([
      '"Med 1" appeared twice; the quantities were combined.',
      '"Med 2" was left out (invalid quantity).',
      '"Med 5" was left out (invalid quantity).',
      '"Med 6": the saved line discount was invalid and was set to 0%.',
      'The saved bill discount was invalid and was set to 0%.',
    ]);
  });

  it('a customer who no longer exists is not dropped silently: the cart is restored as walk-in with a notice', () => {
    const r = restoreDraftCart(draft([line(1, 1)], { customerId: 99, customerName: 'Bilal' }), ctx([product(1)], [{ id: 4, name: 'Ali' }]));
    expect(r.ok && r.customer).toBeNull();
    if (r.ok !== true) return;
    expect(r.notices).toEqual(['The customer saved with this cart (Bilal) was not found, so the cart was restored as a walk-in sale. Select the customer again before payment if needed.']);
  });

  it('fails (so the caller keeps the draft) when none of the items can be sold now', () => {
    const r = restoreDraftCart(draft([line(1, 1), line(2, 1)]), ctx([product(2, { sellable_stock: 0 })]));
    expect(r).toEqual({ ok: false, error: 'The saved cart could not be restored: none of its items can be sold now. "Med 1" is no longer in the medicine list (removed or archived) and was left out. "Med 2" is out of stock and was left out.' });
  });
});
