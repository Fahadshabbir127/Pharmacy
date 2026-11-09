/**
 * Characterisation: inventory, categories, suppliers, purchases, stock adjustments, customers & udhar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, Api, RunningServer, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, one, all, foreignKeyViolations } from '../helpers/db';

let srv: RunningServer;
let admin: Api;
const prod = async (id: number) => (await admin.get('/inventory')).body.find((p: any) => p.id === id);

beforeEach(async () => {
  srv = await startServer();
  admin = new Api();
  await admin.login('admin', 'admin123');
});
afterEach(async () => { await srv?.stop(); });

describe('inventory', () => {
  it('lists products with category/supplier info; supports search, low_stock and expiring filters', async () => {
    const list = (await admin.get('/inventory')).body;
    expect(list).toHaveLength(12);
    expect((await admin.get('/inventory?search=panadol')).body.map((p: any) => p.id)).toEqual([1]);
    const low = (await admin.get('/inventory?low_stock=true')).body;
    expect(low.map((p: any) => p.name)).toContain('Calamox 625mg Tablets');
    expect(low.every((p: any) => p.stock <= p.min_stock)).toBe(true);
    expect((await admin.get('/inventory?expiring=true&expiry_days=36500')).status).toBe(200);
  });

  it('add / edit / delete product; ADMIN-only delete', async () => {
    const add = await admin.post('/inventory', { name: 'Test Syrup', unit: 'Bottle', purchase_price: 50, sale_price: 70, stock: 5, barcode: '1234567890123', batch_number: 'TS-1', expiry_date: '2028-01-01' });
    expect(add.status).toBe(200);
    const id = add.body.id;
    expect(await prod(id)).toMatchObject({ name: 'Test Syrup', stock: 5, barcode: '1234567890123', hsn_code: '3004.90' });
    const p = await prod(id);
    const upd = await admin.put(`/inventory/${id}`, { ...p, sale_price: 75 });
    expect(upd.status).toBe(200);
    expect((await prod(id)).sale_price).toBe(75);
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.del(`/inventory/${id}`)).status).toBe(403);
    expect((await admin.del(`/inventory/${id}`)).status).toBe(200);
    expect(await prod(id)).toBeUndefined();
  });

  it('rejects a product without a name (400)', async () => {
    expect((await admin.post('/inventory', { unit: 'Pack' })).status).toBe(400);
  });

  // C11 fixed (was: an invented 8901000000NNN barcode)
  it('[FIXED C11] a new product without a barcode keeps an empty barcode (no invented manufacturer code)', async () => {
    const add = await admin.post('/inventory', { name: 'No Barcode Med', sale_price: 10 });
    expect((await prod(add.body.id)).barcode).toBe('');
  });

  it('strips HTML tags from product names (sanitizeInput)', async () => {
    const add = await admin.post('/inventory', { name: '<b>Bold</b> Med<script>alert(1)</script>' });
    expect((await prod(add.body.id)).name).toBe('Bold Med');
  });
});

describe('stock adjustments', () => {
  it('ADD and REMOVE adjust stock, record a row with reason, and audit', async () => {
    expect((await admin.post('/inventory/adjust', { product_id: 1, adjustment_type: 'ADD', quantity: 10, reason: 'Found in store' })).status).toBe(200);
    expect((await prod(1)).stock).toBe(130);
    expect((await admin.post('/inventory/adjust', { product_id: 1, adjustment_type: 'REMOVE', quantity: 30, reason: 'Damaged' })).status).toBe(200);
    expect((await prod(1)).stock).toBe(100);
    const db = await openReadOnly(srv.dbFile);
    expect(all(db, 'SELECT adjustment_type, quantity, reason FROM stock_adjustments ORDER BY id')).toEqual([
      { adjustment_type: 'ADD', quantity: 10, reason: 'Found in store' },
      { adjustment_type: 'REMOVE', quantity: 30, reason: 'Damaged' },
    ]);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type='STOCK_ADJUSTMENT'")).toEqual({ n: 2 });
  });

  it('REMOVE more than in stock clamps to 0 but records the full requested quantity', async () => {
    await admin.post('/inventory/adjust', { product_id: 6, adjustment_type: 'REMOVE', quantity: 100, reason: 'Expired' });
    expect((await prod(6)).stock).toBe(0);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT quantity FROM stock_adjustments')).toEqual({ quantity: 100 });
  });

  it('requires product_id, quantity and reason (400)', async () => {
    expect((await admin.post('/inventory/adjust', { product_id: 1, adjustment_type: 'ADD', quantity: 5 })).status).toBe(400);
  });
});

describe('categories & suppliers', () => {
  it('categories: list and add; adding an existing name (case-insensitive) returns the existing category', async () => {
    expect((await admin.get('/categories')).body).toHaveLength(11);
    const a = await admin.post('/categories', { name: 'Vaccines' });
    expect(a.status).toBe(200);
    const dup = await admin.post('/categories', { name: 'VACCINES' });
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ id: a.body.id, message: 'Category already exists' });
    expect((await admin.get('/categories')).body).toHaveLength(12);
  });

  it('suppliers: add / edit / delete', async () => {
    const add = await admin.post('/suppliers', { name: 'New Supplier', phone: '0300', company: 'Co', address: 'Addr' });
    expect(add.status).toBe(200);
    const list = (await admin.get('/suppliers')).body;
    const s = list.find((x: any) => x.name === 'New Supplier');
    expect(s).toBeDefined();
    expect((await admin.put(`/suppliers/${s.id}`, { ...s, phone: '0311' })).status).toBe(200);
    expect((await admin.del(`/suppliers/${s.id}`)).status).toBe(200);
  });
});

describe('purchases', () => {
  it('records header + items and increases stock', async () => {
    const r = await admin.post('/purchases', { supplier_id: 1, invoice_number: 'SUP-INV-1', items: [{ product_id: 1, quantity: 50, purchase_price: 185, batch_number: 'B-NEW', expiry_date: '2029-01-01' }] });
    expect(r.status).toBe(200);
    expect((await prod(1)).stock).toBe(170);
    const detail = await admin.get(`/purchases/${r.body.id}`);
    expect(detail.status).toBe(200);
    expect((await admin.get('/purchases')).body.length).toBe(1);
  });

  it('[LEGACY-BUG C6/R6] a purchase overwrites the product batch, expiry and purchase price (older batch data lost)', async () => {
    const before = await prod(1);
    expect(before).toMatchObject({ batch_number: 'B-8910', expiry_date: '2027-10-15', purchase_price: 180, stock: 120 });
    await admin.post('/purchases', { supplier_id: 1, items: [{ product_id: 1, quantity: 10, purchase_price: 200, batch_number: 'B-LATE', expiry_date: '2030-12-31' }] });
    const after = await prod(1);
    expect(after).toMatchObject({ batch_number: 'B-LATE', expiry_date: '2030-12-31', purchase_price: 200, stock: 130 });
    // the 120 units of B-8910 expiring 2027-10-15 are no longer distinguishable
  });

  it('auto-generates a PUR-<tenant>-NNNNNN number when none is given', async () => {
    const r = await admin.post('/purchases', { supplier_id: 2, items: [{ product_id: 2, quantity: 1, purchase_price: 300 }] });
    expect(r.body.invoice_number).toMatch(/^PUR-1-\d{6}$/);
  });

  // Phase 3 fix of R3 (was: header, first line and its stock increase were left behind)
  it('[FIXED R3] a purchase whose 2nd item fails is rolled back completely', async () => {
    const r = await admin.post('/purchases', { supplier_id: 1, invoice_number: 'PARTIAL-1', items: [
      { product_id: 1, quantity: 5, purchase_price: 180 },
      { product_id: null, quantity: 1, purchase_price: 300 }, // violates purchase_items.product_id NOT NULL
    ] });
    expect(r.status).toBe(500);
    expect((await prod(1)).stock).toBe(120);
    expect((await admin.get('/purchases')).body.map((p: any) => p.invoice_number)).not.toContain('PARTIAL-1');
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM purchase_items')).toEqual({ n: 0 });
  });
});

describe('customers & udhar ledger', () => {
  it('create customer: auto-creates a CUSTOMER portal login with default password customer123 [LEGACY-SECURITY]', async () => {
    const r = await admin.post('/customers', { name: 'Ali Raza', phone: '0345-1112223', address: 'X', opening_balance: 500 });
    expect(r.status).toBe(200);
    const cust = new Api();
    const u = await cust.login('03451112223', 'customer123');
    expect(u.role).toBe('CUSTOMER');
    const c = (await admin.get('/customers')).body.find((x: any) => x.name === 'Ali Raza');
    expect(c.current_balance).toBe(500);
    const ledger = (await admin.get(`/customers/${c.id}/ledger`)).body;
    const rows = Array.isArray(ledger) ? ledger : ledger.ledger;
    expect(rows[0]).toMatchObject({ type: 'ADJUSTMENT', reference: 'Opening Balance', debit: 500 });
  });

  it('duplicate phone (ignoring spaces/dashes) is rejected', async () => {
    expect((await admin.post('/customers', { name: 'Dup', phone: '0300 123-4567' })).status).toBe(400);
  });

  it('record payment reduces balance, writes PAYMENT ledger row, queues email+SMS', async () => {
    const r = await admin.post('/customers/1/payment', { amount: 450, payment_mode: 'Cash' });
    expect(r.status).toBe(200);
    expect(r.body.newBalance).toBe(2000);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT type, credit, balance_after FROM customer_ledger WHERE customer_id=1 ORDER BY id DESC LIMIT 1")).toEqual({ type: 'PAYMENT', credit: 450, balance_after: 2000 });
    expect(one(db, "SELECT COUNT(*) n FROM email_queue WHERE type='PAYMENT_CONFIRMATION'")).toEqual({ n: 1 });
  });

  it('overpayment makes the balance negative (no guard)', async () => {
    const r = await admin.post('/customers/3/payment', { amount: 100 });
    expect(r.body.newBalance).toBe(-100);
  });

  it('cannot delete a customer with a positive balance', async () => {
    expect((await admin.del('/customers/1')).status).toBe(400);
  });

  // FK2 fix (was: ledger erased, invoices orphaned, no audit row)
  it('[FIXED FK2] deleting a zero-balance customer with history archives them: ledger and invoices kept, audited, hidden from the list', async () => {
    const p = await prod(1);
    const s = await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'CASH', customer_id: 3 }));
    expect(s.status).toBe(200);
    const before = await openReadOnly(srv.dbFile);
    const ledgerBefore = one<{ n: number }>(before, 'SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=3')!.n;
    expect(ledgerBefore).toBeGreaterThan(0);
    const del = await admin.del('/customers/3');
    expect(del.status).toBe(200);
    expect(del.body.archived).toBe(true);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=3')).toEqual({ n: ledgerBefore });
    expect(one(db, 'SELECT COUNT(*) n FROM sales_headers WHERE customer_id=3')).toEqual({ n: 1 });
    expect(foreignKeyViolations(db)).toEqual([]);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'CUSTOMER_ARCHIVE'")).toEqual({ n: 1 });
    expect((await admin.get('/customers')).body.map((c: any) => c.id)).not.toContain(3);
    expect((await admin.get(`/sales/${s.body.sale_id}`)).body.customer_name).toBe('Dr. Rashid Ahmad');
  });

  it('deleting a customer without any history still deletes them (and is now audited)', async () => {
    const c = await admin.post('/customers', { name: 'No History', phone: '03120000099' });
    expect(c.status).toBe(200);
    const id = (await admin.get('/customers')).body.find((x: any) => x.name === 'No History').id;
    const del = await admin.del(`/customers/${id}`);
    expect(del.body.archived).toBeUndefined();
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM customers WHERE id = ?', [id])).toEqual({ n: 0 });
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'CUSTOMER_DELETE'")).toEqual({ n: 1 });
  });

  it('udhar reminder queues an email and an SMS', async () => {
    const r = await admin.post('/customers/1/remind', {});
    expect(r.status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM sms_queue WHERE customer_id=1")!.n).toBeGreaterThanOrEqual(1);
  });
});
