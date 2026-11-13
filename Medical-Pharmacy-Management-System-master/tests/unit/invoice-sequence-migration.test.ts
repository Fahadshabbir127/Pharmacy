/**
 * Migration 0011 (invoice number sequences, Phase 7 Batch 2e, fix of R4) on copies of databases made by the
 * ORIGINAL application. Existing invoice numbers and financial records stay exactly as they were; each store's
 * sequence starts after every number found anywhere; rollback and crash recovery leave the database untouched.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureFixtures } from '../legacy/generate-fixtures';
import { PROJECT_ROOT, startServer } from '../helpers/server';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase } from '../../server/db/open';
import { migrate, currentVersion, Migration } from '../../server/db/migrate';
import { MIGRATIONS } from '../../server/db/migrations';
import { invoiceSequences } from '../../server/db/migrations/0011_invoice_sequences';
import { takeInvoiceNumber } from '../../server/sales/invoiceNumbers';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const ALL = ['fresh-first-boot', 'after-restart', 'busy-store', 'multi-tenant', 'orphans', 'pre-tenant-raw', 'pre-tenant-migrated-by-original', 'inventory-edge-cases', 'payments-edge-cases'];
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function copy(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const file = path.join(dir, 'data', 'pharmacy.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, `${name}.sqlite`), file);
  return { dir, file };
}
const SALE_COLS = 'id, invoice_number, customer_id, sale_date, total_amount, discount_amount, net_amount, total_gst, grand_total, payment_method, amount_paid, amount_due, payment_status';
function legacyRecords(file: string) {
  const ro = DbAdapter.open(file, { readonly: true });
  try {
    return { sales: ro.all(`SELECT ${SALE_COLS} FROM sales_headers ORDER BY id`), customers: ro.all('SELECT id, current_balance FROM customers ORDER BY id') };
  } finally { ro.close(); }
}
/** every invoice number (both forms) mentioned anywhere, per store; an independent re-scan for the test */
function numbersMentioned(db: DbAdapter) {
  const seen: { tenant: number; n: number }[] = [];
  const add = (text: any, tenant: number | null) => {
    for (const m of String(text ?? '').matchAll(/INV-(\d+)-(\d+)/g)) seen.push({ tenant: Number(m[1]), n: Number(m[2]) });
    for (const m of String(text ?? '').matchAll(/INV-(\d{4,})(?![-\d])/g)) seen.push({ tenant: tenant ?? 1, n: Number(m[1]) });
  };
  for (const r of db.all<any>('SELECT invoice_number t, tenant_id FROM sales_headers')) add(r.t, r.tenant_id);
  for (const r of db.all<any>('SELECT invoice_number t, tenant_id FROM payments')) add(r.t, r.tenant_id);
  for (const r of db.all<any>('SELECT l.reference t, c.tenant_id FROM customer_ledger l LEFT JOIN customers c ON c.id = l.customer_id')) add(r.t, r.tenant_id);
  for (const r of db.all<any>("SELECT description t, tenant_id FROM audit_logs WHERE action_type <> 'INVOICE_SEQUENCE_INIT'")) add(r.t, r.tenant_id);
  return seen;
}

beforeAll(async () => { await ensureFixtures(FIXTURE_DIR); }, 600_000);

describe('0011 on every legacy database (copies; originals untouched)', () => {
  for (const name of ALL) {
    it(`${name}: no invoice or financial record changes; every store's next number is above every number already used`, async () => {
      const original = path.join(FIXTURE_DIR, `${name}.sqlite`);
      const originalSha = sha(original);
      const before = legacyRecords(original);
      const { dir, file } = copy(name);
      const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
      try {
        expect(currentVersion(db)).toBe(LATEST);
        expect(db.all(`SELECT ${SALE_COLS} FROM sales_headers WHERE is_placeholder = 0 ORDER BY id`)).toEqual(before.sales);
        expect(db.all('SELECT id, current_balance FROM customers WHERE is_placeholder = 0 ORDER BY id')).toEqual(before.customers);
        const seq = new Map(db.all<any>('SELECT tenant_id, next_value FROM invoice_sequences').map((r) => [r.tenant_id, r.next_value]));
        // every store that has sales has a sequence, never lower than the old formula
        // (rows of the oldest, pre-store schema have no tenant: they belong to store 1; placeholders are deleted invoices)
        for (const r of db.all<any>('SELECT COALESCE(tenant_id, 1) t, COUNT(*) n FROM sales_headers WHERE is_placeholder = 0 GROUP BY COALESCE(tenant_id, 1)')) {
          expect(seq.get(r.t), `store ${r.t}`).toBeGreaterThanOrEqual(1001 + r.n);
        }
        // above every number mentioned anywhere (including deleted invoices still named in ledger / audit texts)
        for (const { tenant, n } of numbersMentioned(db)) expect(seq.get(tenant), `store ${tenant} INV ${n}`).toBeGreaterThan(n);
        // the next numbers taken are all new
        const existing = new Set(db.all<any>('SELECT invoice_number FROM sales_headers').map((r) => r.invoice_number));
        db.transaction(() => {
          for (const t of seq.keys()) for (let i = 0; i < 3; i++) {
            const num = `INV-${t}-${takeInvoiceNumber(db, t)}`;
            expect(existing.has(num)).toBe(false);
            existing.add(num);
          }
        });
        // reported once in the audit log
        expect(db.get<any>("SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'INVOICE_SEQUENCE_INIT'").n).toBe(seq.size ? 1 : 0);
        expect(db.integrityCheck()).toEqual([]);
        expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
      expect(sha(original)).toBe(originalSha);
    });
  }

  it('payments-edge-cases (the original app had re-issued INV-1-1004 after a void): numbering continues at 1007', async () => {
    const { dir, file } = copy('payments-edge-cases');
    const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    try {
      expect(db.all('SELECT tenant_id, next_value FROM invoice_sequences')).toEqual([{ tenant_id: 1, next_value: 1007 }]);
      expect(db.get<any>("SELECT description FROM audit_logs WHERE action_type = 'INVOICE_SEQUENCE_INIT'").description).toMatch(/store 1: next INV-1-1007/);
    } finally { db.close(); }
  });

  it('multi-tenant: one sequence per store, each continuing its own numbers', async () => {
    const { dir, file } = copy('multi-tenant');
    const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    try {
      const rows = db.all<any>('SELECT tenant_id, next_value FROM invoice_sequences ORDER BY tenant_id');
      // store 3's invoices INV-3-1001..1003 were deleted by the original app (only the audit log still names them):
      // their numbers are not issued again
      expect(rows).toEqual([{ tenant_id: 1, next_value: 1002 }, { tenant_id: 2, next_value: 1004 }, { tenant_id: 3, next_value: 1004 }]);
      for (const r of rows) {
        const own = db.all<any>('SELECT invoice_number FROM sales_headers WHERE tenant_id = ?', [r.tenant_id]).map((s) => Number(String(s.invoice_number).split('-').pop()));
        if (own.length) expect(r.next_value).toBeGreaterThan(Math.max(...own));
      }
    } finally { db.close(); }
  });
});

describe('0011 rollback, crash recovery and verified backup', () => {
  const state = (db: DbAdapter) => ({
    sales: db.all(`SELECT ${SALE_COLS}, balance_due, settlement_status FROM sales_headers ORDER BY id`),
    payments: db.all('SELECT * FROM payments ORDER BY id'),
    ledger: db.all('SELECT * FROM customer_ledger ORDER BY id'),
    customers: db.all('SELECT id, current_balance FROM customers ORDER BY id'),
    audit: db.get<any>('SELECT COUNT(*) n FROM audit_logs').n,
  });
  const triggerSql = (db: DbAdapter) => db.all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
  async function atV10() {
    const { dir, file } = copy('payments-edge-cases');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS.filter((m) => m.version <= 10), { backupDir: path.join(dir, 'b0') });
    return { dir, file, db };
  }

  it('a failure at the end of 0011 rolls everything back (table, triggers, audit row); the real migration then succeeds', async () => {
    const { dir, db } = await atV10();
    const before = state(db);
    const triggers = triggerSql(db);
    const tables = db.tableNames();
    const broken: Migration = { ...invoiceSequences, up: (d) => { invoiceSequences.up(d); throw new Error('injected failure at the end of 11'); } };
    await expect(migrate(db, [...MIGRATIONS.filter((m) => m.version < 11), broken], { backupDir: path.join(dir, 'b1') })).rejects.toThrow(/injected failure/);
    expect(currentVersion(db)).toBe(10);
    expect(db.tableNames()).toEqual(tables);
    expect(db.tableNames()).not.toContain('invoice_sequences');
    expect(triggerSql(db)).toEqual(triggers);
    expect(state(db)).toEqual(before);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b2') });
    expect(currentVersion(db)).toBe(LATEST);
    expect({ ...state(db), audit: 0 }).toEqual({ ...before, audit: 0 });
    expect(db.get<any>('SELECT next_value FROM invoice_sequences WHERE tenant_id = 1').next_value).toBe(1007);
    db.close();
  });

  it('the server is killed inside the 0011 transaction: nothing changes, a verified backup of v10 exists, the next start migrates cleanly and sells INV-1-1007', async () => {
    const { dir, file, db } = await atV10();
    const before = state(db);
    db.close();
    const dataDir = path.join(dir, 'data');
    fs.renameSync(file, path.join(dataDir, 'khushi_pharmacy.sqlite'));
    await expect(startServer({ workDir: dir, env: { PHARMACY_TEST_CRASH_MIGRATION: '11' } })).rejects.toThrow(/exited early/);
    const mid = DbAdapter.open(path.join(dataDir, 'khushi_pharmacy.sqlite'), { readonly: true });
    expect(currentVersion(mid)).toBe(10);
    expect(mid.tableNames()).not.toContain('invoice_sequences');
    expect(state(mid)).toEqual(before);
    mid.close();
    const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.startsWith(`pre-migration-v10-to-v${LATEST}`) && f.endsWith('.sqlite'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const bk = DbAdapter.open(path.join(dataDir, 'backups', backups[0]), { readonly: true });
    expect(bk.integrityCheck()).toEqual([]);
    expect(currentVersion(bk)).toBe(10);
    expect(state(bk)).toEqual(before);
    bk.close();
    const srv = await startServer({ workDir: dir });
    try {
      const after = DbAdapter.open(srv.dbFile, { readonly: true });
      expect(currentVersion(after)).toBe(LATEST);
      expect(after.get<any>('SELECT next_value FROM invoice_sequences WHERE tenant_id = 1').next_value).toBe(1007);
      after.close();
      const { Api, cartItem, salePayload } = await import('../helpers/server');
      const admin = new Api();
      await admin.login('admin', 'admin123');
      const p = (await admin.get('/inventory')).body.find((x: any) => x.sellable_stock > 0);
      const sale = await admin.post('/sales', salePayload([cartItem(p, 1)]));
      expect(sale.status, JSON.stringify(sale.body)).toBe(200);
      expect(sale.body.invoice_number).toBe('INV-1-1007');
    } finally {
      await srv.stop();
    }
  }, 120_000);
});
