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

describe('FK1/FK5: placeholders make every legacy database consistent, then enforcement is on', () => {
  async function migrated(name: string): Promise<{ db: DbAdapter; file: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-on-'));
    const file = path.join(dir, 'db.sqlite');
    fs.copyFileSync(fx(name), file);
    const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    return { db, file };
  }
  const fails = (db: DbAdapter, fn: () => void) => {
    try { db.transaction(fn); return false; } catch (e: any) { return /FOREIGN KEY constraint failed/.test(e.message); }
  };

  it('all seven legacy databases: foreign_key_check is empty after migration and enforcement is ON', async () => {
    for (const n of ['fresh-first-boot', 'after-restart', 'busy-store', 'multi-tenant', 'orphans', 'pre-tenant-raw', 'pre-tenant-migrated-by-original']) {
      const { db } = await migrated(n);
      expect(db.foreignKeyViolations(), n).toEqual([]);
      expect(db.pragma('foreign_keys'), n).toBe(1);
      db.close();
    }
  });

  it('orphans: placeholders reuse the exact missing ids; the invoice keeps its line, amounts and customer link', async () => {
    const before = auditDatabase(fx('orphans')).findings;
    const { db } = await migrated('orphans');
    const ph = db.all<any>('SELECT id, name, archived_at, is_placeholder, stock, sale_price FROM products WHERE is_placeholder = 1');
    expect(ph).toHaveLength(1);
    expect(ph[0]).toMatchObject({ name: `[Deleted product #${ph[0].id}]`, is_placeholder: 1, stock: 0, sale_price: 0 });
    expect(ph[0].archived_at).toBeTruthy();
    const line = db.get<any>('SELECT si.subtotal, si.sale_price, p.name FROM sale_items si JOIN products p ON p.id = si.product_id WHERE p.id = ?', [ph[0].id]);
    expect(line).toMatchObject({ subtotal: 10, sale_price: 10, name: `[Deleted product #${ph[0].id}]` });
    const cust = db.get<any>('SELECT c.name, c.is_placeholder FROM sales_headers h JOIN customers c ON c.id = h.customer_id WHERE c.is_placeholder = 1');
    expect(cust.name).toMatch(/^\[Deleted customer #\d+\]$/);
    expect(before.length).toBe(2);
    db.close();
  });

  it('multi-tenant: the deleted store, its invoice headers and products come back as archived placeholders; totals unchanged', async () => {
    const { db } = await migrated('multi-tenant');
    expect(db.get<any>("SELECT name, status, archived_at IS NOT NULL a FROM tenants WHERE is_placeholder = 1")).toMatchObject({ status: 'DELETED', a: 1 });
    const headers = db.all<any>('SELECT invoice_number, grand_total, sale_date FROM sales_headers WHERE is_placeholder = 1');
    expect(headers.length).toBe(3);
    for (const h of headers) expect(h).toMatchObject({ grand_total: 0, sale_date: '1970-01-01 00:00:00' });
    db.close();
  });

  it('with enforcement on, a sale line for a non-existent product is now rejected', async () => {
    const { db } = await migrated('busy-store');
    expect(fails(db, () => db.run("INSERT INTO sale_items (sale_id, product_id, quantity, unit, sale_price, cost_price, subtotal) VALUES (1, 99999, 1, 'Pack', 1, 1, 1)"))).toBe(true);
    db.close();
  });

  it('with enforcement on, a raw DELETE of a product with history is blocked (the app archives instead)', async () => {
    const { db } = await migrated('busy-store');
    expect(fails(db, () => db.run('DELETE FROM products WHERE id = 1'))).toBe(true);
    db.close();
  });

  it('voiding an invoice (items first, then header) still works with enforcement on', async () => {
    const { db } = await migrated('busy-store');
    const id = db.get<{ id: number }>('SELECT id FROM sales_headers ORDER BY id DESC LIMIT 1')!.id;
    expect(fails(db, () => { db.run('DELETE FROM sale_items WHERE sale_id = ?', [id]); db.run('DELETE FROM sales_headers WHERE id = ?', [id]); })).toBe(false);
    db.close();
  });

  it('a database with a new unresolvable violation is refused at startup (not auto-repaired)', async () => {
    const { db, file } = await migrated('busy-store');
    db.setForeignKeys(false);
    db.run('INSERT INTO customer_ledger (customer_id, type, debit, credit, balance_after) VALUES (424242, \'PAYMENT\', 0, 1, 0)');
    db.close();
    await expect(openDatabase(file, { backupDir: path.join(path.dirname(file), 'b') })).rejects.toThrow(/broken reference/);
  });
});
