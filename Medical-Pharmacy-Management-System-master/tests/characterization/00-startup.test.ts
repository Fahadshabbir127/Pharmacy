/**
 * Characterisation: startup, seeding, persistence.
 * These tests record CURRENT behaviour (including known defects, tagged
 * [LEGACY-BUG …] / [LEGACY-SECURITY …]). Later phases flip the tagged
 * expectations deliberately; untagged expectations must keep passing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { startServer, Api, RunningServer, BASE_URL } from '../helpers/server';
import { openReadOnly, all, one, tableNames, integrityCheck } from '../helpers/db';

describe('startup on an empty data directory', () => {
  let srv: RunningServer;
  beforeAll(async () => { srv = await startServer(); });
  afterAll(async () => { await srv?.stop(); });

  it('creates the SQLite file under <cwd>/data', () => {
    expect(fs.existsSync(srv.dbFile)).toBe(true);
  });

  it('creates all 17 legacy tables plus schema_migrations (Phase 3) and uses WAL', async () => {
    const db = await openReadOnly(srv.dbFile);
    expect(tableNames(db)).toEqual([
      'audit_logs', 'categories', 'customer_ledger', 'customers', 'email_queue', 'otp_verifications',
      'products', 'purchase_headers', 'purchase_items', 'sale_items', 'sales_headers', 'schema_migrations', 'settings',
      'sms_queue', 'stock_adjustments', 'suppliers', 'tenants', 'users',
    ]);
    expect(integrityCheck(db)).toEqual([]);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('seeds demo data: 11 categories, 3 suppliers, 3 customers, 12 products, 1 sale', async () => {
    const db = await openReadOnly(srv.dbFile);
    const c = (t: string) => one<{ n: number }>(db, `SELECT COUNT(*) n FROM ${t}`)!.n;
    expect(c('categories')).toBe(11);
    expect(c('suppliers')).toBe(3);
    expect(c('customers')).toBe(3);
    expect(c('products')).toBe(12);
    expect(c('sales_headers')).toBe(1);
    expect(one(db, 'SELECT name FROM tenants WHERE id=1')).toEqual({ name: 'Khushi Medical Hall' });
  });

  it('[LEGACY-SECURITY S3] seeds demo logins admin/admin123, staff/staff123 and a customer123 portal user', async () => {
    const api = new Api();
    expect((await api.login('admin', 'admin123')).role).toBe('ADMIN');
    expect((await new Api().login('staff', 'staff123')).role).toBe('STAFF');
    expect((await new Api().login('03001234567', 'customer123')).role).toBe('CUSTOMER');
  });

  it('[LEGACY-SECURITY S2] force-creates SUPER_ADMIN accounts with hardcoded passwords', async () => {
    const db = await openReadOnly(srv.dbFile);
    const supers = all<{ username: string }>(db, "SELECT username FROM users WHERE role='SUPER_ADMIN' ORDER BY username");
    expect(supers.map((s) => s.username)).toEqual(['superadmin', 'umarumair75108@gmail.com']);
    expect((await new Api().login('superadmin', 'admin123')).role).toBe('SUPER_ADMIN');
  });

  it('seeded products have no barcode on the very first start (backfill runs before seeding)', async () => {
    const db = await openReadOnly(srv.dbFile);
    const p = one<{ barcode: string | null }>(db, 'SELECT barcode FROM products WHERE id=1');
    expect(p!.barcode).toBeNull();
  });

  it('[LEGACY-BUG] on first boot every seeded row has tenant_id NULL (backfill runs before seeding)', async () => {
    const db = await openReadOnly(srv.dbFile);
    for (const t of ['users', 'products', 'sales_headers', 'customers', 'categories', 'suppliers', 'settings']) {
      expect(one<{ n: number }>(db, `SELECT COUNT(*) n FROM ${t} WHERE tenant_id IS NOT NULL`)!.n, t).toBe(0);
    }
  });

  it('serves the API with open CORS (Access-Control-Allow-Origin: *) [LEGACY-SECURITY S5]', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Origin: 'http://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('persistence across restart', () => {
  it('keeps data written before a restart and does not re-seed', async () => {
    let srv = await startServer();
    const api = new Api();
    await api.login('admin', 'admin123');
    const add = await api.post('/categories', { name: 'Persistence Test Cat' });
    expect(add.status).toBe(200);
    const workDir = srv.workDir;
    await srv.stop();

    srv = await startServer({ workDir });
    try {
      const api2 = new Api();
      await api2.login('admin', 'admin123');
      const cats = await api2.get('/categories');
      expect(cats.body.map((c: any) => c.name)).toContain('Persistence Test Cat');
      const db = await openReadOnly(srv.dbFile);
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM products')!.n).toBe(12);
      // the second start backfills tenant_id = 1 (SUPER_ADMIN users stay NULL)
      expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM products WHERE tenant_id IS NULL")!.n).toBe(0);
      expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM users WHERE tenant_id IS NULL AND role != 'SUPER_ADMIN'")!.n).toBe(0);
      // [LEGACY-BUG C11] second start invents 8901000000NNN barcodes for products without one
      expect(one<{ barcode: string }>(db, 'SELECT barcode FROM products WHERE id=1')!.barcode).toBe('8901000000001');
    } finally {
      await srv.stop();
    }
  });

  it("[LEGACY-BUG R8] rewrites the 'admin' user's full name on every start", async () => {
    let srv = await startServer();
    const api = new Api();
    await api.login('admin', 'admin123');
    const me = await api.get('/auth/me');
    const r = await api.put(`/users/${me.body.user.id}`, { fullName: 'Pharmacy Owner Renamed', email: 'o@example.com', phone: '0300' });
    expect(r.status).toBe(200);
    expect(one<{ full_name: string }>(await openReadOnly(srv.dbFile), "SELECT full_name FROM users WHERE username='admin'")!.full_name).toBe('Pharmacy Owner Renamed');
    const workDir = srv.workDir;
    await srv.stop();
    srv = await startServer({ workDir });
    try {
      const db = await openReadOnly(srv.dbFile);
      expect(one<{ full_name: string }>(db, "SELECT full_name FROM users WHERE username='admin'")!.full_name).toBe('Muhammad Asghar (Owner)');
    } finally {
      await srv.stop();
    }
  });
});

describe('startup with a corrupt database file', () => {
  // Phase 3 fix of R10 (was: renamed the file and silently started a fresh demo database)
  it('[FIXED R10] refuses to start, exits with an explanation, and leaves the damaged file untouched', async () => {
    const { makeTempDir } = await import('../helpers/server');
    const crypto = await import('node:crypto');
    const workDir = makeTempDir();
    const seed = `${makeTempDir()}/bad.sqlite`;
    fs.writeFileSync(seed, Buffer.from('this is not a sqlite database at all'.repeat(200)));
    const before = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    await expect(startServer({ workDir, seedDb: seed })).rejects.toThrow(/exited early with code 1[\s\S]*STARTUP STOPPED[\s\S]*failed its integrity check and was NOT opened or modified/);
    const files = fs.readdirSync(`${workDir}/data`);
    expect(files).toEqual(['khushi_pharmacy.sqlite']);
    expect(crypto.createHash('sha256').update(fs.readFileSync(`${workDir}/data/khushi_pharmacy.sqlite`)).digest('hex')).toBe(before);
  });
});
