/**
 * Migration 0007 (batch inventory) on copies of databases made by the ORIGINAL application.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureFixtures, FixtureManifestEntry } from '../legacy/generate-fixtures';
import { PROJECT_ROOT, startServer } from '../helpers/server';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase } from '../../server/db/open';
import { migrate, currentVersion, Migration } from '../../server/db/migrate';
import { MIGRATIONS } from '../../server/db/migrations';
import { batchInventory, STOCK_GUARD_MESSAGE } from '../../server/db/migrations/0007_batch_inventory';
import { inventoryInvariantIssues } from '../../server/inventory/batches';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
let manifest: Record<string, FixtureManifestEntry>;
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function copy(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  const file = path.join(dir, 'data', 'pharmacy.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, `${name}.sqlite`), file);
  return { dir, file };
}
function legacyProducts(name: string) {
  const ro = DbAdapter.open(path.join(FIXTURE_DIR, `${name}.sqlite`), { readonly: true });
  const rows = ro.all<{ id: number; stock: number; batch_number: string; expiry_date: string; purchase_price: number; sale_price: number }>('SELECT id, stock, batch_number, expiry_date, purchase_price, sale_price FROM products');
  const history = { sale_items: ro.rowCounts().sale_items, purchase_items: ro.rowCounts().purchase_items ?? 0, stock_adjustments: ro.rowCounts().stock_adjustments ?? 0 };
  const items = ro.all('SELECT * FROM sale_items ORDER BY id');
  ro.close();
  return { rows, history, items };
}

beforeAll(async () => { manifest = await ensureFixtures(FIXTURE_DIR); }, 600_000);

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const CLEAN = ['fresh-first-boot', 'after-restart', 'busy-store', 'multi-tenant', 'orphans', 'pre-tenant-raw', 'pre-tenant-migrated-by-original'];

describe('0007 on every legacy database (copies; originals untouched)', () => {
  for (const name of CLEAN) {
    it(`${name}: one MIGRATION batch per product with stock; every product's stock and all history unchanged`, async () => {
      const before = legacyProducts(name);
      const originalSha = sha(path.join(FIXTURE_DIR, `${name}.sqlite`));
      const { dir, file } = copy(name);
      const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
      try {
        expect(currentVersion(db)).toBe(LATEST);
        for (const p of before.rows) {
          const now = db.get<{ stock: number }>('SELECT stock FROM products WHERE id = ?', [p.id])!;
          expect(now.stock, `product ${p.id}`).toBe(p.stock);
          const batches = db.all<any>('SELECT * FROM product_batches WHERE product_id = ?', [p.id]);
          if (p.stock > 0) {
            expect(batches).toHaveLength(1);
            expect(batches[0]).toMatchObject({ source: 'MIGRATION', qty_on_hand: p.stock, qty_received: p.stock, batch_number: p.batch_number || null, purchase_price: p.purchase_price, sale_price: p.sale_price, expiry_raw: p.expiry_date });
          } else {
            expect(batches).toHaveLength(0);
          }
        }
        expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sale_items')!.n).toBe(before.history.sale_items);
        expect(db.all('SELECT id, sale_id, product_id, quantity, sale_price, cost_price, batch_number, expiry_date, subtotal FROM sale_items ORDER BY id'))
          .toEqual(before.items.map((i: any) => ({ id: i.id, sale_id: i.sale_id, product_id: i.product_id, quantity: i.quantity, sale_price: i.sale_price, cost_price: i.cost_price, batch_number: i.batch_number, expiry_date: i.expiry_date, subtotal: i.subtotal })));
        expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sale_item_batches')!.n).toBe(0); // history is not re-allocated
        expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM inventory_migration_issues')!.n).toBe(0);
        expect(inventoryInvariantIssues(db)).toEqual([]);
        expect(db.foreignKeyViolations()).toEqual([]);
        expect(db.pragma('foreign_keys')).toBe(1);
      } finally {
        db.close();
      }
      expect(sha(path.join(FIXTURE_DIR, `${name}.sqlite`))).toBe(originalSha);
    });
  }
});

describe('0007 on the edge-case database (negative, fractional stock; odd expiry text)', () => {
  it('converts what it can, records every deviation, never guesses ambiguous dates', async () => {
    const { dir, file } = copy('inventory-edge-cases');
    const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    try {
      const stock = (id: number) => db.get<{ stock: number }>('SELECT stock FROM products WHERE id = ?', [id])!.stock;
      const batch = (id: number) => db.get<any>('SELECT expiry_date, expiry_raw, qty_on_hand FROM product_batches WHERE product_id = ?', [id]);
      // D4: negative -> 0, old value recorded
      expect(stock(1)).toBe(0);
      expect(batch(1)).toBeUndefined();
      // month/year -> last day of month
      expect(batch(2)).toEqual({ expiry_date: '2027-12-31', expiry_raw: '12/2027', qty_on_hand: 7 });
      // ambiguous -> no expiry, raw text kept
      expect(batch(3)).toEqual({ expiry_date: null, expiry_raw: '05/10/2027', qty_on_hand: 5 });
      // blank expiry -> no expiry (D5), not an issue
      expect(batch(4)).toEqual({ expiry_date: null, expiry_raw: '', qty_on_hand: 9 });
      // fractional -> whole units
      expect(stock(5)).toBe(2);
      expect(batch(7)).toMatchObject({ expiry_date: '2027-10-31', expiry_raw: '2027-10' });
      const issues = db.all<any>('SELECT product_id, issue, old_value, new_value FROM inventory_migration_issues ORDER BY product_id, issue');
      expect(issues).toEqual([
        { product_id: 1, issue: 'NEGATIVE_STOCK', old_value: '-3', new_value: '0' },
        { product_id: 3, issue: 'EXPIRY_UNRECOGNIZED', old_value: '05/10/2027', new_value: null },
        { product_id: 5, issue: 'NON_INTEGER_STOCK', old_value: '2.5', new_value: '2' },
      ]);
      // D4: stock-value changes are also in the audit log (expiry text problems only in the issues table)
      expect(db.all<any>("SELECT target_id, description FROM audit_logs WHERE action_type = 'INVENTORY_MIGRATION_ISSUE' ORDER BY target_id")).toEqual([
        { target_id: 1, description: expect.stringMatching(/^NEGATIVE_STOCK: product #1 stock -3 -> 0/) },
        { target_id: 5, description: expect.stringMatching(/^NON_INTEGER_STOCK: product #5 stock 2.5 -> 2/) },
      ]);
      // everything else unchanged; the historical sale untouched
      const before = legacyProducts('inventory-edge-cases');
      for (const p of before.rows.filter((r) => ![1, 5].includes(r.id))) expect(stock(p.id), `product ${p.id}`).toBe(p.stock);
      expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sale_items')!.n).toBe(before.history.sale_items);
      expect(inventoryInvariantIssues(db)).toEqual([]);
      expect(db.foreignKeyViolations()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('database-level stock protection after 0007', () => {
  async function migrated() {
    const { dir, file } = copy('busy-store');
    return { dir, ...(await openDatabase(file, { backupDir: path.join(dir, 'b') })) };
  }
  it('a direct write of products.stock that disagrees with the batches is refused', async () => {
    const { db } = await migrated();
    expect(() => db.run('UPDATE products SET stock = 999 WHERE id = 1')).toThrow(STOCK_GUARD_MESSAGE);
    expect(() => db.run('UPDATE products SET stock = stock - 1 WHERE id = 1')).toThrow(STOCK_GUARD_MESSAGE);
    db.close();
  });
  it('a product cannot be created with stock; stock comes only from batches', async () => {
    const { db } = await migrated();
    expect(() => db.run("INSERT INTO products (name, unit, purchase_price, sale_price, stock) VALUES ('X', 'Pack', 1, 2, 5)")).toThrow(STOCK_GUARD_MESSAGE);
    const id = db.run("INSERT INTO products (name, unit, purchase_price, sale_price, stock) VALUES ('X', 'Pack', 1, 2, 0)").lastInsertRowid;
    db.run("INSERT INTO product_batches (product_id, qty_received, qty_on_hand, source) VALUES (?, 4, 4, 'OPENING')", [id]);
    expect(db.get<any>('SELECT stock FROM products WHERE id = ?', [id]).stock).toBe(4);
    db.close();
  });
  it('a batch can never go below zero (CHECK constraint)', async () => {
    const { db } = await migrated();
    const b = db.get<{ id: number; qty_on_hand: number }>('SELECT id, qty_on_hand FROM product_batches LIMIT 1')!;
    expect(() => db.run('UPDATE product_batches SET qty_on_hand = -1 WHERE id = ?', [b.id])).toThrow(/CHECK constraint failed/);
    expect(db.get<any>('SELECT qty_on_hand FROM product_batches WHERE id = ?', [b.id]).qty_on_hand).toBe(b.qty_on_hand);
    db.close();
  });
  it('stock follows batch changes automatically (insert, update, delete)', async () => {
    const { db } = await migrated();
    const p = db.get<{ id: number; stock: number }>('SELECT id, stock FROM products WHERE stock > 0 LIMIT 1')!;
    const nb = db.run("INSERT INTO product_batches (product_id, qty_received, qty_on_hand, source) VALUES (?, 10, 10, 'PURCHASE')", [p.id]).lastInsertRowid;
    expect(db.get<any>('SELECT stock FROM products WHERE id = ?', [p.id]).stock).toBe(p.stock + 10);
    db.run('UPDATE product_batches SET qty_on_hand = 3 WHERE id = ?', [nb]);
    expect(db.get<any>('SELECT stock FROM products WHERE id = ?', [p.id]).stock).toBe(p.stock + 3);
    db.run('DELETE FROM product_batches WHERE id = ?', [nb]);
    expect(db.get<any>('SELECT stock FROM products WHERE id = ?', [p.id]).stock).toBe(p.stock);
    db.close();
  });
});

describe('0007 failure and crash recovery', () => {
  it('a failure at the end of 0007 rolls back everything; the real migration then succeeds', async () => {
    const { dir, file } = copy('busy-store');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS.filter((m) => m.version < 7), { backupDir: path.join(dir, 'b') });
    const stockBefore = db.all('SELECT id, stock FROM products ORDER BY id');
    const broken: Migration = { ...batchInventory, up: (d) => { batchInventory.up(d); throw new Error('injected failure after moving all stock'); } };
    await expect(migrate(db, [...MIGRATIONS.filter((m) => m.version < 7), broken], { backupDir: path.join(dir, 'b') })).rejects.toThrow(/injected failure/);
    expect(currentVersion(db)).toBe(6);
    expect(db.tableNames()).not.toContain('product_batches');
    expect(db.all('SELECT id, stock FROM products ORDER BY id')).toEqual(stockBefore);
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    expect(currentVersion(db)).toBe(LATEST);
    expect(db.all('SELECT id, stock FROM products ORDER BY id')).toEqual(stockBefore);
    db.close();
  });

  it('the server process is killed inside the 0007 transaction; the next start migrates cleanly from the untouched data', async () => {
    const { dir, file } = copy('busy-store');
    const before = legacyProducts('busy-store');
    // the server uses <workDir>/data/khushi_pharmacy.sqlite
    fs.renameSync(file, path.join(dir, 'data', 'khushi_pharmacy.sqlite'));
    await expect(startServer({ workDir: dir, env: { PHARMACY_TEST_CRASH_MIGRATION: '7' } })).rejects.toThrow(/exited early/);
    const mid = DbAdapter.open(path.join(dir, 'data', 'khushi_pharmacy.sqlite'), { readonly: true });
    // migrations 1-6 each committed on their own; 0007 was killed before COMMIT and left no trace
    expect(currentVersion(mid)).toBe(6);
    expect(mid.tableNames()).not.toContain('product_batches');
    for (const p of before.rows) expect(mid.get<any>('SELECT stock FROM products WHERE id = ?', [p.id]).stock).toBe(p.stock);
    mid.close();
    expect(fs.readdirSync(path.join(dir, 'data', 'backups')).some((f) => f.startsWith(`pre-migration-v0-to-v${LATEST}`))).toBe(true);
    const srv = await startServer({ workDir: dir });
    try {
      const db = DbAdapter.open(srv.dbFile, { readonly: true });
      expect(currentVersion(db)).toBe(LATEST);
      for (const p of before.rows) expect(db.get<any>('SELECT stock FROM products WHERE id = ?', [p.id]).stock).toBe(p.stock);
      expect(inventoryInvariantIssues(db)).toEqual([]);
      db.close();
    } finally {
      await srv.stop();
    }
  }, 120_000);
});
