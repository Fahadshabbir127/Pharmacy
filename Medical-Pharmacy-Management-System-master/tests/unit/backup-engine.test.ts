/**
 * Phase 9A.3: the backup engine (server/backup/engine.ts) and the building blocks it adds to 9A.2
 * (per-file private checks, the read/write .partial, KDF_FAILED).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupLock } from '../../server/backup/lock';
import { backupLayout, type BackupLayout } from '../../server/backup/paths';
import { ensurePrivateDir, isExpectedInheritedFileSddl, verifyPrivateFile, READ_FILE_ACL_SCRIPT, type AclRunner } from '../../server/backup/privateDir';
import { createWorkFile, syncAndClose, writeAll } from '../../server/backup/fsSafe';
import { deriveKeys } from '../../server/backup/kdf';
import { BACKUP_ERROR_CODES, BackupError, isBackupErrorCode } from '../../server/backup/errors';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { cleanupStaleArtifacts, createBackup, verifyBackupFile, type BackupProgress, type CreateBackupOptions, type WorkerEntry } from '../../server/backup/engine';
import { decodeBackup } from '../../server/backup/format';
import { DEFAULT_KDF } from '../../server/backup/kdf';

const isWin = process.platform === 'win32';
let root: string;
let layout: BackupLayout;

async function freshLayout(prefix: string) {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  fs.mkdirSync(layout.backupsDir, { recursive: true });
  await ensurePrivateDir(layout.workDir);
  await ensurePrivateDir(layout.encryptedDir);
}

describe('S1 building blocks', () => {
  let lock: BackupLock;
  beforeEach(async () => { await freshLayout('bt-s1-'); lock = await BackupLock.acquire(layout); }, 60_000);
  afterEach(() => { lock?.release(); fs.rmSync(root, { recursive: true, force: true }); });

  it('new error codes are known codes with fixed messages', () => {
    for (const c of ['KDF_FAILED', 'SNAPSHOT_FAILED', 'VERIFY_FAILED', 'WORKER_FAILED', 'CANCELLED', 'TIMEOUT']) {
      expect(isBackupErrorCode(c)).toBe(true);
      expect(BACKUP_ERROR_CODES).toContain(c);
      expect(new BackupError(c as any, 'x').message.length).toBeGreaterThan(10);
    }
    expect(isBackupErrorCode('NOPE')).toBe(false);
    expect(isBackupErrorCode('toString')).toBe(false);
  });

  it('a run-time scrypt failure is KDF_FAILED (not KDF_PARAMS_REJECTED); valid parameters are unchanged', async () => {
    const spy = vi.spyOn(crypto, 'scrypt').mockImplementation(((_p: any, _s: any, _l: any, _o: any, cb: any) => cb(Object.assign(new Error('memory limit exceeded secret-details'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' }))) as any);
    try {
      const p = deriveKeys('Some pass 1', Buffer.alloc(32, 1), { N: 2 ** 15, r: 8, p: 1 });
      await expect(p).rejects.toMatchObject({ code: 'KDF_FAILED' });
      await p.catch((e) => expect(String(e.message)).not.toContain('secret-details'));
    } finally {
      spy.mockRestore();
    }
    await expect(deriveKeys('Some pass 1', Buffer.alloc(32, 1), { N: 2 ** 30, r: 8, p: 1 })).rejects.toMatchObject({ code: 'KDF_PARAMS_REJECTED' });
  });

  it("createWorkFile({readWrite}) opens 'wx+': the same handle can be written and read back; it never opens an existing name", async () => {
    const f = await createWorkFile(lock, 'btbackup', { readWrite: true });
    await writeAll(f.handle, Buffer.from('encrypted-bytes'));
    const back = Buffer.alloc(15);
    const { bytesRead } = await f.handle.read(back, 0, 15, 0);
    expect(back.subarray(0, bytesRead).toString()).toBe('encrypted-bytes');
    await syncAndClose(f.handle);
    const w = await createWorkFile(lock, 'snapshot'); // default stays write-only
    await expect(w.handle.read(Buffer.alloc(1), 0, 1, 0)).rejects.toBeTruthy();
    await w.handle.close();
    await expect(fs.promises.open(f.path, 'wx+')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it.skipIf(isWin)('verifyPrivateFile (POSIX): accepts a 0600 file of this user; refuses group/other bits, another owner, symlinks, hard links and folders', async () => {
    const f = await createWorkFile(lock, 'snapshot');
    await f.handle.close();
    await verifyPrivateFile(f.path);
    fs.chmodSync(f.path, 0o640);
    await expect(verifyPrivateFile(f.path)).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    fs.chmodSync(f.path, 0o600);
    await expect(verifyPrivateFile(f.path, { uid: 12345 })).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    const link = path.join(layout.workDir, `${crypto.randomUUID()}.snapshot.tmp`);
    fs.symlinkSync(f.path, link);
    await expect(verifyPrivateFile(link)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    const hard = path.join(layout.workDir, `${crypto.randomUUID()}.snapshot.tmp`);
    fs.linkSync(f.path, hard);
    await expect(verifyPrivateFile(f.path)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(verifyPrivateFile(layout.workDir)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(verifyPrivateFile(path.join(layout.workDir, 'missing'))).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  });

  describe('Windows rules with an injected runner (run on every platform)', () => {
    const USER = 'S-1-5-21-1-2-3-1001';
    const report = (o: Record<string, unknown> = {}) => JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: `D:AI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`, reparse: false, ...o });
    const opts = (runner: AclRunner) => ({ platform: 'win32' as const, aclRunner: runner });

    it('the file check uses the fixed file script and accepts exactly the inherited private entries', async () => {
      const f = await createWorkFile(lock, 'snapshot');
      await f.handle.close();
      const calls: string[] = [];
      await verifyPrivateFile(f.path, opts(async (s, t) => { calls.push(`${s}:${t === f.path}`); return report(); }));
      expect(calls).toEqual(['readFile:true']);
      expect(READ_FILE_ACL_SCRIPT).toContain('[System.IO.FileInfo]::new($p)');
      expect(READ_FILE_ACL_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/); // no cmdlets
    });

    it('the file check fails closed: extra or explicit entries, a protected file, another owner, a reparse point, runner failure', async () => {
      const f = await createWorkFile(lock, 'snapshot');
      await f.handle.close();
      const bad = [
        report({ sddl: `D:AI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FR;;;BU)` }),
        report({ sddl: `D:AI(A;;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)` }), // explicit (not inherited) entry
        report({ sddl: `D:PAI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)` }), // protected
        report({ sddl: `D:AI(A;ID;FR;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)` }),
        report({ owner: 'S-1-5-21-1-2-3-1002' }),
        report({ reparse: true }),
        'garbage',
      ];
      for (const out of bad) await expect(verifyPrivateFile(f.path, opts(async () => out))).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
      await expect(verifyPrivateFile(f.path, opts(async () => { throw new Error('blocked'); }))).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    });

    it('isExpectedInheritedFileSddl accepts both spellings and any order, nothing else', () => {
      expect(isExpectedInheritedFileSddl(`D:AI(A;ID;FA;;;BA)(A;ID;0x1f01ff;;;S-1-5-18)(A;ID;FA;;;${USER})`, USER)).toBe(true);
      expect(isExpectedInheritedFileSddl(`D:(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`, USER)).toBe(true);
      for (const s of ['', 'D:', `D:AI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)`, `D:AI(A;IDOI;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`, `D:AI(D;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`]) {
        expect(isExpectedInheritedFileSddl(s, USER), s).toBe(false);
      }
    });
  });

  it.skipIf(!isWin)('Windows: a new file in the private .work has exactly the inherited private entries (real PowerShell)', async () => {
    const f = await createWorkFile(lock, 'snapshot');
    await f.handle.close();
    await verifyPrivateFile(f.path);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// the engine end to end (real worker thread)

const FAST = { N: 2 ** 15, r: 8, p: 1 };
const SECRET = 'Engine-Backup-Pass 9';
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;
const HELPERS = path.join(__dirname, '..', 'helpers');
const faulty = (fault: string, extra: Record<string, unknown> = {}): WorkerEntry => ({ file: path.join(HELPERS, 'backup-worker-faulty.ts'), execArgv: ['--import', TSX_LOADER], workerData: { manual: true, fault, ...extra } });
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const workLeft = () => fs.readdirSync(layout.workDir).filter((n) => n !== 'backup.lock' && n !== 'backup.lock-journal');
const children = new Set<ChildProcess>();

function makePharmacyDb(file: string, rows = 300): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO schema_migrations VALUES (1, 'base'), (11, 'invoice sequences');
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (username) VALUES ('owner');
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, stock INTEGER);`);
  const ins = db.prepare('INSERT INTO products (name, stock) VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(`medicine-${i}`, i); })();
  db.close();
}
const opts = (extra: Partial<CreateBackupOptions> = {}): CreateBackupOptions => ({ dataDir: root, dbFile: layout.dbFile, secret: SECRET, kind: 'manual', appVersion: '1.2.3', kdf: FAST, ...extra });

/** decrypt a published backup into a temporary file outside the project (test only) and count its rows */
async function restoredCounts(file: string): Promise<Record<string, number>> {
  const { data } = await decodeBackup(fs.readFileSync(file), SECRET);
  const tmp = path.join(root, `check-${crypto.randomUUID()}.sqlite`);
  fs.writeFileSync(tmp, data);
  const d = new Database(tmp, { readonly: true });
  const out: Record<string, number> = {};
  for (const t of ['products', 'schema_migrations', 'users']) out[t] = (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  expect(d.pragma('integrity_check', { simple: true })).toBe('ok');
  d.close();
  fs.rmSync(tmp);
  return out;
}

describe('createBackup', () => {
  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-engine-')));
    layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
    makePharmacyDb(layout.dbFile);
  });
  afterEach(async () => {
    // a child may still hold files in the test folder (e.g. the backup lock); Windows cannot delete files that are
    // open in another process, so wait until every child has really exited before removing the folder
    await Promise.all([...children].map((c) => new Promise<void>((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
      c.once('exit', () => resolve());
      try { c.kill('SIGKILL'); } catch { /* already gone: 'exit' has fired or will fire */ }
    })));
    children.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates, verifies and publishes one encrypted backup; nothing else is left; the live database and legacy backups are untouched', async () => {
    fs.mkdirSync(layout.backupsDir, { recursive: true });
    const legacy = path.join(layout.backupsDir, 'pre-migration-v10-to-v11-x.sqlite');
    fs.writeFileSync(legacy, 'legacy plaintext backup');
    const watched = [layout.dbFile, `${layout.dbFile}-wal`, legacy].filter((p) => fs.existsSync(p));
    const before = watched.map((p) => sha(p));
    const stages: string[] = [];
    const r = await createBackup(opts({ onProgress: (p: BackupProgress) => { if (stages[stages.length - 1] !== p.stage) stages.push(p.stage); } }));

    expect(path.dirname(r.path)).toBe(layout.encryptedDir);
    expect(r.name).toMatch(/^manual-\d{8}T\d{6}Z-[0-9a-f]{8}\.btbackup$/);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([r.name]);
    expect(workLeft()).toEqual([]);
    expect(r.rowCounts).toEqual({ products: 300, schema_migrations: 2, users: 1 });
    expect(r.schemaVersion).toBe(11);
    expect(r.fileBytes).toBe(fs.statSync(r.path).size);
    expect(r.cleanupPending).toBe(0);
    expect(r.kdf).toEqual(FAST);
    expect(stages).toEqual(['prepare', 'snapshot', 'inspect', 'encrypt', 'verify', 'publish']);
    watched.forEach((p, i) => expect(sha(p), p).toBe(before[i]));

    const v = await verifyBackupFile(r.path, SECRET);
    expect(v.manifest.plaintextSha256).toBe(r.plaintextSha256);
    expect(v.manifest.meta.rowCounts).toEqual(r.rowCounts);
    expect(v.info).toMatchObject({ backupId: r.backupId, kind: 'manual', appVersion: '1.2.3', schemaVersion: 11 });
    expect(await restoredCounts(r.path)).toEqual(r.rowCounts);
    if (!isWin) {
      expect(fs.statSync(r.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(layout.workDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(layout.encryptedDir).mode & 0o777).toBe(0o700);
    }
  }, 60_000);

  it('uses the approved default KDF (N 2^17, r 8, p 1) when none is given', async () => {
    const r = await createBackup(opts({ kdf: undefined }));
    expect(r.kdf).toEqual({ ...DEFAULT_KDF });
    expect((await verifyBackupFile(r.path, SECRET)).info.kdf).toEqual({ ...DEFAULT_KDF });
  }, 60_000);

  it('is consistent while another process keeps writing to the live database', async () => {
    const child = fork(path.join(HELPERS, 'backup-db-writer.ts'), [layout.dbFile], { execArgv: ['--import', TSX_LOADER], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.add(child);
    const next = (type: string) => new Promise<any>((resolve) => { const on = (m: any) => { if (m?.type === type) { child.off('message', on); resolve(m); } }; child.on('message', on); });
    const ready = await next('ready');
    const r = await createBackup(opts());
    child.send({ type: 'stop' });
    const stopped = await next('stopped');
    expect(r.rowCounts.products).toBeGreaterThanOrEqual(ready.count);
    expect(r.rowCounts.products).toBeLessThanOrEqual(stopped.count);
    expect((await restoredCounts(r.path)).products).toBe(r.rowCounts.products);
  }, 60_000);

  it('another holder of the backup lock: BACKUP_IN_PROGRESS at once, no snapshot, nothing published', async () => {
    fs.mkdirSync(layout.backupsDir, { recursive: true });
    await ensurePrivateDir(layout.workDir);
    const child = fork(path.join(HELPERS, 'backup-lock-holder.ts'), [JSON.stringify({ dataDir: root, dbFile: layout.dbFile, mode: 'hold' })], { execArgv: ['--import', TSX_LOADER], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.add(child);
    await new Promise<void>((resolve) => child.on('message', (m: any) => { if (m?.type === 'locked') resolve(); }));
    const started = Date.now();
    await expect(createBackup(opts())).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  }, 60_000);

  it('invalid options are refused before anything is created', async () => {
    await expect(createBackup(opts({ secret: '' }))).rejects.toMatchObject({ code: 'EMPTY_SECRET' });
    await expect(createBackup(opts({ kind: 'weekly' as any }))).rejects.toBeInstanceOf(TypeError);
    await expect(createBackup(opts({ appVersion: 'bad version!' }))).rejects.toBeInstanceOf(TypeError);
    await expect(createBackup(opts({ kdf: { N: 2 ** 30, r: 8, p: 1 } }))).rejects.toMatchObject({ code: 'KDF_PARAMS_REJECTED' });
    await expect(createBackup(opts({ chunkSize: 1 }))).rejects.toBeInstanceOf(TypeError);
    await expect(createBackup(opts({ dataDir: 'relative' }))).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.existsSync(layout.backupsDir)).toBe(false);
  });

  it('not enough disk space: DISK_SPACE before any file is created', async () => {
    await expect(createBackup(opts({ statfs: async () => ({ bavail: 1, bsize: 4096 }) }))).rejects.toMatchObject({ code: 'DISK_SPACE' });
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  });

  it("a snapshot file whose own access list does not verify: PERMISSIONS_UNVERIFIED, no plaintext written, nothing left", async () => {
    const USER = 'S-1-5-21-1-2-3-1001';
    const good = JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, reparse: false });
    const badFile = JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: `D:AI(A;ID;FA;;;${USER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FR;;;BU)`, reparse: false });
    const runner: AclRunner = async (script) => (script === 'readFile' ? badFile : good);
    let workerStarted = false;
    await expect(createBackup(opts({ privateDir: { platform: 'win32', aclRunner: runner }, onProgress: (p) => { if (p.stage === 'snapshot') workerStarted = true; } }))).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    expect(workerStarted).toBe(false);
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  });

  it('a database that is not a pharmacy database: SNAPSHOT_FAILED and the plaintext copy is removed', async () => {
    fs.rmSync(layout.dbFile); fs.rmSync(`${layout.dbFile}-wal`, { force: true }); fs.rmSync(`${layout.dbFile}-shm`, { force: true });
    const d = new Database(layout.dbFile); d.exec('CREATE TABLE notes (a)'); d.close();
    await expect(createBackup(opts())).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED', stage: 'not-pharmacy' });
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  }, 60_000);

  it('a disk without hard links: HARDLINK_UNSUPPORTED, nothing published, no plaintext or .partial left', async () => {
    const link = async () => { throw Object.assign(new Error('x'), { code: 'ENOTSUP' }); };
    await expect(createBackup(opts({ publish: { link } }))).rejects.toMatchObject({ code: 'HARDLINK_UNSUPPORTED' });
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  }, 60_000);

  it('plaintext that cannot be deleted after verification (antivirus lock): the verified backup is still published with cleanupPending; the next sweep removes it', async () => {
    const realUnlink = (f: string) => fs.promises.unlink(f);
    const retry = { sleep: async () => undefined, unlink: async (f: string) => { if (f.includes('.snapshot.tmp')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realUnlink(f); } };
    const r = await createBackup(opts({ retry }));
    expect(r.cleanupPending).toBe(1);
    expect(fs.existsSync(r.path)).toBe(true);
    expect(workLeft().some((n) => n.endsWith('.snapshot.tmp'))).toBe(true);
    expect(await cleanupStaleArtifacts({ dataDir: root, dbFile: layout.dbFile })).toMatchObject({ removed: 1, failed: 0 });
    expect(workLeft()).toEqual([]);
    await verifyBackupFile(r.path, SECRET);
  }, 60_000);

  it('after the process is killed in the middle of a backup, the next backup removes the leftovers and succeeds', async () => {
    const engine = pathToFileURL(path.join(__dirname, '..', '..', 'server', 'backup', 'engine.ts')).href;
    const code = `import { createBackup } from ${JSON.stringify(engine)};
      createBackup(${JSON.stringify({ ...opts(), workerEntry: faulty('after-snapshot-hang') })}).catch(() => {});`;
    const child = spawn(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', code], { stdio: 'ignore' });
    children.add(child);
    const deadline = Date.now() + 30_000;
    const snapshotWritten = () => fs.existsSync(layout.workDir) && workLeft().some((n) => n.endsWith('.snapshot.tmp') && fs.statSync(path.join(layout.workDir, n)).size > 0);
    while (!snapshotWritten()) { if (Date.now() > deadline) throw new Error('child did not write a snapshot'); await new Promise((r) => setTimeout(r, 50)); }
    child.kill('SIGKILL');
    await new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); });
    expect(workLeft().length).toBeGreaterThan(0); // plaintext snapshot and .partial left by the killed process
    const r = await createBackup(opts());
    expect(workLeft()).toEqual([]);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([r.name]);
  }, 90_000);

  it('a second backup never replaces the first', async () => {
    const a = await createBackup(opts());
    const hash = sha(a.path);
    const b = await createBackup(opts({ kind: 'scheduled' }));
    expect(b.path).not.toBe(a.path);
    expect(sha(a.path)).toBe(hash);
    expect(fs.readdirSync(layout.encryptedDir).sort()).toEqual([a.name, b.name].sort());
  }, 60_000);

  it('no password, derived key or salt appears in results, errors or console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    try {
      const r = await createBackup(opts());
      const failures: unknown[] = [];
      await createBackup(opts({ workerEntry: faulty('fail-code', { code: 'CORRUPT', stage: 'record' }) })).catch((e) => failures.push(e));
      await createBackup(opts({ workerEntry: faulty('leak') })).catch((e) => failures.push(e));
      await verifyBackupFile(r.path, 'wrong password 1').catch((e) => failures.push(e));
      expect(failures).toHaveLength(3);
      const text = JSON.stringify(r) + failures.map((e) => `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`).join('\n');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('wrong password 1');
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// large database (D12): about 1 GB, only with BT_LARGE_TESTS=1 (needs ~3 GB free in the temp folder, slow)

describe.skipIf(!process.env.BT_LARGE_TESTS)('large database (BT_LARGE_TESTS=1)', () => {
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-large-')));
    layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
    const db = new Database(layout.dbFile);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
      CREATE TABLE products (id INTEGER PRIMARY KEY, blob BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO products (blob) SELECT randomblob(1048576) FROM n;`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }, 600_000);
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('backs up and verifies about 1 GB with the default KDF; the main thread holds no copy of the data', async () => {
    const dbBytes = fs.statSync(layout.dbFile).size;
    expect(dbBytes).toBeGreaterThan(1000 * 1024 * 1024);
    const base = process.memoryUsage();
    let peakRss = base.rss; let peakBuffers = base.arrayBuffers;
    const sampler = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakBuffers = Math.max(peakBuffers, m.arrayBuffers); }, 50);
    const started = Date.now();
    let r;
    try {
      r = await createBackup({ dataDir: root, dbFile: layout.dbFile, secret: SECRET, kind: 'manual', appVersion: '1.0.0' });
    } finally {
      clearInterval(sampler);
    }
    const seconds = (Date.now() - started) / 1000;
    expect(r.plaintextBytes).toBe(dbBytes);
    expect(r.rowCounts.products).toBe(1000);
    expect(workLeft()).toEqual([]);
    // whole-process figures (main thread + worker share the process): far below the database size
    expect(peakBuffers - base.arrayBuffers).toBeLessThan(128 * 1024 * 1024);
    expect(peakRss - base.rss).toBeLessThan(700 * 1024 * 1024);
    console.info(`[large backup] ${(dbBytes / 1048576).toFixed(0)} MiB in ${seconds.toFixed(1)} s; peak RSS +${((peakRss - base.rss) / 1048576).toFixed(0)} MiB, peak Buffers +${((peakBuffers - base.arrayBuffers) / 1048576).toFixed(0)} MiB`);
  }, 1_200_000);
});
