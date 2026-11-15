/**
 * Phase 9A.3: the backup worker's lifecycle (crash, hang, timeouts, cancellation, memory, protocol violations) and
 * verifyBackupFile. Every failure must end with: the right code, nothing published, no plaintext or .partial left in
 * .work, and the lock released. Misbehaving workers come from tests/helpers/backup-worker-faulty.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createBackup, verifyBackupFile, type CreateBackupOptions, type WorkerEntry } from '../../server/backup/engine';
import { BackupLock } from '../../server/backup/lock';
import { backupLayout, type BackupLayout } from '../../server/backup/paths';
import { parseJob, parseWorkerMessage, type WorkerJob } from '../../server/backup/workerProtocol';

const FAST = { N: 2 ** 15, r: 8, p: 1 };
const SECRET = 'Worker-Test-Pass 3';
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;
const FAULTY = path.join(__dirname, '..', 'helpers', 'backup-worker-faulty.ts');
const faulty = (fault: string, extra: Record<string, unknown> = {}): WorkerEntry => ({ file: FAULTY, execArgv: ['--import', TSX_LOADER], workerData: { manual: true, fault, ...extra } });
let root: string;
let layout: BackupLayout;
const workLeft = () => (fs.existsSync(layout.workDir) ? fs.readdirSync(layout.workDir).filter((n) => n !== 'backup.lock' && n !== 'backup.lock-journal') : []);
const opts = (extra: Partial<CreateBackupOptions> = {}): CreateBackupOptions => ({ dataDir: root, dbFile: layout.dbFile, secret: SECRET, kind: 'manual', appVersion: '1.0.0', kdf: FAST, ...extra });

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-worker-')));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  const db = new Database(layout.dbFile);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1);");
  const ins = db.prepare('INSERT INTO products (name) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 2000; i++) ins.run(`p${i}`); })();
  db.close();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** after any failure: nothing published, nothing left in .work, and the lock can be taken again */
async function assertCleanAfterFailure() {
  expect(workLeft()).toEqual([]);
  expect(fs.existsSync(layout.encryptedDir) ? fs.readdirSync(layout.encryptedDir) : []).toEqual([]);
  const l = await BackupLock.acquire(layout);
  l.release();
}

describe('worker failures are contained and cleaned up', () => {
  const cases: Array<[string, Partial<CreateBackupOptions>, string, string?]> = [
    ['crash', {}, 'WORKER_FAILED', 'crash'],
    ['exit-silently', {}, 'WORKER_FAILED', 'exit'],
    ['exit-code', {}, 'WORKER_FAILED', 'exit'],
    ['bad-result', {}, 'WORKER_FAILED', 'protocol'],
    ['wrong-job', {}, 'WORKER_FAILED', 'protocol'],
    ['leak', {}, 'WORKER_FAILED', 'protocol'],
    ['hang', { idleTimeoutMs: 400 }, 'TIMEOUT', 'idle'],
    ['progress-forever', { timeoutMs: 700, idleTimeoutMs: 10_000 }, 'TIMEOUT', 'overall'],
    ['after-snapshot-hang', { idleTimeoutMs: 1500 }, 'TIMEOUT', 'idle'],
    ['after-verify-fail', {}, 'VERIFY_FAILED', 'mismatch'],
  ];
  for (const [fault, extra, code, stage] of cases) {
    it(`${fault} -> ${code}${stage ? ` (${stage})` : ''}`, async () => {
      const p = createBackup(opts({ workerEntry: faulty(fault), ...extra }));
      await expect(p).rejects.toMatchObject(stage ? { code, stage } : { code });
      await assertCleanAfterFailure();
    }, 60_000);
  }

  it('a reported error code is passed through (e.g. DISK_SPACE from the worker); unknown codes are a protocol violation', async () => {
    await expect(createBackup(opts({ workerEntry: faulty('fail-code', { code: 'DISK_SPACE', stage: 'encrypt' }) }))).rejects.toMatchObject({ code: 'DISK_SPACE', stage: 'encrypt' });
    await expect(createBackup(opts({ workerEntry: faulty('fail-code', { code: 'NOT_A_CODE' }) }))).rejects.toMatchObject({ code: 'WORKER_FAILED', stage: 'protocol' });
    await expect(createBackup(opts({ workerEntry: faulty('fail-code', { code: 'CORRUPT', stage: 'has spaces and /slashes' }) }))).rejects.toMatchObject({ code: 'WORKER_FAILED', stage: 'protocol' });
    await assertCleanAfterFailure();
  }, 60_000);

  it('memory over the worker heap limit -> WORKER_FAILED (memory)', async () => {
    await expect(createBackup(opts({ workerEntry: faulty('oom'), workerResourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } }))).rejects.toMatchObject({ code: 'WORKER_FAILED', stage: 'memory' });
    await assertCleanAfterFailure();
  }, 60_000);

  it('a worker script that cannot be loaded -> WORKER_FAILED', async () => {
    await expect(createBackup(opts({ workerEntry: { file: path.join(root, 'missing-worker.cjs'), execArgv: [] } }))).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    await assertCleanAfterFailure();
  }, 60_000);
});

describe('cancellation', () => {
  it('an already-aborted signal: CANCELLED before anything is created', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createBackup(opts({ signal: ac.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fs.existsSync(layout.backupsDir)).toBe(false);
  });

  it('aborting while the snapshot (plaintext) exists: CANCELLED, the worker is stopped, the plaintext and .partial are removed', async () => {
    const ac = new AbortController();
    const p = createBackup(opts({ workerEntry: faulty('after-snapshot-hang'), signal: ac.signal, onProgress: (x) => { if (x.stage === 'inspect') ac.abort(); } }));
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    await assertCleanAfterFailure();
  }, 60_000);

  it('aborting during a real backup: CANCELLED and clean', async () => {
    const ac = new AbortController();
    const p = createBackup(opts({ signal: ac.signal, onProgress: (x) => { if (x.stage === 'encrypt') ac.abort(); } }));
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    await assertCleanAfterFailure();
  }, 60_000);
});

describe('verifyBackupFile', () => {
  let backup: string;
  beforeEach(async () => { backup = (await createBackup(opts())).path; }, 60_000);

  it('verifies a good backup and returns its header and manifest (no plaintext written anywhere)', async () => {
    const before = fs.readdirSync(layout.workDir).sort();
    const v = await verifyBackupFile(backup, SECRET);
    expect(v.fileBytes).toBe(fs.statSync(backup).size);
    expect(v.manifest.meta.rowCounts).toEqual({ products: 2000, users: 1 });
    expect(fs.readdirSync(layout.workDir).sort()).toEqual(before);
  }, 60_000);

  it('keeps the reader codes: wrong password, tampering, truncation, not a backup; refuses links and relative paths', async () => {
    await expect(verifyBackupFile(backup, 'not the password 1')).rejects.toMatchObject({ code: 'WRONG_SECRET_OR_HEADER_DAMAGED' });
    const copy = (mutate: (b: Buffer) => Buffer) => { const p = path.join(root, `${crypto.randomUUID()}.btbackup`); fs.writeFileSync(p, mutate(Buffer.from(fs.readFileSync(backup)))); return p; };
    await expect(verifyBackupFile(copy((b) => { b[b.length - 40] ^= 1; return b; }), SECRET)).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(verifyBackupFile(copy((b) => b.subarray(0, b.length - 1)), SECRET)).rejects.toMatchObject({ code: 'TRUNCATED' });
    await expect(verifyBackupFile(copy((b) => Buffer.concat([b, Buffer.from('x')])), SECRET)).rejects.toMatchObject({ code: 'TRAILING_DATA' });
    await expect(verifyBackupFile(copy(() => Buffer.from('SQLite format 3\0 not a backup')), SECRET)).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
    await expect(verifyBackupFile(path.join(root, 'missing.btbackup'), SECRET)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(verifyBackupFile('relative.btbackup', SECRET)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(verifyBackupFile(backup, '')).rejects.toMatchObject({ code: 'EMPTY_SECRET' });
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link.btbackup');
      fs.symlinkSync(backup, link);
      await expect(verifyBackupFile(link, SECRET)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    }
  }, 60_000);
});

describe('protocol validation', () => {
  const job: WorkerJob = { type: 'verify', jobId: 'j1', file: '/x.btbackup', secret: 's', maxPlaintextBytes: 10 };
  it('jobs: exact shape only', () => {
    expect(parseJob(job)).toEqual(job);
    for (const bad of [null, [], { ...job, extra: 1 }, { ...job, type: 'delete' }, { ...job, maxPlaintextBytes: -1 }, { ...job, file: '' }]) {
      expect(() => parseJob(bad)).toThrow(expect.objectContaining({ code: 'WORKER_FAILED', stage: 'protocol' }));
    }
  });
  it('worker messages: exact shape, matching job, known codes, plain stage labels; never extra fields', () => {
    expect(parseWorkerMessage({ type: 'progress', jobId: 'j1', stage: 'verify', bytesDone: 1, bytesTotal: 2 }, job)).toBeTruthy();
    expect(parseWorkerMessage({ type: 'failed', jobId: 'j1', code: 'CORRUPT', stage: 'record' }, job)).toBeTruthy();
    const bad = [
      { type: 'progress', jobId: 'j2', stage: 'verify', bytesDone: 1, bytesTotal: 2 },
      { type: 'progress', jobId: 'j1', stage: 'publish', bytesDone: 1, bytesTotal: 2 },
      { type: 'failed', jobId: 'j1', code: 'CORRUPT', stage: 'record', message: 'details' },
      { type: 'failed', jobId: 'j1', code: 'Error', stage: 'x' },
      { type: 'done', jobId: 'j1', result: { info: {}, manifest: {}, fileBytes: 1 } },
      { type: 'other', jobId: 'j1' },
    ];
    for (const b of bad) expect(() => parseWorkerMessage(b, job)).toThrow(expect.objectContaining({ code: 'WORKER_FAILED' }));
  });
});
