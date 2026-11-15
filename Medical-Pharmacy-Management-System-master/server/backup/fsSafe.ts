/**
 * Phase 9A.2: safe file operations for backups.
 *
 * - new files are only ever created with 'wx' (fails if the name exists) and mode 0600
 * - finished backups are published with a hard link (fails if the name exists), never with rename/copy, so an
 *   existing file can never be replaced; if the disk cannot make hard links the publish fails (no fallback)
 * - short retries only for errors caused by other programs briefly holding a file (antivirus, indexer):
 *   EPERM, EBUSY, EACCES (and ENOTEMPTY when deleting); about 8 s of waiting in total, then FS_BUSY
 * - free space and size limits are checked before anything is written
 * Error messages are fixed (BackupError); file names and system messages are never put into them.
 */
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BackupError } from './errors';
import {
  type BackupLayout, BACKUP_NAME, MAX_BACKUP_FILE_BYTES, MAX_DATABASE_BYTES, PARTIAL_NAME, WORK_NAME,
  assertNotProtected, newWorkName, resolveInside,
} from './paths';
// lock.ts also imports this module; BackupLock is only used inside functions (never while modules load)
import { BackupLock } from './lock';
import { verifyPrivateDir } from './privateDir';

/** Waits between attempts (ms): 50, 100, 200, 400, 800, then 1600 four times = 7950 ms in total. */
export const RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1600, 1600, 1600, 1600];
export const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const isTransientFsError = (e: unknown, deleting = false): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return !!code && (TRANSIENT.has(code) || (deleting && code === 'ENOTEMPTY'));
};

export interface RetryOptions {
  deleting?: boolean;
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** injectable unlink() for tests (removeWithRetry) */
  unlink?: (file: string) => Promise<void>;
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `op`, retrying only transient lock errors. A non-transient error is rethrown unchanged (the caller maps it);
 * if the lock error persists after every retry, `lastTransient` decides the result (default FS_BUSY).
 */
export async function withFsRetry<T>(op: () => Promise<T>, opts: RetryOptions & { lastTransient?: (e: unknown) => never } = {}): Promise<T> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (!isTransientFsError(e, opts.deleting)) throw e;
      if (attempt >= delays.length) {
        if (opts.lastTransient) opts.lastTransient(e);
        throw new BackupError('FS_BUSY', 'retry');
      }
      await sleep(delays[attempt]);
    }
  }
}

const mapWriteError = (e: unknown, stage: string): BackupError => {
  if (e instanceof BackupError) return e;
  return new BackupError((e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'DISK_SPACE' : 'WRITE_FAILED', stage);
};

/** Remove a file, retrying lock errors; a file that is already gone counts as removed. */
export async function removeWithRetry(file: string, opts: RetryOptions = {}): Promise<void> {
  try {
    const unlink = opts.unlink ?? ((f: string) => fs.unlink(f));
    await withFsRetry(() => unlink(file), { ...opts, deleting: true });
  } catch (e: any) {
    if (e?.code === 'ENOENT') return;
    throw e instanceof BackupError ? e : new BackupError('FS_BUSY', 'remove');
  }
}

export interface CreatedFile { path: string; handle: FileHandle }

/**
 * Files are only created or published while this process holds the backup lock: its acquisition verified .work as a
 * private folder, and the sweep (which also needs the lock) can then never remove a file that is still being used.
 */
function heldLayout(lock: unknown): BackupLayout {
  if (!(lock instanceof BackupLock) || !lock.held) throw new BackupError('BACKUP_IN_PROGRESS', 'lock-required');
  return lock.layout;
}

/**
 * Create a new, empty temporary file in .work with 'wx' (or 'wx+' with readWrite: the encrypted .partial is written
 * and then read back through the same handle) and mode 0600. Requires the held backup lock. The name is random; on
 * the (practically impossible) collision another name is tried, at most 3 times. The target is checked to be inside
 * .work. An existing name is never opened.
 */
export async function createWorkFile(lock: BackupLock, purpose: string, opts: { readWrite?: boolean } = {}): Promise<CreatedFile> {
  const layout = heldLayout(lock);
  for (let i = 0; i < 3; i++) {
    const file = resolveInside(layout.workDir, newWorkName(purpose), WORK_NAME);
    await assertNotProtected(file, layout);
    try {
      return { path: file, handle: await fs.open(file, opts.readWrite ? 'wx+' : 'wx', 0o600) };
    } catch (e: any) {
      if (e?.code === 'EEXIST') continue;
      throw mapWriteError(e, 'create');
    }
  }
  throw new BackupError('WRITE_FAILED', 'create');
}

/** Write the whole buffer (repeating short writes). A full disk becomes DISK_SPACE. */
export async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  try {
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
      if (bytesWritten <= 0) throw new BackupError('WRITE_FAILED', 'write');
      offset += bytesWritten;
    }
  } catch (e) {
    throw mapWriteError(e, 'write');
  }
}

/** Flush the file to disk (fsync / FlushFileBuffers) and close it; the handle is closed even when syncing fails. */
export async function syncAndClose(handle: FileHandle): Promise<void> {
  let failure: BackupError | null = null;
  try { await handle.sync(); } catch (e) { failure = mapWriteError(e, 'sync'); }
  try { await handle.close(); } catch (e) { failure ??= mapWriteError(e, 'close'); }
  if (failure) throw failure;
}

/** POSIX only: make a folder entry (new or removed name) durable. Windows cannot sync folders; NTFS journals them. */
export async function syncDir(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const h = await fs.open(dir, 'r');
  try { await h.sync(); } finally { await h.close(); }
}

export interface PublishResult {
  finalPath: string;
  /** 1 when the temporary name could not be removed after publishing (the next sweep removes it) */
  cleanupPending: number;
}

export interface PublishOptions extends RetryOptions {
  /** injectable link() for tests */
  link?: (existing: string, newPath: string) => Promise<void>;
}

const UNSUPPORTED_LINK = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR', 'EMLINK']);

/**
 * Publish a finished, synced and closed `.btbackup.partial` from .work as encrypted/<name> by creating a hard link.
 * Requires the held backup lock, and encrypted/ must verify as a private folder (checked here, before linking).
 * Never replaces anything: an existing name gives PUBLISH_FAILED; a disk without hard links gives
 * HARDLINK_UNSUPPORTED (on Windows an EPERM that outlasts the retries is a lock held by another program: FS_BUSY).
 * If the link fails nothing is published and the temporary file is removed (if a check before linking fails, the
 * temporary file is left for the sweep). After a successful link the temporary name is removed; if that fails the
 * backup is still published (cleanupPending = 1).
 */
export async function publishByHardLink(lock: BackupLock, tmpPath: string, name: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const layout = heldLayout(lock);
  const platform = lock.privateDirOptions.platform ?? process.platform;
  if (path.dirname(path.resolve(tmpPath)) !== path.resolve(layout.workDir)) throw new BackupError('PATH_REJECTED', 'publish');
  resolveInside(layout.workDir, path.basename(tmpPath), PARTIAL_NAME);
  const finalPath = resolveInside(layout.encryptedDir, name, BACKUP_NAME);
  await assertNotProtected(tmpPath, layout);
  await assertNotProtected(finalPath, layout);
  const st = await fs.lstat(tmpPath).catch(() => null);
  if (!st || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new BackupError('PATH_REJECTED', 'publish');
  await verifyPrivateDir(layout.encryptedDir, lock.privateDirOptions);

  const link = opts.link ?? ((a: string, b: string) => fs.link(a, b));
  try {
    await withFsRetry(() => link(tmpPath, finalPath), {
      ...opts,
      deleting: false,
      // POSIX: an EPERM that never clears is how some file systems (e.g. FAT/exFAT) refuse hard links. Windows reports
      // unsupported disks with other codes, so there a lasting EPERM is a lock held by another program (antivirus).
      lastTransient: (e) => { throw new BackupError((e as any)?.code === 'EPERM' && platform !== 'win32' ? 'HARDLINK_UNSUPPORTED' : 'FS_BUSY', 'publish'); },
    });
  } catch (e: any) {
    await removeWithRetry(tmpPath, { ...opts, unlink: undefined }).catch(() => undefined);
    if (e instanceof BackupError) throw e;
    if (e?.code === 'EEXIST') throw new BackupError('PUBLISH_FAILED', 'publish');
    if (UNSUPPORTED_LINK.has(e?.code)) throw new BackupError('HARDLINK_UNSUPPORTED', 'publish');
    if (e?.code === 'ENOSPC') throw new BackupError('DISK_SPACE', 'publish');
    throw new BackupError('PUBLISH_FAILED', 'publish');
  }
  try { await syncDir(layout.encryptedDir, platform); } catch { /* the link exists; durability of the folder entry is best effort */ }
  let cleanupPending = 0;
  try { await removeWithRetry(tmpPath, opts); } catch { cleanupPending = 1; }
  return { finalPath, cleanupPending };
}

export interface StatfsLike { bavail: number | bigint; bsize: number | bigint }
export type StatfsFn = (dir: string) => Promise<StatfsLike>;
const defaultStatfs: StatfsFn = (dir) => fs.statfs(dir);

/** Bytes needed to back up a database of this size: 2 x (database + WAL) + 256 MiB. */
export const requiredFreeBytes = (databaseBytes: number) => 2 * databaseBytes + FREE_SPACE_MARGIN_BYTES;

/** Size of the live database plus its WAL; FILE_TOO_LARGE above MAX_DATABASE_BYTES. */
export async function databaseBytes(dbFile: string): Promise<number> {
  const size = async (p: string) => { try { return (await fs.stat(p)).size; } catch (e: any) { if (e?.code === 'ENOENT') return 0; throw new BackupError('WRITE_FAILED', 'size'); } };
  const total = (await size(dbFile)) + (await size(`${dbFile}-wal`));
  if (total > MAX_DATABASE_BYTES) throw new BackupError('FILE_TOO_LARGE', 'size');
  return total;
}

/** DISK_SPACE unless `dir` has at least `needed` bytes free. If free space cannot be read, also DISK_SPACE (fail closed). */
export async function checkFreeSpace(dir: string, needed: number, statfs: StatfsFn = defaultStatfs): Promise<void> {
  let free: number;
  try {
    const s = await statfs(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    throw new BackupError('DISK_SPACE', 'space-unknown');
  }
  if (!Number.isFinite(free) || free < needed) throw new BackupError('DISK_SPACE', 'space');
}

/** Check the live database size and the free space in .work before a backup starts. */
export async function checkBackupSpace(layout: BackupLayout, statfs: StatfsFn = defaultStatfs): Promise<{ databaseBytes: number; requiredBytes: number }> {
  const db = await databaseBytes(layout.dbFile);
  const requiredBytes = requiredFreeBytes(db);
  await checkFreeSpace(layout.workDir, requiredBytes, statfs);
  return { databaseBytes: db, requiredBytes };
}

/** Before reading a backup file: it must be a regular file no larger than MAX_BACKUP_FILE_BYTES (no bytes are read). */
export async function checkBackupFileSize(handle: Pick<FileHandle, 'stat'>, max = MAX_BACKUP_FILE_BYTES): Promise<number> {
  let st;
  try { st = await handle.stat(); } catch { throw new BackupError('PATH_REJECTED', 'size'); }
  if (!st.isFile()) throw new BackupError('PATH_REJECTED', 'size');
  if (st.size > max) throw new BackupError('FILE_TOO_LARGE', 'size');
  return st.size;
}
