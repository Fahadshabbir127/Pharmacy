/**
 * FK2/FK3 archiving rules (approved): records with history are archived, never deleted.
 * Archived records are hidden from active lists but still resolve on invoices, ledgers,
 * reports and audit logs. Archived accounts cannot sign in.
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

describe('products', () => {
  it('archived product: hidden from inventory/POS search and dashboard counts; still on invoices and in top-products', async () => {
    const p = await prod(2);
    const sale = await admin.post('/sales', salePayload([cartItem(p, 3)]));
    const before = (await admin.get('/reports/dashboard')).body;
    expect((await admin.del('/inventory/2')).body.archived).toBe(true);

    expect((await admin.get('/inventory')).body.map((x: any) => x.id)).not.toContain(2);
    expect((await admin.get('/inventory?search=augmentin')).body).toEqual([]);
    const after = (await admin.get('/reports/dashboard')).body;
    expect(after.totalProductsCount).toBe(before.totalProductsCount - 1);
    expect(after.todaySalesTotal).toBe(before.todaySalesTotal); // money history unchanged

    const inv = (await admin.get(`/sales/${sale.body.sale_id}`)).body;
    expect(inv.items[0]).toMatchObject({ product_name: 'Augmentin 625mg Tablets', quantity: 3 });
    const top = (await admin.get('/reports/top-products')).body;
    expect(JSON.stringify(top)).toContain('Augmentin 625mg Tablets');
  });

  it('a product without history is still deleted for real', async () => {
    const add = await admin.post('/inventory', { name: 'Never Sold', sale_price: 5 });
    const del = await admin.del(`/inventory/${add.body.id}`);
    expect(del.body.archived).toBeUndefined();
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM products WHERE id = ?', [add.body.id])).toEqual({ n: 0 });
  });
});

describe('customers', () => {
  it('archived customer: portal login disabled, ledger and balance kept, phone can be reused by a new customer', async () => {
    const p = await prod(1);
    await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'CASH', customer_id: 1 }));
    await admin.post('/customers/1/payment', { amount: 2450 }); // clear the udhar so delete is allowed
    expect((await admin.del('/customers/1')).body.archived).toBe(true);
    expect((await new Api().post('/auth/login', { username: '03001234567', password: 'customer123' })).status).toBe(403);

    const db = await openReadOnly(srv.dbFile);
    expect(one<any>(db, 'SELECT name, current_balance, archived_at IS NOT NULL a FROM customers WHERE id = 1')).toEqual({ name: 'Chaudhry Muhammad Ali', current_balance: 0, a: 1 });
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM customer_ledger WHERE customer_id = 1')!.n).toBeGreaterThanOrEqual(3);
    db.close();

    const again = await admin.post('/customers', { name: 'New Owner Of Number', phone: '03001234567' });
    expect(again.status).toBe(200);
    expect((await new Api().login('03001234567', 'customer123')).fullName).toBe('New Owner Of Number');
    const db2 = await openReadOnly(srv.dbFile);
    expect(one<any>(db2, 'SELECT phone, archived_key FROM customers WHERE id = 1')).toEqual({ phone: '03001234567~archived-1', archived_key: '03001234567' });
    expect(foreignKeyViolations(db2)).toEqual([]);
  });

  it('a customer with outstanding udhar still cannot be deleted', async () => {
    expect((await admin.del('/customers/1')).status).toBe(400);
  });
});

describe('users', () => {
  it('archiving a user keeps their sales attributed to them (no re-assignment to user #1) and blocks sign-in', async () => {
    await admin.post('/users', { username: 'cashier9', password: 'Cashier123', fullName: 'Cashier Nine', role: 'STAFF', email: 'c9@test.local' });
    const cashier = new Api();
    await cashier.login('cashier9', 'Cashier123');
    const p = await prod(1);
    const sale = await cashier.post('/sales', salePayload([cartItem(p, 1)]));
    const id = (await admin.get('/users')).body.find((u: any) => u.username === 'cashier9').id;

    const del = await admin.del(`/users/${id}`);
    expect(del.body.archived).toBe(true);
    expect((await cashier.get('/inventory')).status).toBe(403); // existing token rejected
    expect((await new Api().post('/auth/login', { username: 'cashier9', password: 'Cashier123' })).status).toBe(403);
    expect((await admin.get('/users')).body.map((u: any) => u.username)).not.toContain('cashier9');

    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT created_by_user_id u FROM sales_headers WHERE id = ?', [sale.body.sale_id])).toEqual({ u: id });
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'USER_ARCHIVE'")).toEqual({ n: 1 });
    db.close();
    expect((await admin.get(`/sales/${sale.body.sale_id}`)).body.created_by_name).toBe('Cashier Nine');

    // the username can be given to a new person; the archived account keeps its history
    expect((await admin.post('/users', { username: 'cashier9', password: 'Cashier456', fullName: 'New Cashier', role: 'STAFF' })).status).toBe(200);
    expect((await new Api().login('cashier9', 'Cashier456')).fullName).toBe('New Cashier');
  });
});

describe('suppliers', () => {
  it('a supplier with purchases is archived and hidden; the purchase still shows its supplier', async () => {
    const add = await admin.post('/suppliers', { name: 'Archived Supplier Co' });
    const s = (await admin.get('/suppliers')).body.find((x: any) => x.name === 'Archived Supplier Co');
    const pur = await admin.post('/purchases', { supplier_id: s.id, items: [{ product_id: 1, quantity: 1, purchase_price: 100 }] });
    expect(add.status).toBe(200);
    expect((await admin.del(`/suppliers/${s.id}`)).body.archived).toBe(true);
    expect((await admin.get('/suppliers')).body.map((x: any) => x.id)).not.toContain(s.id);
    const detail = (await admin.get(`/purchases/${pur.body.id}`)).body;
    expect(JSON.stringify(detail)).toContain('Archived Supplier Co');
  });
});

describe('stores (FK3)', () => {
  it('removing a store archives it: users blocked, data kept, hidden from the store list, audit row written', async () => {
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    await sa.post('/superadmin/tenants', { name: 'Branch X', owner_name: 'X', owner_email: 'x@test.local', owner_password: 'Owner123!' });
    const t = ((await sa.get('/superadmin/tenants')).body as any[]).find((x) => x.owner_email === 'x@test.local');
    const owner = new Api();
    owner.token = (await sa.post(`/superadmin/tenants/${t.id}/login-as`, {})).body.token;
    const add = await owner.post('/inventory', { name: 'Branch X Med', sale_price: 9, stock: 5 });
    const p = (await owner.get('/inventory')).body.find((x: any) => x.id === add.body.id);
    const sale = await owner.post('/sales', salePayload([cartItem(p, 1)]));
    expect(sale.status).toBe(200);

    const del = await sa.del(`/superadmin/tenants/${t.id}`);
    expect(del.body.archived).toBe(true);
    expect((await owner.get('/inventory')).status).toBe(403);
    expect(((await sa.get('/superadmin/tenants')).body as any[]).map((x) => x.id)).not.toContain(t.id);

    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT status, archived_at IS NOT NULL a FROM tenants WHERE id = ?', [t.id])).toEqual({ status: 'DELETED', a: 1 });
    expect(one(db, 'SELECT COUNT(*) n FROM sales_headers WHERE tenant_id = ?', [t.id])).toEqual({ n: 1 });
    expect(one(db, 'SELECT COUNT(*) n FROM sale_items WHERE sale_id = ?', [sale.body.sale_id])).toEqual({ n: 1 });
    expect(one(db, 'SELECT COUNT(*) n FROM products WHERE tenant_id = ?', [t.id])).toEqual({ n: 1 });
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'SUPERADMIN_TENANT_ARCHIVE'")).toEqual({ n: 1 });
    expect(foreignKeyViolations(db)).toEqual([]);
    // the owner email can be used for a new store
    expect((await sa.post('/superadmin/tenants', { name: 'Branch X2', owner_name: 'X', owner_email: 'x@test.local', owner_password: 'Owner123!' })).status).toBe(200);
  });

  it('the primary store #1 still cannot be removed', async () => {
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    expect((await sa.del('/superadmin/tenants/1')).status).toBe(400);
  });
});

describe('foreign keys are enforced at runtime', () => {
  it('foreign_keys is ON in the running server (writes with dangling ids fail)', async () => {
    expect((await admin.post('/purchases', { supplier_id: 999, items: [{ product_id: 1, quantity: 1, purchase_price: 1 }] })).status).toBe(500);
    expect((await admin.post('/sales', salePayload([cartItem(await prod(1), 1)], { payment_method: 'UDHAR', customer_id: 999 }))).status).toBe(500);
    const db = await openReadOnly(srv.dbFile);
    expect(all(db, 'SELECT COUNT(*) n FROM purchase_headers')).toEqual([{ n: 0 }]);
  });
});
