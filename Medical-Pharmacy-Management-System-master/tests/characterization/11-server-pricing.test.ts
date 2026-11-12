/**
 * Phase 7 Batch 1: server-calculated POS (E1 price from the host, E2 discount limits/authorization,
 * E3 rounding), payment amount validation, and "nothing is written for a refused sale".
 * Demo seed (legacy test seed): #1 Panadol Rs. 220, stock 120, GST 0; users admin (ADMIN), staff (STAFF).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { startServer, Api, RunningServer, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, one, all } from '../helpers/db';

let srv: RunningServer;
let admin: Api;
let staff: Api;

const product = async (id: number) => (await admin.get('/inventory')).body.find((p: any) => p.id === id);
const counts = async () => {
  const db = await openReadOnly(srv.dbFile);
  try {
    return {
      sales: one<any>(db, 'SELECT COUNT(*) n FROM sales_headers').n,
      items: one<any>(db, 'SELECT COUNT(*) n FROM sale_items').n,
      ledger: one<any>(db, 'SELECT COUNT(*) n FROM customer_ledger').n,
      stock: one<any>(db, 'SELECT SUM(stock) s FROM products').s,
      keys: one<any>(db, 'SELECT COUNT(*) n FROM idempotency_keys').n,
    };
  } finally { db.close(); }
};
const audit = async (type: string) => {
  const db = await openReadOnly(srv.dbFile);
  try { return all<any>(db, 'SELECT user_id, user_name, description FROM audit_logs WHERE action_type = ? ORDER BY id', [type]); } finally { db.close(); }
};
/** a GST product created through the API: Rs. 99.99, GST 17 %, 50 units */
const gstProduct = async () => {
  const r = await admin.post('/inventory', { name: 'GST Syrup', unit: 'Bottle', purchase_price: 60, sale_price: 99.99, gst_rate: 17, stock: 50, batch_number: 'G-1', expiry_date: '2028-01-31' });
  expect(r.status).toBe(200);
  return product(r.body.id);
};

beforeEach(async () => {
  srv = await startServer();
  admin = new Api();
  await admin.login('admin', 'admin123');
  staff = new Api();
  await staff.login('staff', 'staff123');
});
afterEach(async () => { await srv?.stop(); });

describe('the host prices every sale (E1, E3)', () => {
  it('the quote and the sale use the host price, discounts and GST, rounded per line; client prices are ignored', async () => {
    const p = await gstProduct();
    const cheap = { ...p, sale_price: 1, gst_rate: 0 }; // what a tampered screen might send
    const items = [{ ...cartItem(cheap, 3, { unit_price: 1, discount_percent: 7.5 }) }];
    const q = await admin.post('/sales/quote', { items, discount_percent: 0 });
    expect(q.status).toBe(200);
    expect(q.body.lines[0]).toMatchObject({ product_id: p.id, unit_price: 99.99, gross: 299.97, discount_amount: 22.5, gst_percent: 17, gst_amount: 47.17, subtotal: 324.64 });
    expect(q.body).toMatchObject({ total_amount: 299.97, discount_amount: 22.5, net_amount: 277.47, total_gst: 47.17, grand_total: 324.64 });
    expect(q.body.discount).toMatchObject({ max_percent_used: 7.5, staff_limit_percent: 0, admin_limit_percent: 100, authorization_required: false, reason_required: true });

    const r = await admin.post('/sales', { items, discount_percent: 0, discount_reason: 'damaged box', payment_method: 'CASH', amount_paid: 400, grand_total: q.body.grand_total });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ grand_total: 324.64, amount_paid: 324.64, amount_due: 0, amount_tendered: 400, change_due: 75.36 });
    const d = (await admin.get(`/sales/${r.body.sale_id}`)).body;
    expect(d).toMatchObject({ total_amount: 299.97, discount_percent: 0, discount_amount: 22.5, net_amount: 277.47, total_gst: 47.17, grand_total: 324.64, amount_paid: 324.64, payment_status: 'PAID' });
    expect(d.items[0]).toMatchObject({ sale_price: 99.99, discount_percent: 7.5, discount_amount: 22.5, gst_amount: 47.17, subtotal: 324.64 });
  });

  it('a total that differs from the server (e.g. the price changed on the host) is refused with the server figures; nothing is written', async () => {
    const p = await product(1);
    const payload = salePayload([cartItem(p, 2)]); // grand_total 440 at the old price
    expect((await admin.put('/inventory/1', { ...p, sale_price: 230 })).status).toBe(200);
    const before = await counts();
    const r = await staff.post('/sales', { ...payload, client_txn_id: crypto.randomUUID() });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'PRICE_MISMATCH', server_grand_total: 460, client_grand_total: 440 });
    expect(r.body.quote.lines[0]).toMatchObject({ unit_price: 230, subtotal: 460 });
    expect(r.body.error).toMatch(/Rs\. 460\.00.*Rs\. 440\.00/);
    expect(await counts()).toEqual(before);
    // the corrected sale goes through
    const ok = await staff.post('/sales', { ...payload, grand_total: 460, amount_paid: 460 });
    expect(ok.status).toBe(200);
    expect(ok.body.grand_total).toBe(460);
  });

  it('bill discount and line discounts follow the unchanged GST rule', async () => {
    const p = await gstProduct();
    const q = await admin.post('/sales/quote', { items: [cartItem(p, 2, { discount_percent: 10 })], discount_percent: 5 });
    // gross 199.98, line disc 20.00 (19.998), gst (179.98 x 17%) 30.60, bill disc 5% of 179.98 = 9.00 (8.999)
    expect(q.body).toMatchObject({ total_amount: 199.98, item_discount_amount: 20, bill_discount_amount: 9, discount_amount: 29, net_amount: 170.98, total_gst: 30.6, grand_total: 201.58 });
  });
});

describe('invalid input is refused before anything is written', () => {
  it('invalid discounts, payment methods and amounts', async () => {
    const p = await product(1);
    const before = await counts();
    const cases: [any, number, string][] = [
      [salePayload([cartItem(p, 1, { discount_percent: -1 })]), 400, 'INVALID_DISCOUNT'],
      [salePayload([cartItem(p, 1, { discount_percent: 101 })]), 400, 'INVALID_DISCOUNT'],
      [salePayload([{ ...cartItem(p, 1), discount_percent: 'ten' }]), 400, 'INVALID_DISCOUNT'],
      [salePayload([cartItem(p, 1)], { discount_percent: 150 }), 400, 'INVALID_DISCOUNT'],
      [salePayload([cartItem(p, 1)], { payment_method: 'BITCOIN' }), 400, 'INVALID_PAYMENT_METHOD'],
      [salePayload([cartItem(p, 1)], { amount_paid: -5 }), 400, 'INVALID_PAYMENT'],
      [salePayload([cartItem(p, 1)], { amount_paid: 100 }), 400, 'INSUFFICIENT_PAYMENT'], // cash less than the bill
      [salePayload([cartItem(p, 1)], { payment_method: 'PARTIAL', customer_id: 3, amount_paid: 500 }), 400, 'OVERPAYMENT'],
      [salePayload([cartItem(p, 1)], { grand_total: 'abc' }), 409, 'PRICE_MISMATCH'],
    ];
    for (const [body, status, code] of cases) {
      const r = await admin.post('/sales', body);
      expect([r.status, r.body.code], JSON.stringify(body.items[0].discount_percent) + ' ' + code).toEqual([status, code]);
    }
    expect(await counts()).toEqual(before);
  });

  it('cash: change is returned, never stored as a negative due; PARTIAL stores the part paid; UDHAR stores 0', async () => {
    const p = await product(1);
    const cash = await admin.post('/sales', salePayload([cartItem(p, 1)], { amount_paid: 500 }));
    expect(cash.body).toMatchObject({ amount_paid: 220, amount_due: 0, change_due: 280 });
    const part = await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'PARTIAL', customer_id: 3, amount_paid: 20 }));
    expect(part.body).toMatchObject({ amount_paid: 20, amount_due: 200, new_balance: 200 });
    const udhar = await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'UDHAR', customer_id: 3, amount_paid: 220 }));
    expect(udhar.body).toMatchObject({ amount_paid: 0, amount_due: 220, new_balance: 420 });
  });
});

describe('discount limits and authorization (E2)', () => {
  it('staff (limit 0 %) cannot give any discount without an administrator; the quote says so', async () => {
    const p = await product(1);
    const q = await staff.post('/sales/quote', { items: [cartItem(p, 1, { discount_percent: 5 })] });
    expect(q.status).toBe(200);
    expect(q.body.discount).toMatchObject({ authorization_required: true, reason_required: true, staff_limit_percent: 0 });
    const before = await counts();
    const r = await staff.post('/sales', salePayload([cartItem(p, 1, { discount_percent: 5 })], { discount_reason: 'friend' }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('DISCOUNT_AUTH_REQUIRED');
    // no discount: allowed as before
    expect((await staff.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(200);
    expect((await counts()).sales).toBe(before.sales + 1);
  });

  it('an administrator authorizes at the counter: single use, bound to the cashier, audited with authorizer and reason', async () => {
    const p = await product(1);
    const auth = (body: any) => staff.post('/sales/discount-authorization', body);
    expect((await auth({ username: 'admin', password: 'admin123', max_percent: 10 })).status).toBe(400); // reason required
    expect((await auth({ username: 'admin', password: 'wrong', max_percent: 10, reason: 'x' })).status).toBe(401);
    expect((await auth({ username: 'staff', password: 'staff123', max_percent: 10, reason: 'x' })).status).toBe(401); // not an administrator
    expect((await audit('DISCOUNT_AUTH_FAILED')).length).toBe(2);

    const g = await auth({ username: 'admin', password: 'admin123', max_percent: 10, reason: 'loyal customer' });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ max_percent: 10, authorized_by: expect.any(String), reason: 'loyal customer' });

    const tooMuch = await staff.post('/sales', salePayload([cartItem(p, 1, { discount_percent: 12 })], { discount_authorization: g.body.token }));
    expect(tooMuch.body.code).toBe('DISCOUNT_AUTH_TOO_LOW');
    const q = await staff.post('/sales/quote', { items: [cartItem(p, 2, { discount_percent: 10 })], discount_authorization: g.body.token });
    expect(q.body.discount.authorization_required).toBe(false);
    const sale = await staff.post('/sales', { ...salePayload([cartItem(p, 2, { discount_percent: 10 })]), grand_total: q.body.grand_total, amount_paid: q.body.grand_total, discount_authorization: g.body.token });
    expect(sale.status).toBe(200);
    expect(sale.body.grand_total).toBe(396);
    const reuse = await staff.post('/sales', salePayload([cartItem(p, 1, { discount_percent: 10 })], { discount_authorization: g.body.token }));
    expect(reuse.status).toBe(403);
    expect(reuse.body.code).toBe('DISCOUNT_AUTH_USED');

    const overrides = await audit('DISCOUNT_OVERRIDE');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].description).toMatch(/above the staff limit \(0%\).*Panadol.*10%.*Authorized by .*Reason: loyal customer/);
    expect((await audit('DISCOUNT_AUTH_GRANTED'))[0].description).toMatch(/up to 10% .*Reason: loyal customer/);
  });

  it('an administrator selling with a discount must give a reason; the override is audited', async () => {
    const p = await product(1);
    const noReason = await admin.post('/sales', salePayload([cartItem(p, 1)], { discount_percent: 10 }));
    expect([noReason.status, noReason.body.code]).toEqual([400, 'DISCOUNT_REASON_REQUIRED']);
    const q = await admin.post('/sales/quote', { items: [cartItem(p, 1)], discount_percent: 10 });
    const ok = await admin.post('/sales', { ...salePayload([cartItem(p, 1)]), discount_percent: 10, discount_reason: 'expiring soon', grand_total: q.body.grand_total, amount_paid: q.body.grand_total });
    expect(ok.status).toBe(200);
    expect(ok.body.grand_total).toBe(198);
    expect((await audit('DISCOUNT_OVERRIDE'))[0].description).toMatch(/bill 10%.*Given by administrator.*Reason: expiring soon/);
  });

  it('store limits: validated, audited, ADMIN-only; above the store maximum nobody can discount', async () => {
    expect((await staff.post('/settings', { pos_staff_max_discount_percent: 50 })).status).toBe(403);
    expect((await admin.post('/settings', { pos_staff_max_discount_percent: 30, pos_admin_max_discount_percent: 20 })).status).toBe(400);
    expect((await admin.post('/settings', { pos_admin_max_discount_percent: 101 })).status).toBe(400);
    expect((await admin.post('/settings', { pos_staff_max_discount_percent: 5, pos_admin_max_discount_percent: 20 })).status).toBe(200);
    expect((await audit('DISCOUNT_LIMITS_CHANGED'))[0].description).toMatch(/staff 0% -> 5%, administrator 100% -> 20%/);

    const p = await product(1);
    // staff within their 5 %: no authorization and no reason needed
    const q = await staff.post('/sales/quote', { items: [cartItem(p, 1, { discount_percent: 5 })] });
    expect((await staff.post('/sales', { ...salePayload([cartItem(p, 1, { discount_percent: 5 })]), grand_total: q.body.grand_total, amount_paid: q.body.grand_total })).status).toBe(200);
    // above the store maximum: refused for the administrator too, and no authorization can be issued for it
    const r = await admin.post('/sales', salePayload([cartItem(p, 1)], { discount_percent: 25, discount_reason: 'x' }));
    expect([r.status, r.body.code]).toEqual([403, 'DISCOUNT_LIMIT']);
    expect((await staff.post('/sales/discount-authorization', { username: 'admin', password: 'admin123', max_percent: 25, reason: 'x' })).status).toBe(403);
  });

  it('five wrong administrator passwords lock authorization for that cashier', async () => {
    for (let i = 0; i < 5; i++) expect((await staff.post('/sales/discount-authorization', { username: 'admin', password: 'bad', max_percent: 5, reason: 'x' })).status).toBe(401);
    expect((await staff.post('/sales/discount-authorization', { username: 'admin', password: 'admin123', max_percent: 5, reason: 'x' })).status).toBe(429);
  });

  it('a replayed sale (same transaction id) returns the first result even though its authorization is used up', async () => {
    const p = await product(1);
    const g = await staff.post('/sales/discount-authorization', { username: 'admin', password: 'admin123', max_percent: 10, reason: 'r' });
    const q = await staff.post('/sales/quote', { items: [cartItem(p, 1, { discount_percent: 10 })], discount_authorization: g.body.token });
    const body = { ...salePayload([cartItem(p, 1, { discount_percent: 10 })]), grand_total: q.body.grand_total, amount_paid: q.body.grand_total, discount_authorization: g.body.token, client_txn_id: crypto.randomUUID() };
    const a = await staff.post('/sales', body);
    const b = await staff.post('/sales', body);
    expect(a.status).toBe(200);
    expect(b.body).toMatchObject({ replayed: true, sale_id: a.body.sale_id });
    expect((await product(1)).stock).toBe(119);
  });
});
