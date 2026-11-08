/**
 * Foreign-key audit facts and the impact of switching enforcement on.
 * Everything runs on temporary copies of the generated legacy fixtures.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureFixtures } from '../legacy/generate-fixtures';
import { PROJECT_ROOT } from '../helpers/server';
import { auditDatabase } from '../../scripts/fk-audit';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase } from '../../server/db/open';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const fx = (n: string) => path.join(FIXTURE_DIR, `${n}.sqlite`);
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

beforeAll(async () => { await ensureFixtures(FIXTURE_DIR); }, 600_000);

describe('fk-audit script', () => {
  it('is read-only: the audited file is byte-identical afterwards', () => {
    const before = sha(fx('orphans'));
    auditDatabase(fx('orphans'));
    expect(sha(fx('orphans'))).toBe(before);
  });

  it('clean fixtures have no orphaned references', () => {
    for (const n of ['fresh-first-boot', 'after-restart', 'busy-store', 'pre-tenant-raw', 'pre-tenant-migrated-by-original']) {
      expect(auditDatabase(fx(n)).findings, n).toEqual([]);
    }
  });

  it('orphans fixture: deleted product and deleted customer left dangling references', () => {
    const f = auditDatabase(fx('orphans')).findings.map((x) => `${x.table}.${x.column}->${x.parent}:${x.orphanRows}`).sort();
    expect(f).toEqual(['sale_items.product_id->products:1', 'sales_headers.customer_id->customers:1']);
  });

  it('multi-tenant fixture: deleting a store orphaned sale lines and audit rows', () => {
    const f = auditDatabase(fx('multi-tenant')).findings.map((x) => `${x.kind}:${x.table}.${x.column}->${x.parent}:${x.orphanRows}`).sort();
    expect(f).toEqual([
      'declared:sale_items.product_id->products:3',
      'declared:sale_items.sale_id->sales_headers:3',
      'undeclared:audit_logs.tenant_id->tenants:4',
    ]);
  });

  it('lists the relationships declared in the schema', () => {
    const decl = auditDatabase(fx('busy-store')).declaredForeignKeys.map((d) => `${d.table}.${d.column}->${d.parent}`);
    expect(decl).toEqual(expect.arrayContaining([
      'sale_items.sale_id->sales_headers', 'sale_items.product_id->products', 'sales_headers.customer_id->customers',
      'sales_headers.created_by_user_id->users', 'customer_ledger.customer_id->customers', 'purchase_items.product_id->products',
      'products.category_id->categories', 'products.supplier_id->suppliers', 'stock_adjustments.user_id->users',
    ]));
  });
});

describe('impact of enabling foreign_keys=ON today (why it stays OFF until approved fixes)', () => {
  async function migratedCopy(name: string): Promise<DbAdapter> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-on-'));
    const file = path.join(dir, 'db.sqlite');
    fs.copyFileSync(fx(name), file);
    (await openDatabase(file, { backupDir: path.join(dir, 'b') })).db.close();
    return DbAdapter.open(file, { foreignKeys: true });
  }
  const fails = (db: DbAdapter, fn: () => void) => {
    try { db.transaction(fn); return false; } catch (e: any) { return /FOREIGN KEY constraint failed/.test(e.message); }
  };

  it('app "delete product" (DELETE FROM products) fails for a product with sales history', async () => {
    const db = await migratedCopy('busy-store');
    expect(fails(db, () => db.run('DELETE FROM products WHERE id = 1'))).toBe(true);
    db.close();
  });

  it('app "delete customer" (ledger/queues/users then customer) fails while their invoices exist', async () => {
    const db = await migratedCopy('busy-store');
    const c = db.get<{ customer_id: number }>('SELECT customer_id FROM sales_headers WHERE customer_id IS NOT NULL LIMIT 1')!.customer_id;
    expect(fails(db, () => {
      for (const sql of ['DELETE FROM customer_ledger WHERE customer_id = ?', 'DELETE FROM email_queue WHERE customer_id = ?', 'DELETE FROM sms_queue WHERE customer_id = ?', 'DELETE FROM users WHERE customer_id = ?', 'DELETE FROM customers WHERE id = ?']) db.run(sql, [c]);
    })).toBe(true);
    db.close();
  });

  it('app "delete user" fails for a user who created sales', async () => {
    const db = await migratedCopy('busy-store');
    expect(fails(db, () => db.run("DELETE FROM users WHERE username = 'admin'"))).toBe(true);
    db.close();
  });

  it('app "void invoice" (items first, then header) still works with enforcement on', async () => {
    const db = await migratedCopy('busy-store');
    const id = db.get<{ id: number }>('SELECT id FROM sales_headers ORDER BY id DESC LIMIT 1')!.id;
    expect(fails(db, () => { db.run('DELETE FROM sale_items WHERE sale_id = ?', [id]); db.run('DELETE FROM sales_headers WHERE id = ?', [id]); })).toBe(false);
    db.close();
  });

  it('a sale for a non-existent product is rejected with enforcement on (it is accepted today)', async () => {
    const db = await migratedCopy('busy-store');
    expect(fails(db, () => db.run("INSERT INTO sale_items (sale_id, product_id, quantity, unit, sale_price, cost_price, subtotal) VALUES (1, 99999, 1, 'Pack', 1, 1, 1)"))).toBe(true);
    db.close();
  });

  it('existing orphans do not block opening or reading, but foreign_key_check reports them', async () => {
    const db = await migratedCopy('orphans');
    expect(db.all('PRAGMA foreign_key_check').length).toBe(2);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sale_items')!.n).toBeGreaterThan(0);
    db.close();
  });
});
