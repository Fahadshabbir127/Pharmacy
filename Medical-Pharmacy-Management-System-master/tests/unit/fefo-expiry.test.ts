import { describe, it, expect, afterEach } from 'vitest';
import { normalizeExpiry, parseExpiryInput, parseMfgInput, today, addDays, isExpired, batchStatus } from '../../server/inventory/expiry';
import { planFefo, fefoOrder, weightedCost, BatchRow } from '../../server/inventory/fefo';

const b = (id: number, expiry: string | null, qty: number, cost = 10, product = 1): BatchRow =>
  ({ id, product_id: product, batch_number: `B${id}`, expiry_date: expiry, qty_on_hand: qty, purchase_price: cost });

describe('expiry normalization (migration of legacy text)', () => {
  it('accepts full dates and pads them', () => {
    expect(normalizeExpiry('2027-10-15')).toEqual({ date: '2027-10-15', recognized: true });
    expect(normalizeExpiry('2027/1/5')).toEqual({ date: '2027-01-05', recognized: true });
  });
  it('a month-only expiry means the last day of that month (D3), including leap years', () => {
    expect(normalizeExpiry('2027-10').date).toBe('2027-10-31');
    expect(normalizeExpiry('02/2028').date).toBe('2028-02-29');
    expect(normalizeExpiry('2-2027').date).toBe('2027-02-28');
  });
  it('blank / null means "no expiry" (D5), recognized', () => {
    expect(normalizeExpiry('')).toEqual({ date: null, recognized: true });
    expect(normalizeExpiry(null)).toEqual({ date: null, recognized: true });
    expect(normalizeExpiry('   ')).toEqual({ date: null, recognized: true });
  });
  it('ambiguous or invalid text is NOT guessed', () => {
    for (const s of ['05/10/2027', '2027-02-30', '2027-13', 'soon', '31-12-2027', '1999-99-99']) {
      expect(normalizeExpiry(s), s).toEqual({ date: null, recognized: false });
    }
  });
  it('input parsers give clear errors', () => {
    expect(parseExpiryInput('2027-10')).toEqual({ ok: true, date: '2027-10-31' });
    expect(parseExpiryInput('')).toEqual({ ok: true, date: null });
    expect(parseExpiryInput('05/10/2027').ok).toBe(false);
    expect(parseMfgInput('2026-01-02')).toEqual({ ok: true, date: '2026-01-02' });
    expect(parseMfgInput('2026-01')).toMatchObject({ ok: false });
  });
});

describe('today and the D3 expiry rule', () => {
  afterEach(() => { delete process.env.PHARMACY_TEST_TODAY; });
  it('today is the local calendar date', () => {
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('PHARMACY_TEST_TODAY overrides it (tests only)', () => {
    process.env.PHARMACY_TEST_TODAY = '2030-06-01';
    expect(today()).toBe('2030-06-01');
  });
  it('sellable through the expiry date, expired from the next day', () => {
    expect(isExpired('2026-11-12', '2026-11-12')).toBe(false);
    expect(isExpired('2026-11-12', '2026-11-13')).toBe(true);
    expect(isExpired(null, '2099-01-01')).toBe(false);
  });
  it('addDays crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('batch status', () => {
    const on = '2026-11-12';
    expect(batchStatus('2026-11-11', 5, on)).toBe('EXPIRED');
    expect(batchStatus('2026-11-12', 5, on)).toBe('EXPIRING_SOON');
    expect(batchStatus(addDays(on, 90), 5, on)).toBe('EXPIRING_SOON');
    expect(batchStatus(addDays(on, 91), 5, on)).toBe('OK');
    expect(batchStatus(null, 5, on)).toBe('NO_EXPIRY');
    expect(batchStatus('2020-01-01', 0, on)).toBe('EMPTY');
  });
});

describe('FEFO allocation plan', () => {
  const on = '2026-11-12';
  it('orders by earliest expiry, undated last, then oldest id', () => {
    const sorted = [b(5, null, 1), b(4, '2027-01-01', 1), b(3, '2026-12-01', 1), b(2, '2027-01-01', 1), b(1, null, 1)].sort(fefoOrder).map((x) => x.id);
    expect(sorted).toEqual([3, 2, 4, 1, 5]);
  });

  it('a single line is taken from the earliest-expiring batch', () => {
    const plan = planFefo([{ line: 0, productId: 1, quantity: 3 }], new Map([[1, [b(1, '2027-06-01', 10), b(2, '2027-01-01', 10)]]]), on);
    expect(plan.ok && plan.lines.get(0)).toEqual([{ batchId: 2, quantity: 3, unitCost: 10, batchNumber: 'B2', expiryDate: '2027-01-01' }]);
  });

  it('a line larger than one batch is split across batches in FEFO order', () => {
    const plan = planFefo([{ line: 0, productId: 1, quantity: 12 }], new Map([[1, [b(1, '2027-06-01', 10, 20), b(2, '2027-01-01', 5, 10)]]]), on);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.get(0)!.map((a) => [a.batchId, a.quantity])).toEqual([[2, 5], [1, 7]]);
    expect(weightedCost(plan.lines.get(0)!)).toBeCloseTo((5 * 10 + 7 * 20) / 12, 4);
  });

  it('expired and empty batches are never used; undated stock is used after dated stock', () => {
    const batches = [b(1, '2026-11-11', 50), b(2, null, 4), b(3, '2026-11-12', 2), b(4, '2027-01-01', 0)];
    const plan = planFefo([{ line: 0, productId: 1, quantity: 5 }], new Map([[1, batches]]), on);
    expect(plan.ok && plan.lines.get(0)!.map((a) => [a.batchId, a.quantity])).toEqual([[3, 2], [2, 3]]);
  });

  it('two lines of the same product share one pool and cannot exceed it', () => {
    const batches = new Map([[1, [b(1, '2027-01-01', 3), b(2, '2027-02-01', 3)]]]);
    const ok = planFefo([{ line: 0, productId: 1, quantity: 4 }, { line: 1, productId: 1, quantity: 2 }], batches, on);
    expect(ok.ok && [ok.lines.get(0)!.map((a) => [a.batchId, a.quantity]), ok.lines.get(1)!.map((a) => [a.batchId, a.quantity])]).toEqual([[[1, 3], [2, 1]], [[2, 2]]]);
    const tooMuch = planFefo([{ line: 0, productId: 1, quantity: 4 }, { line: 1, productId: 1, quantity: 3 }], batches, on);
    expect(tooMuch).toEqual({ ok: false, shortage: { code: 'INSUFFICIENT_STOCK', productId: 1, requested: 7, sellable: 6, expired: 0 } });
  });

  it('only expired stock left -> EXPIRED_STOCK; partly expired -> INSUFFICIENT_STOCK with both numbers', () => {
    const onlyExpired = planFefo([{ line: 0, productId: 1, quantity: 1 }], new Map([[1, [b(1, '2026-01-01', 9)]]]), on);
    expect(onlyExpired).toEqual({ ok: false, shortage: { code: 'EXPIRED_STOCK', productId: 1, requested: 1, sellable: 0, expired: 9 } });
    const partly = planFefo([{ line: 0, productId: 1, quantity: 5 }], new Map([[1, [b(1, '2026-01-01', 9), b(2, '2027-01-01', 2)]]]), on);
    expect(partly).toEqual({ ok: false, shortage: { code: 'INSUFFICIENT_STOCK', productId: 1, requested: 5, sellable: 2, expired: 9 } });
  });

  it('a product with no batches at all is a shortage', () => {
    expect(planFefo([{ line: 0, productId: 7, quantity: 1 }], new Map(), on)).toEqual({ ok: false, shortage: { code: 'INSUFFICIENT_STOCK', productId: 7, requested: 1, sellable: 0, expired: 0 } });
  });

  it('taking exactly all sellable stock is allowed', () => {
    const plan = planFefo([{ line: 0, productId: 1, quantity: 6 }], new Map([[1, [b(1, '2027-01-01', 4), b(2, null, 2)]]]), on);
    expect(plan.ok && plan.lines.get(0)!.reduce((s, a) => s + a.quantity, 0)).toBe(6);
  });
});
