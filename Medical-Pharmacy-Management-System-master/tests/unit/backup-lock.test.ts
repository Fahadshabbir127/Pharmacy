/**
 * Phase 9A.2: the backup lock (an OS file lock through SQLite, rollback journal) and the .work sweep
 * (server/backup/lock.ts). Cross-process tests use real child processes (tests/helpers/backup-lock-holder.ts).
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
import { BackupLock, sweepWorkDir } from '../../server/backup/lock';
import { backupLayout, newBackupName, newWorkName, type BackupLayout } from '../../server/backup/paths';
import { ensurePrivateDir } from '../../server/backup/privateDir';
import { createWorkFile, publishByHardLink, syncAndClose, writeAll } from '../../server/backup/fsSafe';

const isWin = process.platform === 'win32';
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;
const HOLDER = path.join(__dirname, '..', 'helpers', 'backup-lock-holder.ts');
let root: string;
let layout: BackupLayout;
const children = new Set<ChildProcess>();

beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lock-')));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  fs.mkdirSync(layout.backupsDir, { recursive: true });
  await ensurePrivateDir(layout.workDir);
  await ensurePrivateDir(layout.encryptedDir);
}, 60_000);
afterEach(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  children.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

function startChild(mode: 'hold' | 'write'): { child: ChildProcess; next: (type: string) => Promise<any> } {
  const child = fork(HOLDER, [JSON.stringify({ dataDir: root, dbFile: layout.dbFile, mode })], { execArgv: ['--import', TSX_LOADER], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.add(child);
  const queue: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  child.on('message', (m) => { const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  const next = (type: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not report ${type}`)), 30_000);
    const take = (m: any) => { clearTimeout(timer); if (m?.type === type) resolve(m); else reject(new Error(`child reported ${JSON.stringify(m)}, expected ${type}`)); };
    if (queue.length) take(queue.shift()); else waiters.push(take);
  });
  return { child, next };
}
const exited = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('exit', () => r()); });

describe('lock in one process', () => {
  it('acquire, a second acquire fails fast, release, acquire again; the lock database uses a rollback journal and stays empty', async () => {
    const a = await BackupLock.acquire(layout);
    expect(a.held).toBe(true);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    // a separate connection in the same process is refused by SQLite itself (the OS-level lock is held)
    const other = new Database(layout.lockFile, { timeout: 0 });
    expect(() => other.exec('BEGIN EXCLUSIVE')).toThrow(/locked|busy/i);
    other.close();
    a.release();
    a.release(); // idempotent
    expect(a.held).toBe(false);
    const b = await BackupLock.acquire(layout);
    b.release();
    const check = new Database(layout.lockFile, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    check.close();
    expect(fs.existsSync(`${layout.lockFile}-journal`)).toBe(false);
    if (!isWin) expect(fs.statSync(layout.lockFile).mode & 0o777).toBe(0o600);
  });
});

describe('lock across processes', () => {
  it('a child holding the lock while doing asynchronous work blocks this process; releasing it frees the lock', async () => {
    const { child, next } = startChild('hold');
    await next('locked');
    await new Promise((r) => setTimeout(r, 300)); // the child keeps running timers and file reads while holding
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    child.send({ type: 'release' });
    const done = await next('released');
    expect(done.ticks).toBeGreaterThan(3); // the lock really was held across asynchronous work
    await exited(child);
    const l = await BackupLock.acquire(layout);
    l.release();
  }, 60_000);

  it('a holder killed outright releases the lock at once (no stale lock, no process ids involved)', async () => {
    const { child, next } = startChild('hold');
    await next('locked');
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    child.kill('SIGKILL'); // TerminateProcess on Windows
    await exited(child);
    const l = await BackupLock.acquire(layout);
    expect(l.held).toBe(true);
    l.release();
    // the lock file left behind by the dead process holds no process id or other state
    expect(fs.statSync(layout.lockFile).size).toBe(0);
  }, 60_000);

  it('this process holding the lock blocks a child', async () => {
    const l = await BackupLock.acquire(layout);
    try {
      const { next } = startChild('hold');
      const m = await next('error');
      expect(m.code).toBe('BACKUP_IN_PROGRESS');
    } finally {
      l.release();
    }
  }, 60_000);
});

describe('planted files and links', () => {
  it.skipIf(isWin)('a symlink as backup.lock is refused and its target is untouched', async () => {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'precious');
    fs.symlinkSync(target, layout.lockFile);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    fs.unlinkSync(layout.lockFile);
    fs.symlinkSync(target, `${layout.lockFile}-journal`);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
  });

  it('a backup.lock with a second name (hard link) is refused', async () => {
    const other = path.join(root, 'other.db');
    fs.writeFileSync(other, '');
    fs.linkSync(other, layout.lockFile);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  });

  it('a hard-linked journal is refused (PATH_REJECTED); the other name is untouched', async () => {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'precious');
    fs.linkSync(target, `${layout.lockFile}-journal`);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
  });
  it.skipIf(isWin)('.work replaced by a symlink, or with open permissions, is refused before any lock file is created', async () => {
    fs.rmSync(layout.workDir, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, layout.workDir);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.unlinkSync(layout.workDir);
    fs.mkdirSync(layout.workDir, { mode: 0o755 });
    fs.chmodSync(layout.workDir, 0o755);
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    expect(fs.existsSync(layout.lockFile)).toBe(false);
  });

  it.skipIf(!isWin)('Windows: .work replaced by a junction is refused', async () => {
    fs.rmSync(layout.workDir, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, layout.workDir, 'junction');
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  }, 60_000);
});

describe('SQLite rollback journal of the lock database', () => {
  const journal = () => `${layout.lockFile}-journal`;

  it('the journal exists while the lock is held and disappears after release; the lock database stays empty', async () => {
    const l = await BackupLock.acquire(layout);
    expect(fs.existsSync(journal())).toBe(true); // created by SQLite for BEGIN EXCLUSIVE on an empty database
    expect(fs.lstatSync(journal()).isFile()).toBe(true);
    l.release();
    expect(fs.existsSync(journal())).toBe(false);
    expect(fs.statSync(layout.lockFile).size).toBe(0);
  });

  it('a leftover journal from a holder that died is handled by SQLite: acquisition succeeds and the journal is cleaned up', async () => {
    const { child, next } = startChild('hold');
    await next('locked');
    expect(fs.existsSync(journal())).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    expect(fs.existsSync(journal())).toBe(true); // left behind by the dead holder
    const l = await BackupLock.acquire(layout);
    expect(l.held).toBe(true);
    l.release();
    expect(fs.existsSync(journal())).toBe(false);
    expect(fs.statSync(layout.lockFile).size).toBe(0);
    const again = await BackupLock.acquire(layout); // and the lock keeps working
    again.release();
  }, 60_000);

  it('another process holding the lock: BACKUP_IN_PROGRESS at once, and its journal is not deleted or changed', async () => {
    const { child, next } = startChild('hold');
    await next('locked');
    const before = fs.statSync(journal(), { bigint: true });
    const started = Date.now();
    await expect(BackupLock.acquire(layout)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    expect(Date.now() - started).toBeLessThan(1000); // no waiting or retrying
    const after = fs.statSync(journal(), { bigint: true });
    expect(after.ino).toBe(before.ino); // the same file, still there
    expect(after.size).toBe(before.size);
    child.send({ type: 'release' });
    await next('released');
    await exited(child);
    expect(fs.existsSync(journal())).toBe(false); // removed by its owner at release
  }, 60_000);
});

describe('sweep of .work', () => {
  it('requires the held lock', async () => {
    const l = await BackupLock.acquire(layout);
    l.release();
    await expect(sweepWorkDir(l)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
  });

  it('removes only our temporary files; leaves the lock, unknown names, folders, links and multi-name files', async () => {
    const ours = [newWorkName('snapshot'), newWorkName('btbackup'), `${newWorkName('snapshot')}-journal`, `${newWorkName('snapshot')}-wal`];
    for (const n of ours) fs.writeFileSync(path.join(layout.workDir, n), 'plaintext');
    fs.writeFileSync(path.join(layout.workDir, 'notes.txt'), 'not ours');
    fs.mkdirSync(path.join(layout.workDir, newWorkName('snapshot'))); // a folder with our name pattern
    const outside = path.join(root, 'outside.sqlite');
    fs.writeFileSync(outside, 'must survive');
    if (!isWin) fs.symlinkSync(outside, path.join(layout.workDir, newWorkName('snapshot')));
    const linkedName = newWorkName('snapshot');
    fs.linkSync(outside, path.join(layout.workDir, linkedName)); // a second name of a file outside .work

    const l = await BackupLock.acquire(layout);
    try {
      const r = await sweepWorkDir(l);
      expect(r.removed).toBe(4);
      expect(r.failed).toBe(0);
      expect(r.skipped).toBe(isWin ? 3 : 4);
    } finally {
      l.release();
    }
    const left = fs.readdirSync(layout.workDir).sort();
    for (const n of ours) expect(left).not.toContain(n);
    expect(left).toContain('backup.lock');
    expect(left).toContain('notes.txt');
    expect(left).toContain(linkedName);
    expect(fs.readFileSync(outside, 'utf8')).toBe('must survive');
  });

  it('removes a leftover .partial whose second name is the published backup (cleanup pending after publishing)', async () => {
    const l = await BackupLock.acquire(layout);
    const f = await createWorkFile(l, 'btbackup');
    await writeAll(f.handle, Buffer.from('encrypted bytes'));
    await syncAndClose(f.handle);
    const r = await publishByHardLink(l, f.path, newBackupName('manual'), { sleep: async () => undefined, unlink: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
    expect(r.cleanupPending).toBe(1);
    try {
      expect(await sweepWorkDir(l)).toEqual({ removed: 1, skipped: 0, failed: 0 });
    } finally {
      l.release();
    }
    expect(fs.existsSync(f.path)).toBe(false);
    expect(fs.readFileSync(r.finalPath, 'utf8')).toBe('encrypted bytes');
    expect(fs.statSync(r.finalPath).nlink).toBe(1);
  });

  it('after a crash in the middle of writing a plaintext snapshot, the next sweep removes it', async () => {
    const { child, next } = startChild('write');
    const m = await next('writing');
    expect(fs.existsSync(m.path)).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    const l = await BackupLock.acquire(layout); // the dead writer's lock is gone
    try {
      expect((await sweepWorkDir(l)).removed).toBe(1);
    } finally {
      l.release();
    }
    expect(fs.existsSync(m.path)).toBe(false);
    expect(fs.readdirSync(layout.workDir)).toEqual(['backup.lock']);
  }, 60_000);
});
