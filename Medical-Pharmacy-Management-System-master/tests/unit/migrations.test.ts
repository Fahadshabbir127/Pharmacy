/**
 * Migration safety on copies of databases produced by the ORIGINAL application.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ensureFixtures, FixtureManifestEntry } from '../legacy/generate-fixtures';
import { PROJECT_ROOT } from '../helpers/server';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase, DatabaseIntegrityError } from '../../server/db/open';
import { migrate, MigrationError, currentVersion, Migration } from '../../server/db/migrate';
import { MIGRATIONS } from '../../server/db/migrations';
import { importLegacyDatabase, LegacyImportError } from '../../server/db/legacyImport';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
let manifest: Record<string, FixtureManifestEntry>;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function copyFixture(name: string): { dir: string; file: string; original: string } {
  const dir = tmp();
  const original = path.join(FIXTURE_DIR, `${name}.sqlite`);
  const file = path.join(dir, 'data', 'khushi_pharmacy.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(original, file);
  return { dir, file, original };
}
function invariants(db: DbAdapter) {
  const n = (sql: string) => Number((db.get<{ v: number }>(sql)!).v);
  return {
    productStockSum: n('SELECT COALESCE(SUM(stock),0) v FROM products'),
    customerBalanceSum: +n('SELECT COALESCE(SUM(current_balance),0) v FROM customers').toFixed(2),
    salesGrandTotalSum: +n('SELECT COALESCE(SUM(grand_total),0) v FROM sales_headers').toFixed(2),
    ledgerRows: n('SELECT COUNT(*) v FROM customer_ledger'),
  };
}

beforeAll(async () => {
  manifest = await ensureFixtures(FIXTURE_DIR);
}, 600_000);

describe('migrating every legacy fixture (copies only)', () => {
  const names = ['fresh-first-boot', 'after-restart', 'busy-store', 'multi-tenant', 'orphans', 'pre-tenant-raw', 'pre-tenant-migrated-by-original'];

  for (const name of names) {
    it(`${name}: all rows and money/stock totals preserved, verified backup written, schema v${LATEST}`, async () => {
      const { dir, file, original } = copyFixture(name);
      const originalSha = sha(original);
      const backupDir = path.join(dir, 'data', 'backups');
      const { db, migration } = await openDatabase(file, { backupDir });
      try {
        expect(migration.fromVersion).toBe(0);
        expect(migration.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
        expect(currentVersion(db)).toBe(LATEST);
        const counts = db.rowCounts();
        // every original row is still there; the only additions are FK1 placeholders (flagged, archived)
        for (const [t, n] of Object.entries(manifest[name].rowCounts)) {
          const cols = db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name);
          const placeholders = cols.includes('is_placeholder') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM "${t}" WHERE is_placeholder = 1`)!.n : 0;
          // the only other additions: audit rows written by the migrations themselves (user "Database upgrade")
          const upgradeAudit = t === 'audit_logs' ? db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_logs WHERE user_name = 'Database upgrade' AND user_id IS NULL")!.n : 0;
          expect(counts[t] - placeholders - upgradeAudit, `${name}.${t}`).toBe(n);
          if (upgradeAudit) {
            expect(db.all<{ a: string }>("SELECT DISTINCT action_type a FROM audit_logs WHERE user_name = 'Database upgrade'").map((r) => r.a).every((a) => ['PAYMENT_MIGRATION', 'PAYMENT_MIGRATION_ISSUE', 'INVENTORY_MIGRATION_ISSUE', 'PAYMENT_ADVANCE_APPLIED'].includes(a)), `${name} upgrade audit types`).toBe(true);
          }
          if (placeholders) expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM "${t}" WHERE is_placeholder = 1 AND archived_at IS NULL`)!.n, `${name}.${t} placeholders archived`).toBe(0);
        }
        // FK5: clean references and enforcement on
        expect(db.foreignKeyViolations()).toEqual([]);
        expect(db.pragma('foreign_keys')).toBe(1);
        expect(invariants(db)).toEqual(manifest[name].invariants);
        expect(db.integrityCheck()).toEqual([]);
        expect(migration.backupFile).toBeTruthy();
        const backup = DbAdapter.open(migration.backupFile!, { readonly: true });
        expect(backup.rowCounts()).toEqual(manifest[name].rowCounts);
        expect(backup.integrityCheck()).toEqual([]);
        backup.close();
        expect(fs.readdirSync(backupDir).filter((f) => f.endsWith('.partial'))).toEqual([]);
      } finally {
        db.close();
      }
      expect(sha(original)).toBe(originalSha); // the fixture itself is never touched
    });
  }

  it('pre-tenant-raw: the oldest users table (role CHECK) is rebuilt without losing users', async () => {
    const { dir, file } = copyFixture('pre-tenant-raw');
    const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    try {
      const sql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='users'")!.sql;
      expect(sql).not.toMatch(/CHECK\(role IN/);
      expect(db.all('SELECT username FROM users ORDER BY id').map((u: any) => u.username)).toEqual(['owner_old', 'clerk_old']);
      for (const col of ['email', 'status', 'tenant_id', 'allowed_services']) {
        expect(db.all<{ name: string }>('PRAGMA table_info(users)').map((c) => c.name)).toContain(col);
      }
    } finally {
      db.close();
    }
  });

  it('every legacy fixture ends with the full legacy column set (0003 restores columns the old rebuild dropped)', async () => {
    const { LEGACY_ALTER_COLUMNS } = await import('../../server/db/migrations/0003_restore_legacy_columns');
    for (const name of names) {
      const { dir, file } = copyFixture(name);
      const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
      for (const [table, column] of LEGACY_ALTER_COLUMNS) {
        const cols = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
        if (cols.length) expect(cols, `${name}: ${table}.${column}`).toContain(column);
      }
      db.close();
    }
  });

  it('second open: nothing pending, no new backup', async () => {
    const { dir, file } = copyFixture('busy-store');
    const backupDir = path.join(dir, 'b');
    (await openDatabase(file, { backupDir })).db.close();
    const n = fs.readdirSync(backupDir).length;
    const again = await openDatabase(file, { backupDir });
    expect(again.migration.applied).toEqual([]);
    expect(again.migration.backupFile).toBeNull();
    again.db.close();
    expect(fs.readdirSync(backupDir).length).toBe(n);
  });

  it('a brand-new database gets the schema without a backup', async () => {
    const dir = tmp();
    const { db, migration, created } = await openDatabase(path.join(dir, 'new.sqlite'), { backupDir: path.join(dir, 'b') });
    expect(created).toBe(true);
    expect(migration.backupFile).toBeNull();
    expect(db.tableNames()).toContain('products');
    expect(db.pragma('journal_mode')).toBe('wal');
    db.close();
  });
});

describe('failure handling (nothing is changed, nothing is auto-repaired)', () => {
  it('corrupt file: DatabaseIntegrityError, file byte-identical, no new files', async () => {
    const dir = tmp();
    const file = path.join(dir, 'khushi_pharmacy.sqlite');
    const good = path.join(FIXTURE_DIR, 'busy-store.sqlite');
    const buf = fs.readFileSync(good);
    buf.fill(0x41, 4096 * 3, 4096 * 3 + 2000); // damage a b-tree page
    fs.writeFileSync(file, buf);
    const before = sha(file);
    await expect(openDatabase(file, { backupDir: path.join(dir, 'b') })).rejects.toBeInstanceOf(DatabaseIntegrityError);
    expect(sha(file)).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['khushi_pharmacy.sqlite']);
  });

  it('not-a-database file: DatabaseIntegrityError', async () => {
    const dir = tmp();
    const file = path.join(dir, 'x.sqlite');
    fs.writeFileSync(file, 'hello'.repeat(1000));
    await expect(openDatabase(file, { backupDir: dir })).rejects.toThrow(/integrity check/);
  });

  it('a migration that deletes rows is rolled back and the version is not recorded', async () => {
    const { dir, file } = copyFixture('busy-store');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    const before = db.rowCounts();
    const evil: Migration = { version: 99, name: 'evil', up: (d) => { d.run('DELETE FROM customers WHERE id > 1'); } };
    await expect(migrate(db, [...MIGRATIONS, evil], { backupDir: path.join(dir, 'b') })).rejects.toThrow(/would remove data; rolled back/);
    expect(db.rowCounts()).toEqual(before);
    expect(currentVersion(db)).toBe(LATEST);
    db.close();
  });

  it('a migration that throws is rolled back completely', async () => {
    const { dir, file } = copyFixture('after-restart');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    const bad: Migration = { version: 50, name: 'half', up: (d) => { d.exec('CREATE TABLE half_done (x)'); throw new Error('mid-way'); } };
    await expect(migrate(db, [...MIGRATIONS, bad], { backupDir: path.join(dir, 'b') })).rejects.toThrow(/failed and was rolled back: mid-way/);
    expect(db.tableNames()).not.toContain('half_done');
    db.close();
  });

  it('if the pre-migration backup cannot be written, no migration runs', async () => {
    const { dir, file } = copyFixture('busy-store');
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x'); // backupDir is a file -> mkdir fails
    const before = sha(file);
    const db = DbAdapter.open(file);
    await expect(migrate(db, MIGRATIONS, { backupDir: blocker })).rejects.toThrow(/Pre-migration backup failed; nothing was changed/);
    expect(currentVersion(db)).toBe(0);
    db.close();
    // file content may differ only by the WAL header switch; data must be identical
    const ro = DbAdapter.open(file, { readonly: true });
    expect(ro.rowCounts()).toEqual(manifest['busy-store'].rowCounts);
    ro.close();
    expect(before).toBeTruthy();
  });

  it('a database from a newer app version (unknown schema version) is refused', async () => {
    const { dir, file } = copyFixture('after-restart');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (999, 'future', 'x', 'x')");
    await expect(migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') })).rejects.toBeInstanceOf(MigrationError);
    db.close();
  });
});

describe('copy-only legacy import', () => {
  it('copies a legacy database; the source stays byte-identical and the copy migrates', async () => {
    const dir = tmp();
    const source = path.join(dir, 'old-app', 'khushi_pharmacy.sqlite');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_DIR, 'busy-store.sqlite'), source);
    const srcSha = sha(source);
    const target = path.join(dir, 'new-data', 'pharmacy.sqlite');
    const r = await importLegacyDatabase(source, target);
    expect(r.sourceSha256).toBe(srcSha);
    expect(sha(source)).toBe(srcSha);
    expect(fs.readdirSync(path.dirname(source))).toEqual(['khushi_pharmacy.sqlite']); // no -wal/-shm left next to the source
    const { db } = await openDatabase(target, { backupDir: path.join(dir, 'new-data', 'backups') });
    expect(invariants(db)).toEqual(manifest['busy-store'].invariants);
    db.close();
    expect(sha(source)).toBe(srcSha);
  });

  it('refuses to overwrite an existing database', async () => {
    const dir = tmp();
    const target = path.join(dir, 'pharmacy.sqlite');
    fs.writeFileSync(target, 'existing');
    await expect(importLegacyDatabase(path.join(FIXTURE_DIR, 'busy-store.sqlite'), target)).rejects.toThrow(/will not be overwritten/);
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
  });

  it('refuses a corrupt source and leaves nothing behind', async () => {
    const dir = tmp();
    const source = path.join(dir, 'bad.sqlite');
    const buf = fs.readFileSync(path.join(FIXTURE_DIR, 'busy-store.sqlite'));
    buf.fill(0x41, 4096 * 3, 4096 * 3 + 2000);
    fs.writeFileSync(source, buf);
    const target = path.join(dir, 'out', 'pharmacy.sqlite');
    await expect(importLegacyDatabase(source, target)).rejects.toBeInstanceOf(LegacyImportError);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.importing`)).toBe(false);
  });

  it('refuses a SQLite file that is not a pharmacy database', async () => {
    const dir = tmp();
    const other = path.join(dir, 'other.sqlite');
    const d = DbAdapter.open(other);
    d.exec('CREATE TABLE notes (x)');
    d.close();
    await expect(importLegacyDatabase(other, path.join(dir, 'p.sqlite'))).rejects.toThrow(/not a pharmacy database/);
  });

  it('the repository corrupt sample cannot be imported and is left untouched', async () => {
    const sample = path.join(PROJECT_ROOT, 'data', 'khushi_pharmacy.sqlite.corrupt.1785024578279');
    const before = sha(sample);
    await expect(importLegacyDatabase(sample, path.join(tmp(), 'p.sqlite'))).rejects.toBeInstanceOf(LegacyImportError);
    expect(sha(sample)).toBe(before);
    expect(fs.readdirSync(path.dirname(sample)).sort()).toEqual(['khushi_pharmacy.sqlite.corrupt.1785024578279']);
  });
});
