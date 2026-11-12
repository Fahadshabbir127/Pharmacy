/**
 * Phase 7 Batch 1: the shared sale pricing formula (E1-E3) and discount authorization (E2).
 */
import { describe, it, expect } from 'vitest';
import { priceBill, priceLine, round2, sameMoney, validPercent } from '../../shared/pricing';
import { DiscountAuthorizations, discountLimits } from '../../server/pos/discountAuth';

/** The formula the POS screen used before Phase 7 (BillingScreen cart calculations), without rounding. */
function legacyUiTotal(lines: { q: number; p: number; d: number; g: number }[], billDisc: number) {
  const subtotal = lines.reduce((a, l) => a + l.q * l.p, 0);
  const itemDisc = lines.reduce((a, l) => a + (l.q * l.p * l.d) / 100, 0);
  const gst = lines.reduce((a, l) => { const raw = l.q * l.p; return a + ((raw - (raw * l.d) / 100) * l.g) / 100; }, 0);
  const disc = ((subtotal - itemDisc) * billDisc) / 100;
  return Math.max(0, subtotal - itemDisc - disc + gst);
}

describe('shared pricing formula', () => {
  it('a plain line: quantity x price, no discount, no GST', () => {
    expect(priceLine({ quantity: 3, unitPrice: 220, discountPercent: 0, gstPercent: 0 })).toMatchObject({ gross: 660, discount_amount: 0, gst_amount: 0, subtotal: 660 });
  });

  it('GST is charged after the line discount; each line is rounded to 2 decimals (E3)', () => {
    const l = priceLine({ quantity: 3, unitPrice: 99.99, discountPercent: 7.5, gstPercent: 17 });
    expect(l.gross).toBe(299.97);
    expect(l.discount_amount).toBe(22.5); // 22.49775
    expect(l.gst_amount).toBe(47.17); // (299.97 - 22.5) x 17% = 47.1699
    expect(l.subtotal).toBe(324.64);
  });

  it('the bill discount applies after line discounts and does NOT reduce GST (unchanged legacy rule)', () => {
    const b = priceBill([{ quantity: 2, unitPrice: 100, discountPercent: 10, gstPercent: 10 }], 5);
    // gross 200, line disc 20, gst 18; bill disc 5% of 180 = 9
    expect(b).toMatchObject({ total_amount: 200, item_discount_amount: 20, bill_discount_amount: 9, discount_amount: 29, net_amount: 171, total_gst: 18, grand_total: 189 });
  });

  it('matches the old POS formula to the paisa on realistic carts', () => {
    const carts = [
      { lines: [{ q: 1, p: 220, d: 0, g: 0 }, { q: 4, p: 175, d: 0, g: 0 }], bill: 0 },
      { lines: [{ q: 2, p: 380, d: 5, g: 0 }, { q: 1, p: 145, d: 0, g: 17 }], bill: 2 },
      { lines: [{ q: 7, p: 12.5, d: 3, g: 5 }, { q: 3, p: 99.99, d: 0, g: 18 }, { q: 1, p: 1.1, d: 50, g: 0 }], bill: 10 },
    ];
    for (const c of carts) {
      const b = priceBill(c.lines.map((l) => ({ quantity: l.q, unitPrice: l.p, discountPercent: l.d, gstPercent: l.g })), c.bill);
      // rounding each line can move the total by at most half a paisa per rounded amount
      expect(Math.abs(b.grand_total - legacyUiTotal(c.lines, c.bill))).toBeLessThanOrEqual(0.005 * (3 * c.lines.length + 2));
    }
  });

  it('a 100 % discount gives a total of 0, never negative', () => {
    expect(priceBill([{ quantity: 1, unitPrice: 50, discountPercent: 100, gstPercent: 0 }], 100).grand_total).toBe(0);
  });

  it('helpers: round2, sameMoney, validPercent', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(sameMoney(10, 10.004)).toBe(true);
    expect(sameMoney(10, 10.01)).toBe(false);
    for (const ok of [0, 0.5, 100]) expect(validPercent(ok)).toBe(true);
    for (const bad of [-1, 100.01, NaN, Infinity, '5', null]) expect(validPercent(bad as any)).toBe(false);
  });
});

describe('discount limits (store settings)', () => {
  const read = (m: Record<string, string>) => (k: string) => m[k];
  it('defaults: staff 0 %, administrator 100 %', () => {
    expect(discountLimits(read({}))).toEqual({ staff: 0, admin: 100 });
  });
  it('values are clamped to 0..100 and the staff limit never exceeds the administrator limit', () => {
    expect(discountLimits(read({ pos_staff_max_discount_percent: '15', pos_admin_max_discount_percent: '30' }))).toEqual({ staff: 15, admin: 30 });
    expect(discountLimits(read({ pos_staff_max_discount_percent: '50', pos_admin_max_discount_percent: '20' }))).toEqual({ staff: 20, admin: 20 });
    expect(discountLimits(read({ pos_staff_max_discount_percent: '-5', pos_admin_max_discount_percent: '500' }))).toEqual({ staff: 0, admin: 100 });
    expect(discountLimits(read({ pos_staff_max_discount_percent: 'abc' }))).toEqual({ staff: 0, admin: 100 });
  });
});

describe('discount authorization grants', () => {
  const base = { cashierUserId: 7, authorizedByUserId: 1, authorizedByName: 'Owner', tenantId: 1, maxPercent: 10, reason: 'regular customer' };

  it('a grant is valid for its cashier, store and up to its percentage, and only once', () => {
    const a = new DiscountAuthorizations();
    const { token } = a.issue(base);
    expect(a.check(token, 7, 1, 10)).toMatchObject({ ok: true });
    expect(a.check(token, 7, 1, 10.5)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_TOO_LOW' });
    expect(a.check(token, 8, 1, 5)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_INVALID' });
    expect(a.check(token, 7, 2, 5)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_INVALID' });
    a.consume(token);
    expect(a.check(token, 7, 1, 5)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_USED' });
  });

  it('a grant expires', () => {
    let t = 1_000_000;
    const a = new DiscountAuthorizations(60_000, () => t);
    const { token } = a.issue(base);
    t += 59_999;
    expect(a.check(token, 7, 1, 5).ok).toBe(true);
    t += 2;
    expect(a.check(token, 7, 1, 5)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_EXPIRED' });
  });

  it('unknown or malformed tokens are refused', () => {
    const a = new DiscountAuthorizations();
    for (const t of ['nope', '', null, 123, { token: 'x' }]) expect(a.check(t, 7, 1, 1)).toMatchObject({ ok: false, code: 'DISCOUNT_AUTH_INVALID' });
  });
});
