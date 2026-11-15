/**
 * Phase 9A.2: safe file operations (server/backup/fsSafe.ts): exclusive creation, hard-link publishing (never
 * replacing anything), retries, disk space, size limits, and the live database staying untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  FREE_SPACE_MARGIN_BYTES, RETRY_DELAYS_MS, checkBackupFileSize, checkBackupSpace, checkFreeSpace, createWorkFile, databaseBytes,
  isTransientFsError, publishByHardLink, removeWithRetry, requiredFreeBytes, syncAndClose, withFsRetry, writeAll,
} from '../../server/backup/fsSafe';
import { MAX_BACKUP_FILE_BYTES, MAX_DATABASE_BYTES, backupLayout, newBackupName, newWorkName, type BackupLayout } from '../../server/backup/paths';
import { ensurePrivateDir, type AclRunner } from '../../server/backup/privateDir';
import { BackupLock } from '../../server/backup/lock';
import { BackupError } from '../../server/backup/errors';

const isWin = process.platform === 'win32';
let root: string;
let layout: BackupLayout;
let lock: BackupLock;
const noSleep = { sleep: async () => undefined };
const err = (code: string) => Object.assign(new Error(code), { code });
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fs-')));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  fs.mkdirSync(layout.backupsDir, { recursive: true });
  await ensurePrivateDir(layout.workDir);
  await ensurePrivateDir(layout.encryptedDir);
  lock = await BackupLock.acquire(layout);
}, 60_000);
afterEach(() => { lock?.release(); fs.rmSync(root, { recursive: true, force: true }); });

async function partialFile(content: Buffer): Promise<string> {
  const f = await createWorkFile(lock, 'btbackup');
  await writeAll(f.handle, content);
  await syncAndClose(f.handle);
  return f.path;
}

describe('retries', () => {
  it('retries only EPERM/EBUSY/EACCES (and ENOTEMPTY when deleting), with the approved waits', async () => {
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(7950);
    expect(['EPERM', 'EBUSY', 'EACCES'].every((c) => isTransientFsError(err(c)))).toBe(true);
    expect(isTransientFsError(err('ENOTEMPTY'))).toBe(false);
    expect(isTransientFsError(err('ENOTEMPTY'), true)).toBe(true);
    for (const c of ['ENOENT', 'EEXIST', 'ENOSPC', 'EROFS', 'EISDIR']) expect(isTransientFsError(err(c), true)).toBe(false);

    const waits: number[] = [];
    let n = 0;
    const v = await withFsRetry(async () => { if (n++ < 3) throw err('EBUSY'); return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
    expect(v).toBe('ok');
    expect(waits).toEqual([50, 100, 200]);
  });

  it('gives up with FS_BUSY after the last wait; other errors are not retried', async () => {
    const waits: number[] = [];
    await expect(withFsRetry(async () => { throw err('EPERM'); }, { sleep: async (ms) => { waits.push(ms); } })).rejects.toMatchObject({ code: 'FS_BUSY' });
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    let calls = 0;
    await expect(withFsRetry(async () => { calls++; throw err('ENOENT'); }, noSleep)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });

  it('removeWithRetry: a missing file is fine; a locked file is retried; a file that stays locked is FS_BUSY', async () => {
    await removeWithRetry(path.join(layout.workDir, 'missing'));
    let n = 0;
    await removeWithRetry('/x', { ...noSleep, unlink: async () => { if (n++ < 2) throw err('EBUSY'); } });
    expect(n).toBe(3);
    await expect(removeWithRetry('/x', { ...noSleep, unlink: async () => { throw err('ENOTEMPTY'); } })).rejects.toMatchObject({ code: 'FS_BUSY' });
  });
});

describe('exclusive creation and writing', () => {
  it('creates new files with random names inside .work, mode 0600 on POSIX; never opens an existing name', async () => {
    const f = await createWorkFile(lock, 'snapshot');
    expect(path.dirname(f.path)).toBe(layout.workDir);
    await writeAll(f.handle, Buffer.from('hello'));
    await syncAndClose(f.handle);
    expect(fs.readFileSync(f.path, 'utf8')).toBe('hello');
    if (!isWin) expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
    await expect(fs.promises.open(f.path, 'wx')).rejects.toMatchObject({ code: 'EEXIST' }); // the flag used by createWorkFile
    expect(fs.readFileSync(f.path, 'utf8')).toBe('hello');
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) { const g = await createWorkFile(lock, 'snapshot'); names.add(g.path); await g.handle.close(); }
    expect(names.size).toBe(200);
  });

  it('a full disk while writing is DISK_SPACE; other write errors are WRITE_FAILED; the handle is closed even when sync fails', async () => {
    const fake = (code: string) => ({ write: async () => { throw err(code); } }) as any;
    await expect(writeAll(fake('ENOSPC'), Buffer.from('x'))).rejects.toMatchObject({ code: 'DISK_SPACE' });
    await expect(writeAll(fake('EIO'), Buffer.from('x'))).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    let closed = false;
    const h = { sync: async () => { throw err('ENOSPC'); }, close: async () => { closed = true; } } as any;
    await expect(syncAndClose(h)).rejects.toMatchObject({ code: 'DISK_SPACE' });
    expect(closed).toBe(true);
    // a short write is completed by further writes
    const chunks: number[] = [];
    const short = { write: async (_b: Buffer, _o: number, len: number) => { const n = Math.min(3, len); chunks.push(n); return { bytesWritten: n }; } } as any;
    await writeAll(short, Buffer.alloc(10));
    expect(chunks).toEqual([3, 3, 3, 1]);
  });
});

describe('publishing by hard link', () => {
  it('publishes the exact bytes as encrypted/<name> and removes the temporary name', async () => {
    const content = crypto.randomBytes(100_000);
    const tmp = await partialFile(content);
    const name = newBackupName('manual');
    const r = await publishByHardLink(lock, tmp, name);
    expect(r).toEqual({ finalPath: path.join(layout.encryptedDir, name), cleanupPending: 0 });
    expect(fs.readFileSync(r.finalPath).equals(content)).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.statSync(r.finalPath).nlink).toBe(1);
  });

  it('never replaces an existing backup: PUBLISH_FAILED, the existing file unchanged, the temporary file removed', async () => {
    const name = newBackupName('manual');
    const existing = path.join(layout.encryptedDir, name);
    fs.writeFileSync(existing, 'EXISTING');
    const tmp = await partialFile(Buffer.from('NEW'));
    await expect(publishByHardLink(lock, tmp, name)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(fs.readFileSync(existing, 'utf8')).toBe('EXISTING');
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('a disk without hard links fails safely (HARDLINK_UNSUPPORTED): nothing published, temporary file removed, no fallback', async () => {
    for (const code of isWin ? ['ENOTSUP', 'EXDEV', 'ENOSYS'] : ['ENOTSUP', 'EXDEV', 'ENOSYS', 'EPERM']) {
      const tmp = await partialFile(Buffer.from('data'));
      const name = newBackupName('manual');
      let calls = 0;
      await expect(publishByHardLink(lock, tmp, name, { ...noSleep, link: async () => { calls++; throw err(code); } })).rejects.toMatchObject({ code: 'HARDLINK_UNSUPPORTED' });
      expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
      expect(fs.existsSync(tmp)).toBe(false);
      expect(calls).toBe(code === 'EPERM' ? RETRY_DELAYS_MS.length + 1 : 1); // EPERM may be a passing lock, so it is retried first
    }
  });

  it('a link that is locked for a while (antivirus) succeeds after retries', async () => {
    const tmp = await partialFile(Buffer.from('data'));
    let n = 0;
    const r = await publishByHardLink(lock, tmp, newBackupName('manual'), { ...noSleep, link: async (a, b) => { if (n++ < 2) throw err('EBUSY'); await fs.promises.link(a, b); } });
    expect(fs.readFileSync(r.finalPath, 'utf8')).toBe('data');
  });

  it('if the temporary name cannot be removed after linking, the backup is still published with cleanupPending = 1', async () => {
    const tmp = await partialFile(Buffer.from('data'));
    const r = await publishByHardLink(lock, tmp, newBackupName('manual'), { ...noSleep, unlink: async () => { throw err('EBUSY'); } });
    expect(r.cleanupPending).toBe(1);
    expect(fs.readFileSync(r.finalPath, 'utf8')).toBe('data');
    expect(fs.existsSync(tmp)).toBe(true); // left for the next sweep (see backup-lock.test.ts)
    expect(fs.statSync(tmp).nlink).toBe(2);
  });

  it('refuses unsafe inputs before doing anything', async () => {
    const tmp = await partialFile(Buffer.from('data'));
    const reject = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await reject(publishByHardLink(lock, tmp, '../pharmacy.sqlite'));
    await reject(publishByHardLink(lock, tmp, 'manual.btbackup'));
    const outside = path.join(root, `${crypto.randomUUID()}.btbackup.partial`);
    fs.writeFileSync(outside, 'x');
    await reject(publishByHardLink(lock, outside, newBackupName('manual')));
    const snap = await createWorkFile(lock, 'snapshot'); await snap.handle.close();
    await reject(publishByHardLink(lock, snap.path, newBackupName('manual'))); // a plaintext snapshot can never be published
    fs.linkSync(tmp, path.join(layout.workDir, `${crypto.randomUUID()}.btbackup.partial`));
    await reject(publishByHardLink(lock, tmp, newBackupName('manual'))); // a temporary file with a second name
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  });
});

describe('disk space and size limits', () => {
  it('requires 2 x (database + WAL) + 256 MiB free; unknown free space fails closed', async () => {
    expect(requiredFreeBytes(1000)).toBe(2000 + FREE_SPACE_MARGIN_BYTES);
    const statfs = (bytes: number) => async () => ({ bavail: bytes / 4096, bsize: 4096 });
    await checkFreeSpace(layout.workDir, 4096 * 10, statfs(4096 * 10));
    await expect(checkFreeSpace(layout.workDir, 4096 * 10 + 1, statfs(4096 * 10))).rejects.toMatchObject({ code: 'DISK_SPACE' });
    await expect(checkFreeSpace(layout.workDir, 1, async () => { throw err('ENOSYS'); })).rejects.toMatchObject({ code: 'DISK_SPACE' });
    await checkFreeSpace(layout.workDir, 1); // the real fs.statfs works here

    fs.writeFileSync(layout.dbFile, Buffer.alloc(3000));
    fs.writeFileSync(`${layout.dbFile}-wal`, Buffer.alloc(1000));
    expect(await databaseBytes(layout.dbFile)).toBe(4000);
    const need = 2 * 4000 + FREE_SPACE_MARGIN_BYTES;
    expect(await checkBackupSpace(layout, async () => ({ bavail: BigInt(need), bsize: 1n }))).toEqual({ databaseBytes: 4000, requiredBytes: need });
    await expect(checkBackupSpace(layout, async () => ({ bavail: BigInt(need - 1), bsize: 1n }))).rejects.toMatchObject({ code: 'DISK_SPACE' });
  });

  it.skipIf(isWin)('a database (main + WAL) over 4 GiB is FILE_TOO_LARGE (sparse files, nothing is allocated)', async () => {
    fs.writeFileSync(layout.dbFile, '');
    fs.truncateSync(layout.dbFile, MAX_DATABASE_BYTES);
    expect(await databaseBytes(layout.dbFile)).toBe(MAX_DATABASE_BYTES); // exactly the limit is accepted
    fs.writeFileSync(`${layout.dbFile}-wal`, 'x');
    await expect(databaseBytes(layout.dbFile)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('a backup file over the limit is refused from its size alone, before any byte is read', async () => {
    let reads = 0;
    const fake = (size: number, isFile = true) => ({ stat: async () => ({ size, isFile: () => isFile }), read: async () => { reads++; } }) as any;
    expect(await checkBackupFileSize(fake(MAX_BACKUP_FILE_BYTES))).toBe(MAX_BACKUP_FILE_BYTES);
    await expect(checkBackupFileSize(fake(MAX_BACKUP_FILE_BYTES + 1))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(checkBackupFileSize(fake(10, false))).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    expect(reads).toBe(0);
    const tmp = await partialFile(Buffer.alloc(123));
    const h = await fs.promises.open(tmp, 'r');
    try { expect(await checkBackupFileSize(h)).toBe(123); } finally { await h.close(); }
  });
});

describe('the live database and existing backups are never touched', () => {
  it('a complete create / write / publish cycle leaves the database, its WAL and legacy backups byte-identical', async () => {
    const live = new Database(layout.dbFile);
    live.pragma('journal_mode = WAL');
    live.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('keep me')");
    const legacy = path.join(layout.backupsDir, 'pre-migration-v1-to-v2-x.sqlite');
    fs.writeFileSync(legacy, 'legacy backup');
    const watched = [layout.dbFile, `${layout.dbFile}-wal`, legacy];
    const before = watched.map((p) => ({ p, sha: sha(p), size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs }));

    const snap = await createWorkFile(lock, 'snapshot');
    await writeAll(snap.handle, Buffer.from('plaintext snapshot'));
    await syncAndClose(snap.handle);
    const tmp = await partialFile(crypto.randomBytes(5000));
    await publishByHardLink(lock, tmp, newBackupName('manual'));
    await removeWithRetry(snap.path);

    for (const b of before) {
      expect(sha(b.p), b.p).toBe(b.sha);
      expect(fs.statSync(b.p).size).toBe(b.size);
      expect(fs.statSync(b.p).mtimeMs).toBe(b.mtime);
    }
    expect(live.prepare('SELECT a FROM t').get()).toEqual({ a: 'keep me' });
    live.close();
    expect(fs.readdirSync(layout.workDir).filter((n) => !n.startsWith('backup.lock'))).toEqual([]); // only the held lock's own files remain
    expect(fs.readdirSync(layout.encryptedDir)).toHaveLength(1);
  });

  it('no operation can target the database: names are generated and paths outside the private folders are refused', async () => {
    fs.writeFileSync(layout.dbFile, 'db');
    await expect(publishByHardLink(lock, layout.dbFile, newBackupName('manual'))).rejects.toBeInstanceOf(BackupError);
    expect(() => newWorkName('../pharmacy')).toThrow(BackupError);
    expect(fs.readFileSync(layout.dbFile, 'utf8')).toBe('db');
  });
});

describe('the backup lock is required (review finding M1)', () => {
  it('createWorkFile and publishByHardLink refuse a released lock, a layout and a look-alike object; nothing is created or published', async () => {
    const tmp = await partialFile(Buffer.from('data'));
    const fake = { held: true, layout, privateDirOptions: {} } as any;
    lock.release();
    const before = fs.readdirSync(layout.workDir).sort();
    for (const l of [lock, layout as any, fake, null as any, undefined as any]) {
      await expect(createWorkFile(l, 'snapshot')).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
      await expect(publishByHardLink(l, tmp, newBackupName('manual'))).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    }
    expect(fs.readdirSync(layout.workDir).sort()).toEqual(before);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it.skipIf(isWin)('publishing refuses an encrypted/ folder that is not private (verified before linking)', async () => {
    const tmp = await partialFile(Buffer.from('data'));
    fs.chmodSync(layout.encryptedDir, 0o755);
    await expect(publishByHardLink(lock, tmp, newBackupName('manual'))).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
    fs.rmSync(layout.encryptedDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere'), { mode: 0o700 });
    fs.symlinkSync(path.join(root, 'elsewhere'), layout.encryptedDir);
    await expect(publishByHardLink(lock, tmp, newBackupName('manual'))).rejects.toBeInstanceOf(BackupError);
    expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual([]);
  });
});

describe('Windows rules with an injected access-list runner (run on every platform)', () => {
  const USER = 'S-1-5-21-1-2-3-1001';
  const good = JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, reparse: false });
  const bad = JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: `D:AI(A;OICIID;FA;;;BU)`, reparse: false });
  async function winLock(encryptedPrivate: boolean): Promise<BackupLock> {
    lock.release();
    const runner: AclRunner = async (_s, target) => (target === layout.encryptedDir && !encryptedPrivate ? bad : good);
    return BackupLock.acquire(layout, { platform: 'win32', aclRunner: runner });
  }

  it('publishing checks encrypted/ with the same runner and refuses it when the read-back is wrong', async () => {
    lock = await winLock(false);
    const tmp = await partialFile(Buffer.from('data'));
    await expect(publishByHardLink(lock, tmp, newBackupName('manual'))).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
  });

  it('L1: on Windows an EPERM that outlasts the retries is FS_BUSY (a lock held by another program), not HARDLINK_UNSUPPORTED', async () => {
    lock = await winLock(true);
    const tmp = await partialFile(Buffer.from('data'));
    let calls = 0;
    await expect(publishByHardLink(lock, tmp, newBackupName('manual'), { ...noSleep, link: async () => { calls++; throw err('EPERM'); } })).rejects.toMatchObject({ code: 'FS_BUSY' });
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(fs.readdirSync(layout.encryptedDir)).toEqual([]);
    // codes that really mean "no hard links" are still HARDLINK_UNSUPPORTED on Windows
    const tmp2 = await partialFile(Buffer.from('data'));
    await expect(publishByHardLink(lock, tmp2, newBackupName('manual'), { ...noSleep, link: async () => { throw err('ENOTSUP'); } })).rejects.toMatchObject({ code: 'HARDLINK_UNSUPPORTED' });
  });
});
