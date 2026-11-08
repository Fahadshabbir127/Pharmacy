/**
 * Characterisation: reports, email/SMS queues, settings, backup/restore, users, audit, super admin, portal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { startServer, Api, RunningServer, cartItem, salePayload, BASE_URL } from '../helpers/server';
import { openReadOnly, one, all, integrityCheck } from '../helpers/db';

let srv: RunningServer;
let admin: Api;

beforeEach(async () => {
  srv = await startServer();
  admin = new Api();
  await admin.login('admin', 'admin123');
});
afterEach(async () => { await srv?.stop(); });

describe('reports', () => {
  it('dashboard returns sales/profit/udhar/stock counters', async () => {
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    await admin.post('/sales', salePayload([cartItem(p, 2)]));
    const d = (await admin.get('/reports/dashboard')).body;
    // the seeded demo sale INV-1001 (Rs 2650) is dated today, so it is included
    expect(d).toMatchObject({ todaySalesTotal: 3090, todaySalesCount: 2, totalProductsCount: 12, totalCustomersCount: 3 });
    expect(d.totalUdharBalance).toBe(3650);
    expect(d.lowStockCount).toBeGreaterThanOrEqual(1);
  });

  it('sales report and top products respond for a date range', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await admin.get(`/reports/sales?start_date=${today}&end_date=${today}`)).status).toBe(200);
    expect((await admin.get('/reports/top-products')).status).toBe(200);
  });

  it('CUSTOMER cannot read reports (403)', async () => {
    const c = new Api();
    await c.login('03001234567', 'customer123');
    expect((await c.get('/reports/dashboard')).status).toBe(403);
  });
});

describe('email & SMS queues', () => {
  it('[CHANGE C10] "process" marks every PENDING email as SENT without sending anything', async () => {
    await admin.post('/customers/1/remind', {});
    const before = (await admin.get('/email/queue')).body;
    expect(before.some((e: any) => e.status === 'PENDING')).toBe(true);
    const r = await admin.post('/email/process', {});
    expect(r.body.message).toMatch(/Successfully dispatched/);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM email_queue WHERE status='PENDING'")).toEqual({ n: 0 });
  });

  it('[CHANGE C10] SMS "process" marks PENDING SMS as SENT', async () => {
    const r = await admin.post('/sms/process', {});
    expect(r.status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM sms_queue WHERE status='PENDING'")).toEqual({ n: 0 });
  });

  it('queue items can be edited, deleted and cleared', async () => {
    await admin.post('/customers/1/remind', {});
    const q = (await admin.get('/sms/queue')).body;
    expect(q.length).toBeGreaterThan(0);
    expect((await admin.put(`/sms/queue/${q[0].id}`, { message: 'edited', phone: q[0].phone })).status).toBe(200);
    expect((await admin.del(`/sms/queue/${q[0].id}`)).status).toBe(200);
    expect((await admin.del('/email/queue')).status).toBe(200);
  });
});

describe('settings', () => {
  it('ADMIN saves arbitrary keys; STAFF cannot save', async () => {
    expect((await admin.post('/settings', { store_name: 'Renamed Store', arbitrary_key: 'x' })).status).toBe(200);
    const s = (await admin.get('/settings')).body;
    expect(s).toMatchObject({ store_name: 'Renamed Store', arbitrary_key: 'x' });
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.post('/settings', { store_name: 'x' })).status).toBe(403);
  });

  it('SMTP test only queues an email (no network)', async () => {
    const r = await admin.post('/settings/test-smtp', { testEmail: 't@test.local' });
    expect(r.status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    // [LEGACY-BUG] the test row is attached to customer_id = 1 regardless of whether it exists
    expect(one(db, "SELECT customer_id FROM email_queue WHERE email='t@test.local'")).toEqual({ customer_id: 1 });
  });
});

describe('backup & restore', () => {
  it('rejects a weak backup password', async () => {
    expect((await admin.post('/backup/export', { password: 'short' })).status).toBe(400);
  });

  it('encrypted export -> change data -> import restores the earlier state', async () => {
    const exp = await admin.post('/backup/export', { password: 'Backup123!' });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toMatch(/Khushi_Medical_Backup_.*\.kmhbackup/);
    expect(exp.body).toMatchObject({ version: '1.0' });
    expect(typeof exp.body.iv).toBe('string');

    await admin.post('/categories', { name: 'After Backup' });
    expect((await admin.get('/categories')).body.map((c: any) => c.name)).toContain('After Backup');

    expect((await admin.post('/backup/import', { backupPayload: exp.body, password: 'wrong-pass1' })).status).toBe(400);
    const imp = await admin.post('/backup/import', { backupPayload: exp.body, password: 'Backup123!' });
    expect(imp.status).toBe(200);
    expect((await admin.get('/categories')).body.map((c: any) => c.name)).not.toContain('After Backup');
  });

  it('[LEGACY-BUG S8] restore keeps no safety copy of the database it replaces', async () => {
    const exp = await admin.post('/backup/export', { password: 'Backup123!' });
    await admin.post('/backup/import', { backupPayload: exp.body, password: 'Backup123!' });
    const files = fs.readdirSync(`${srv.workDir}/data`);
    expect(files).toEqual(['khushi_pharmacy.sqlite']);
  });

  it('accepts a raw base64 SQLite file without a password', async () => {
    const raw = fs.readFileSync(srv.dbFile).toString('base64');
    expect((await admin.post('/backup/import', { backupPayload: raw })).status).toBe(200);
  });

  it('MySQL dump export returns SQL text with CREATE TABLE and INSERT statements', async () => {
    const res = await fetch(`${BASE_URL}/api/backup/mysql-export`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const sql = await res.text();
    expect(sql).toMatch(/CREATE TABLE `products`/);
    expect(sql).toMatch(/INSERT INTO `products`/);
  });

  it('STAFF cannot export backups (403)', async () => {
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.post('/backup/export', { password: 'Backup123!' })).status).toBe(403);
  });

  it('[LEGACY-BUG R11] the "daily backup" cron only re-saves the live file (source check)', () => {
    const src = fs.readFileSync(`${__dirname}/../../server.ts`, 'utf8');
    const cronBlock = src.slice(src.indexOf("cron.schedule('0 0 * * *'"), src.indexOf("cron.schedule('0 0 * * *'") + 250);
    expect(cronBlock).toMatch(/saveDatabase\(\)/);
    expect(cronBlock).not.toMatch(/backup\(|copyFile|writeFile/);
  });
});

describe('users', () => {
  it('create / status / role / reset password / delete', async () => {
    const c = await admin.post('/users', { username: 'cashier1', password: 'Cashier123', fullName: 'Cashier One', role: 'STAFF', email: 'c1@test.local' });
    expect(c.status).toBe(200);
    const u = (await admin.get('/users')).body.find((x: any) => x.username === 'cashier1');
    expect((await admin.put(`/users/${u.id}/status`, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await new Api().post('/auth/login', { username: 'cashier1', password: 'Cashier123' })).status).toBe(403);
    expect((await admin.put(`/users/${u.id}/status`, { status: 'APPROVED' })).status).toBe(200);
    expect((await admin.put(`/users/${u.id}/reset-password`, { password: 'weak' })).status).toBe(400);
    expect((await admin.put(`/users/${u.id}/reset-password`, { password: 'NewPass123' })).status).toBe(200);
    expect((await new Api().login('cashier1', 'NewPass123')).username).toBe('cashier1');
    expect((await admin.put(`/users/${u.id}/role`, { role: 'ADMIN' })).status).toBe(200);
    expect((await admin.del(`/users/${u.id}`)).status).toBe(200);
  });

  it('a suspended user’s existing token stops working immediately', async () => {
    await admin.post('/users', { username: 'cashier2', password: 'Cashier123', fullName: 'Cashier Two', role: 'STAFF', email: 'c2@test.local' });
    const u = (await admin.get('/users')).body.find((x: any) => x.username === 'cashier2');
    const s = new Api();
    await s.login('cashier2', 'Cashier123');
    expect((await s.get('/inventory')).status).toBe(200);
    await admin.put(`/users/${u.id}/status`, { status: 'SUSPENDED' });
    expect((await s.get('/inventory')).status).toBe(403);
  });
});

describe('audit logs', () => {
  it('[LEGACY-BUG] on first boot the store admin sees an empty audit log (own rows have tenant_id NULL); SUPER_ADMIN sees them', async () => {
    const list = await admin.get('/audit-logs');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    const saRows = (await sa.get('/audit-logs')).body;
    expect(saRows.some((l: any) => l.action_type === 'LOGIN_SUCCESS' && l.user_name === 'Muhammad Asghar (Owner)')).toBe(true);
  });

  it('ADMIN can clear the audit log (the clear itself is logged)', async () => {
    expect((await admin.del('/audit-logs/clear')).status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(all(db, 'SELECT action_type FROM audit_logs').map((r: any) => r.action_type)).toEqual(['AUDIT_LOGS_CLEARED']);
  });
});

describe('super admin (multi-store)', () => {
  it('create tenant -> login-as -> suspend blocks store users -> delete', async () => {
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    expect((await sa.get('/superadmin/metrics')).status).toBe(200);
    const c = await sa.post('/superadmin/tenants', { name: 'Second Pharmacy', owner_name: 'Owner Two', owner_email: 'owner2@test.local', owner_password: 'Owner123!' });
    expect(c.status).toBe(200);
    const tenants = (await sa.get('/superadmin/tenants')).body;
    const t = (Array.isArray(tenants) ? tenants : tenants.tenants).find((x: any) => x.owner_email === 'owner2@test.local');
    expect(t).toBeDefined();
    const la = await sa.post(`/superadmin/tenants/${t.id}/login-as`, {});
    expect(la.status).toBe(200);
    expect(typeof la.body.token).toBe('string');

    const owner = new Api();
    owner.token = la.body.token;
    expect((await owner.get('/inventory')).status).toBe(200);
    expect((await sa.put(`/superadmin/tenants/${t.id}/status`, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await owner.get('/inventory')).status).toBe(403);

    expect((await sa.del('/superadmin/tenants/1')).status).toBe(400);
    expect((await sa.del(`/superadmin/tenants/${t.id}`)).status).toBe(200);
  });

  it('tenant isolation: a second store sees none of store #1’s products or customers', async () => {
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    await sa.post('/superadmin/tenants', { name: 'Iso Pharmacy', owner_name: 'Iso', owner_email: 'iso@test.local', owner_password: 'Owner123!' });
    const t = ((await sa.get('/superadmin/tenants')).body as any[]).find((x: any) => x.owner_email === 'iso@test.local');
    const owner = new Api();
    owner.token = (await sa.post(`/superadmin/tenants/${t.id}/login-as`, {})).body.token;
    // [LEGACY-BUG] on first boot store #1 rows have tenant_id NULL, and NULL rows are visible to every store
    const inv = (await owner.get('/inventory')).body;
    expect(inv.length).toBe(12);
  });

  it('[LEGACY-SECURITY] an ADMIN of any store can clear the audit log of every store', async () => {
    const sa = new Api();
    await sa.login('superadmin', 'admin123');
    await sa.post('/superadmin/tenants', { name: 'Other', owner_name: 'O', owner_email: 'other@test.local', owner_password: 'Owner123!' });
    const t = ((await sa.get('/superadmin/tenants')).body as any[]).find((x: any) => x.owner_email === 'other@test.local');
    const other = new Api();
    other.token = (await sa.post(`/superadmin/tenants/${t.id}/login-as`, {})).body.token;
    expect((await other.del('/audit-logs/clear')).status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type='LOGIN_SUCCESS'")).toEqual({ n: 0 });
  });
});

describe('SPA fallback & DB integrity after a full session', () => {
  it('unknown non-API paths fall back to index.html handling (404/500 when dist/ is absent)', async () => {
    const res = await fetch(`${BASE_URL}/some/client/route`);
    expect([200, 404, 500]).toContain(res.status);
  });

  it('database file passes integrity_check after many writes', async () => {
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    for (let i = 0; i < 10; i++) await admin.post('/sales', salePayload([cartItem(p, 1)]));
    expect(integrityCheck(await openReadOnly(srv.dbFile))).toEqual([]);
  });
});
