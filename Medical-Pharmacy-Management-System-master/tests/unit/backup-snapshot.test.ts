/**
 * Phase 9A.3: consistent SQLite snapshot (server/backup/snapshot.ts): a separate read-only connection, one backup
 * step, a self-contained rollback-journal copy inside the private .work folder, and the checked facts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { assertNoSidecars, inspectSnapshot, mapSqliteError, snapshotDatabase } from '../../server/backup/snapshot';
import { BackupLock } from '../../server/backup/lock';
import { backupLayout, MAX_DATABASE_BYTES, type BackupLayout } from '../../server/backup/paths';
import { ensurePrivateDir } from '../../server/backup/privateDir';
import { createWorkFile } from '../../server/backup/fsSafe';

const isWin = process.platform === 'win32';
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;
const WRITER = path.join(__dirname, '..', 'helpers', 'backup-db-writer.ts');
let root: string;
let layout: BackupLayout;
let lock: BackupLock;
const children = new Set<ChildProcess>();

/** a small pharmacy-shaped database in WAL mode, as the server keeps it */
export function makePharmacyDb(file: string, rows = 200): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO schema_migrations VALUES (1, 'base'), (2, 'more');
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (username) VALUES ('owner'), ('cashier');
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, stock INTEGER);
    CREATE INDEX products_name ON products(name);`);
  const ins = db.prepare('INSERT INTO products (name, stock) VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(`medicine-${i}`, i); })();
  db.close();
}
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function newSnapshotFile(): Promise<string> {
  const f = await createWorkFile(lock, 'snapshot');
  await f.handle.close();
  return f.path;
}

beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-snap-')));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  fs.mkdirSync(layout.backupsDir, { recursive: true });
  await ensurePrivateDir(layout.workDir);
  lock = await BackupLock.acquire(layout);
  makePharmacyDb(layout.dbFile);
}, 60_000);
afterEach(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  children.clear();
  lock?.release();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('snapshotDatabase + inspectSnapshot', () => {
  it('copies the live WAL database into the private file, self-contained (DELETE journal, no side files), with correct facts; the live files are unchanged', async () => {
    const before = { db: sha(layout.dbFile), wal: fs.existsSync(`${layout.dbFile}-wal`) ? sha(`${layout.dbFile}-wal`) : null };
    const snap = await newSnapshotFile();
    const { pages } = await snapshotDatabase(layout.dbFile, snap);
    const facts = await inspectSnapshot(snap);
    expect(facts.pageCount).toBe(pages);
    expect(facts.rowCounts).toEqual({ products: 200, schema_migrations: 2, users: 2 });
    expect(facts.schemaVersion).toBe(2);
    expect(facts.bytes).toBe(fs.statSync(snap).size);
    expect(facts.bytes).toBe(facts.pageSize * facts.pageCount);
    expect(facts.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    await assertNoSidecars(snap);
    const check = new Database(snap, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('delete');
    check.close();
    expect(sha(layout.dbFile)).toBe(before.db);
    if (before.wal) expect(sha(`${layout.dbFile}-wal`)).toBe(before.wal);
    // everything plaintext stayed in .work: only the snapshot and the lock files are there
    expect(fs.readdirSync(layout.workDir).filter((n) => !n.startsWith('backup.lock')).sort()).toEqual([path.basename(snap)]);
    if (!isWin) expect(fs.statSync(snap).mode & 0o777).toBe(0o600);
  });

  it('is consistent while another process keeps committing (snapshot count between before and after; integrity ok)', async () => {
    const child = fork(WRITER, [layout.dbFile], { execArgv: ['--import', TSX_LOADER], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.add(child);
    const next = (type: string) => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`writer did not report ${type}`)), 30_000);
      const on = (m: any) => { if (m?.type === type) { clearTimeout(t); child.off('message', on); resolve(m); } };
      child.on('message', on);
    });
    const ready = await next('ready');
    const snap = await newSnapshotFile();
    await snapshotDatabase(layout.dbFile, snap);
    child.send({ type: 'stop' });
    const stopped = await next('stopped');
    const facts = await inspectSnapshot(snap); // integrity_check inside
    expect(facts.rowCounts.products).toBeGreaterThanOrEqual(ready.count);
    expect(facts.rowCounts.products).toBeLessThanOrEqual(stopped.count);
    expect(stopped.count).toBeGreaterThan(ready.count); // the writer really kept writing
  }, 60_000);

  it('an open, uncommitted write transaction on another connection is not in the snapshot and is not blocked', async () => {
    const server = new Database(layout.dbFile);
    server.exec('BEGIN IMMEDIATE');
    server.prepare("INSERT INTO products (name, stock) VALUES ('uncommitted', 0)").run();
    const snap = await newSnapshotFile();
    await snapshotDatabase(layout.dbFile, snap);
    server.exec('COMMIT'); // the writer could finish after the snapshot
    expect((await inspectSnapshot(snap)).rowCounts.products).toBe(200);
    expect((server.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n).toBe(201);
    server.close();
  });

  it('refuses unsafe targets: a non-empty file, a symlink, an existing side file, a missing source', async () => {
    const full = await newSnapshotFile();
    fs.writeFileSync(full, 'x');
    await expect(snapshotDatabase(layout.dbFile, full)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    const snap = await newSnapshotFile();
    fs.writeFileSync(`${snap}-journal`, '');
    await expect(snapshotDatabase(layout.dbFile, snap)).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
    fs.unlinkSync(`${snap}-journal`);
    if (!isWin) {
      const link = path.join(layout.workDir, `${crypto.randomUUID()}.snapshot.tmp`);
      fs.symlinkSync(path.join(root, 'elsewhere.sqlite'), link);
      await expect(snapshotDatabase(layout.dbFile, link)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
      expect(fs.existsSync(path.join(root, 'elsewhere.sqlite'))).toBe(false);
    }
    await expect(snapshotDatabase(path.join(root, 'missing.sqlite'), snap)).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
  });

  it('a database without the pharmacy tables is refused (SNAPSHOT_FAILED not-pharmacy)', async () => {
    const other = path.join(root, 'other.sqlite');
    const d = new Database(other); d.exec('CREATE TABLE notes (a)'); d.close();
    const snap = await newSnapshotFile();
    await snapshotDatabase(other, snap);
    await expect(inspectSnapshot(snap)).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'not-pharmacy' });
  });

  it('a damaged snapshot fails its integrity check (SNAPSHOT_FAILED)', async () => {
    makePharmacyDb(path.join(root, 'big.sqlite'), 5000);
    const snap = await newSnapshotFile();
    await snapshotDatabase(path.join(root, 'big.sqlite'), snap);
    const fd = fs.openSync(snap, 'r+');
    const pageSize = 4096;
    fs.writeSync(fd, crypto.randomBytes(pageSize * 3), 0, pageSize * 3, pageSize * 4); // overwrite pages 5-7
    fs.closeSync(fd);
    await expect(inspectSnapshot(snap)).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
  });

  it('a source locked exclusively by another connection is SNAPSHOT_FAILED (busy), within the busy timeout', async () => {
    const rollback = path.join(root, 'rollback.sqlite');
    makePharmacyDb(rollback);
    const conv = new Database(rollback); conv.pragma('journal_mode = DELETE'); conv.close();
    const holder = new Database(rollback);
    holder.exec('BEGIN EXCLUSIVE');
    holder.prepare("INSERT INTO products (name, stock) VALUES ('x', 0)").run();
    const snap = await newSnapshotFile();
    const started = Date.now();
    await expect(snapshotDatabase(rollback, snap, { busyTimeoutMs: 200 })).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'busy' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fs.statSync(snap).size).toBe(0); // nothing copied
    holder.exec('ROLLBACK'); holder.close();
  });

  it('SQLite "disk full" maps to DISK_SPACE; busy/locked to SNAPSHOT_FAILED busy; anything else to SNAPSHOT_FAILED', () => {
    expect(mapSqliteError(Object.assign(new Error('x'), { code: 'SQLITE_FULL' }), 'copy')).toMatchObject({ code: 'DISK_SPACE' });
    expect(mapSqliteError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }), 'copy')).toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'busy' });
    expect(mapSqliteError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' }), 'copy')).toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'busy' });
    expect(mapSqliteError(Object.assign(new Error('secret path C:\\x'), { code: 'SQLITE_IOERR' }), 'copy')).toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'copy' });
    expect(mapSqliteError(new Error('x'), 'copy').message).not.toContain('x:');
  });

  it.skipIf(isWin)('a snapshot over 4 GiB is FILE_TOO_LARGE before it is opened (sparse file)', async () => {
    const snap = await newSnapshotFile();
    fs.truncateSync(snap, MAX_DATABASE_BYTES + 1);
    await expect(inspectSnapshot(snap)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
