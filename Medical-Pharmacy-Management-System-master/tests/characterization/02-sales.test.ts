/**
 * Characterisation: POS sales, invoice numbering, void/delete, atomicity, concurrency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, Api, RunningServer, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, one, all } from '../helpers/db';

let srv: RunningServer;
let admin: Api;

async function product(id: number) {
  const inv = await admin.get('/inventory');
  return inv.body.find((p: any) => p.id === id);
}

beforeEach(async () => {
  srv = await startServer();
  admin = new Api();
  await admin.login('admin', 'admin123');
});
afterEach(async () => { await srv?.stop(); });

describe('cash sale', () => {
  it('records header + items, deducts stock, numbers the invoice INV-<tenant>-<1001+count of tenant sales>', async () => {
    const p = await product(1); // Panadol, stock 120, price 220
    const r = await admin.post('/sales', salePayload([cartItem(p, 3)]));
    expect(r.status).toBe(200);
    // the seeded INV-1001 now belongs to store #1 from the first start, so the next number is 1001 + 1
    expect(r.body).toMatchObject({ invoice_number: 'INV-1-1002', grand_total: 660, amount_paid: 660, amount_due: 0 });
    expect((await product(1)).stock).toBe(117);

    const detail = await admin.get(`/sales/${r.body.sale_id}`);
    expect(detail.body).toMatchObject({ payment_method: 'CASH', payment_status: 'PAID', tenant_id: 1 });
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0]).toMatchObject({ product_id: 1, quantity: 3, sale_price: 220, cost_price: 180, batch_number: 'B-8910' });

    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type='CREATE_SALE'")).toEqual({ n: 1 });
  });

  it('rejects an empty cart (400)', async () => {
    expect((await admin.post('/sales', salePayload([]))).status).toBe(400);
  });

  it('STAFF can sell; CUSTOMER cannot (403)', async () => {
    const p = await product(1);
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(200);
    const cust = new Api();
    await cust.login('03001234567', 'customer123');
    expect((await cust.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(403);
  });
});

describe('credit (udhar) and partial sales', () => {
  it('UDHAR/PARTIAL without a customer is rejected (400)', async () => {
    const p = await product(1);
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'UDHAR' }))).status).toBe(400);
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'PARTIAL' }))).status).toBe(400);
  });

  it('UDHAR sale: paid 0, balance increases, ledger SALE row, email+SMS queued', async () => {
    const p = await product(2); // 380
    const before = (await admin.get('/customers')).body.find((c: any) => c.id === 2).current_balance; // 1200
    const r = await admin.post('/sales', salePayload([cartItem(p, 2)], { payment_method: 'UDHAR', customer_id: 2, amount_paid: 760 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ amount_paid: 0, amount_due: 760, previous_balance: before, new_balance: before + 760 });
    const ledger = (await admin.get('/customers/2/ledger')).body;
    const rows = Array.isArray(ledger) ? ledger : ledger.ledger;
    expect(rows.some((l: any) => l.type === 'SALE' && l.debit === 760 && l.credit === 0 && l.balance_after === before + 760)).toBe(true);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM email_queue WHERE customer_id=2 AND status='PENDING'")).toEqual({ n: 1 });
    expect(one(db, "SELECT COUNT(*) n FROM sms_queue WHERE customer_id=2 AND status='PENDING'")).toEqual({ n: 1 });
    expect(one(db, `SELECT payment_status FROM sales_headers WHERE id=${r.body.sale_id}`)).toEqual({ payment_status: 'UNPAID' });
  });

  it('PARTIAL sale sets payment_status PARTIAL and adds only the due amount to the balance', async () => {
    const p = await product(1);
    const r = await admin.post('/sales', salePayload([cartItem(p, 2)], { payment_method: 'PARTIAL', customer_id: 3, amount_paid: 100 }));
    expect(r.body).toMatchObject({ amount_paid: 100, amount_due: 340, previous_balance: 0, new_balance: 340 });
  });
});

describe('known defects in the sale path', () => {
  // Phase 6 fix of C2/R5 (was: overselling accepted with 200 and stock clamped to 0)
  it('[FIXED C2/R5] overselling is refused with 409 INSUFFICIENT_STOCK and nothing is recorded', async () => {
    const p = await product(6); // Calamox, stock 8
    const r = await admin.post('/sales', salePayload([cartItem(p, 50)]));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', product_id: 6, requested: 50, available: 8 });
    expect((await product(6)).stock).toBe(8);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM sales_headers')).toEqual({ n: 1 });
  });

  // Phase 6 (D6): cost now comes from the batch on the server; prices/totals are still trusted until Phase 7 (C9)
  it('[LEGACY-SECURITY C9/S6] server trusts client-supplied prices and totals (cost is now the batch cost, D6)', async () => {
    const p = await product(1);
    const tampered = { ...p, purchase_price: 0 };
    const item = cartItem(tampered, 5, { unit_price: 1 });
    const r = await admin.post('/sales', salePayload([item], { grand_total: 5, amount_paid: 5 }));
    expect(r.status).toBe(200);
    const d = await admin.get(`/sales/${r.body.sale_id}`);
    expect(d.body.grand_total).toBe(5);
    expect(d.body.items[0]).toMatchObject({ sale_price: 1, cost_price: 180 });
  });

  it('[LEGACY-BUG C3] posting the same sale twice creates two sales (no idempotency)', async () => {
    const p = await product(1);
    const payload = salePayload([cartItem(p, 1)]);
    const a = await admin.post('/sales', payload);
    const b = await admin.post('/sales', payload);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.invoice_number).not.toBe(b.body.invoice_number);
    expect((await product(1)).stock).toBe(118);
  });

  it('[LEGACY-BUG R4] after deleting an older invoice, the next sale fails on a duplicate invoice number', async () => {
    const p = await product(1);
    const s1 = await admin.post('/sales', salePayload([cartItem(p, 1)])); // INV-1-1002
    const s2 = await admin.post('/sales', salePayload([cartItem(p, 1)])); // INV-1-1003
    expect(s2.body.invoice_number).toBe('INV-1-1003');
    expect((await admin.del(`/sales/${s1.body.sale_id}`)).status).toBe(200);
    const s3 = await admin.post('/sales', salePayload([cartItem(p, 1)])); // computes INV-1-1003 again
    expect(s3.status).toBe(500);
    expect(s3.body.error).toMatch(/UNIQUE/i);
  });

  it('[LEGACY-BUG R4] deleting the newest invoice causes its number to be re-issued to a different sale', async () => {
    const p = await product(1);
    const s1 = await admin.post('/sales', salePayload([cartItem(p, 1)]));
    await admin.del(`/sales/${s1.body.sale_id}`);
    const s2 = await admin.post('/sales', salePayload([cartItem(p, 2)]));
    expect(s2.body.invoice_number).toBe(s1.body.invoice_number);
  });

  // FK5 fix (was: the sale was recorded against a product that does not exist)
  // Phase 6: now caught by validation before any write (400) instead of by the foreign key (500)
  it('[FIXED FK5] a sale referencing a non-existent product id is rejected and nothing is recorded', async () => {
    const ghost = { id: 99999, name: 'Ghost', unit: 'Pack', sale_price: 10, purchase_price: 5, gst_rate: 0 };
    const r = await admin.post('/sales', salePayload([cartItem(ghost, 1)]));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PRODUCT_NOT_FOUND');
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM sales_headers WHERE invoice_number LIKE 'INV-1-%'")).toEqual({ n: 0 });
  });

  // FK2 fix (was: deleting the product made its lines disappear from past invoices)
  it('[FIXED FK2] deleting a sold product archives it: past invoices keep the line, the product leaves the active list', async () => {
    const add = await admin.post('/inventory', { name: 'Temp Med', unit: 'Pack', purchase_price: 5, sale_price: 10, stock: 10 });
    const p = await product(add.body.id);
    const s = await admin.post('/sales', salePayload([cartItem(p, 1)]));
    expect((await admin.get(`/sales/${s.body.sale_id}`)).body.items).toHaveLength(1);
    const del = await admin.del(`/inventory/${p.id}`);
    expect(del.status).toBe(200);
    expect(del.body.archived).toBe(true);
    const after = await admin.get(`/sales/${s.body.sale_id}`);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0]).toMatchObject({ product_name: 'Temp Med', subtotal: 10 });
    expect(after.body.grand_total).toBe(10);
    expect(await product(p.id)).toBeUndefined();
  });
});

describe('atomicity', () => {
  it('a sale that throws mid-way rolls back stock, items and customer balance', async () => {
    const p = await product(1);
    const before = (await admin.get('/customers')).body.find((c: any) => c.id === 1).current_balance;
    const good = cartItem(p, 4);
    // Phase 6: a line without a product is now refused by validation before any write (400);
    // a mid-way failure is produced with a value SQLite cannot store in the 2nd line's INSERT.
    expect((await admin.post('/sales', salePayload([good, { quantity: 1, unit_price: 1, subtotal: 1 } as any]))).status).toBe(400);
    const broken = { ...cartItem(await product(2), 1), discount_percent: { not: 'a number' } };
    const r = await admin.post('/sales', salePayload([good, broken as any], { payment_method: 'UDHAR', customer_id: 1 }));
    expect(r.status).toBe(500);
    expect((await product(1)).stock).toBe(120);
    expect((await product(2)).stock).toBe(45);
    expect((await admin.get('/customers')).body.find((c: any) => c.id === 1).current_balance).toBe(before);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM sales_headers')).toEqual({ n: 1 });
  });
});

describe('void / delete invoice', () => {
  it('[CHANGE C1] ADMIN delete restores stock, reverses udhar, writes ADJUSTMENT ledger, and hard-deletes the rows', async () => {
    const p = await product(1);
    const s = await admin.post('/sales', salePayload([cartItem(p, 5)], { payment_method: 'UDHAR', customer_id: 3 }));
    expect((await product(1)).stock).toBe(115);
    const del = await admin.del(`/sales/${s.body.sale_id}`);
    expect(del.status).toBe(200);
    expect((await product(1)).stock).toBe(120);
    expect((await admin.get('/customers')).body.find((c: any) => c.id === 3).current_balance).toBe(0);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, `SELECT COUNT(*) n FROM sales_headers WHERE id=${s.body.sale_id}`)).toEqual({ n: 0 });
    expect(one(db, `SELECT COUNT(*) n FROM sale_items WHERE sale_id=${s.body.sale_id}`)).toEqual({ n: 0 });
    expect(all(db, "SELECT type FROM customer_ledger WHERE customer_id=3").map((r: any) => r.type)).toEqual(['SALE', 'ADJUSTMENT']);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type='SALE_DELETE'")).toEqual({ n: 1 });
  });

  it('STAFF cannot delete invoices (403)', async () => {
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.del('/sales/1')).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('20 parallel sales of qty 1: exact stock, unique invoice numbers (single-threaded sql.js)', async () => {
    const p = await product(3); // Brufen stock 80
    const results = await Promise.all(Array.from({ length: 20 }, () => admin.post('/sales', salePayload([cartItem(p, 1)]))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.invoice_number)).size).toBe(20);
    expect((await product(3)).stock).toBe(60);
  });
});

describe('sales history', () => {
  it('lists sales with customer and creator names, filterable by customer', async () => {
    const p = await product(1);
    await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'UDHAR', customer_id: 2 }));
    const allSales = (await admin.get('/sales/history')).body;
    // first-boot fix: the seeded demo sale is listed too
    expect(allSales.length).toBe(2);
    const forCust = (await admin.get('/sales/history?customer_id=2')).body;
    expect(forCust).toHaveLength(1);
    expect(forCust[0]).toMatchObject({ customer_name: 'Tariq Mahmood', created_by_name: 'Muhammad Asghar (Owner)' });
  });
});
