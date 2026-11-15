/**
 * Phase 9A.2: the backup lock and the clean-up of the work folder.
 *
 * BackupLock is an operating-system file lock taken through SQLite on .work/backup.lock:
 *   journal_mode = DELETE (rollback journal, checked), busy timeout 0, then BEGIN EXCLUSIVE, held (with the
 *   connection's open file handle) until release(). The OS releases it when the process ends in any way, so there
 *   is never a stale lock, and process ids (which can be reused) are not involved at all.
 *   POSIX note: no code may open backup.lock except this SQLite connection (closing another handle to the same file
 *   would drop POSIX locks); lstat and realpath do not open it.
 * SQLite journal behaviour: the lock database is never committed to (it stays 0 bytes). Because it is empty, BEGIN
 * EXCLUSIVE makes SQLite prepare its first page, so SQLite creates backup.lock-journal while the lock is held and
 * deletes it at release (ROLLBACK). A journal on disk may therefore belong to a process that holds the lock right now;
 * it is never deleted here. If a holder died, its journal is left behind and SQLite itself rolls it back and removes
 * it when the lock is next taken (it only ever describes an empty database).
 * Before opening, .work must be a verified private folder and backup.lock and an existing backup.lock-journal must be
 * regular files with exactly one name, directly inside it (no symlink, junction or hard link: PATH_REJECTED); after
 * opening, the same checks run again and SQLite must report the expected file.
 *
 * sweepWorkDir removes leftovers in .work (crash or power loss) while the lock is held: only regular files whose
 * names match our temporary-name patterns, never the lock files, never folders, never through links, never
 * recursively, and only after .work has been verified again.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupError } from './errors';
import { removeWithRetry, syncDir, type RetryOptions } from './fsSafe';
import { type BackupLayout, LOCK_FILE_NAME, LOCK_JOURNAL_NAME, PARTIAL_NAME, WORK_NAME, realpathNative, samePath } from './paths';
import { verifyPrivateDir, type PrivateDirOptions } from './privateDir';

/** lock files held by this process (real paths, case-normalised on Windows) */
const heldHere = new Set<string>();
const key = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

async function assertPlainFileOrMissing(p: string): Promise<boolean> {
  let st;
  try { st = await fs.lstat(p); } catch (e: any) {
    if (e?.code === 'ENOENT') return false;
    throw new BackupError('PATH_REJECTED', 'lock');
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new BackupError('PATH_REJECTED', 'lock');
  return true;
}

const isBusy = (e: any) => e?.code === 'SQLITE_BUSY' || e?.code === 'SQLITE_LOCKED';

export interface LockOptions extends PrivateDirOptions { retry?: RetryOptions }

export class BackupLock {
  readonly layout: BackupLayout;
  /** the platform and access-list runner used to verify the private folders (reused when publishing) */
  readonly privateDirOptions: Readonly<PrivateDirOptions>;
  private db: InstanceType<typeof Database> | null;
  private readonly keyPath: string;

  private constructor(layout: BackupLayout, db: InstanceType<typeof Database>, keyPath: string, privateDirOptions: PrivateDirOptions) {
    this.layout = layout; this.db = db; this.keyPath = keyPath;
    this.privateDirOptions = Object.freeze({ platform: privateDirOptions.platform, aclRunner: privateDirOptions.aclRunner, uid: privateDirOptions.uid });
  }

  get held(): boolean { return this.db !== null; }

  /** Take the lock or throw BACKUP_IN_PROGRESS (or PATH_REJECTED / PERMISSIONS_UNVERIFIED). Never waits. */
  static async acquire(layout: BackupLayout, opts: LockOptions = {}): Promise<BackupLock> {
    const platform = opts.platform ?? process.platform;
    const k = key(layout.lockFile, platform);
    if (heldHere.has(k)) throw new BackupError('BACKUP_IN_PROGRESS', 'lock');
    heldHere.add(k); // reserve synchronously: a second call in this process fails fast
    let db: InstanceType<typeof Database> | null = null;
    try {
      await verifyPrivateDir(layout.workDir, opts);
      const journal = path.join(layout.workDir, LOCK_JOURNAL_NAME);
      await assertPlainFileOrMissing(layout.lockFile);
      // an existing journal may belong to an active holder: never delete it; only make sure it is safe for SQLite to use
      await assertPlainFileOrMissing(journal);

      try {
        db = new Database(layout.lockFile, { timeout: 0 });
      } catch (e) {
        throw isBusy(e) ? new BackupError('BACKUP_IN_PROGRESS', 'lock') : new BackupError('WRITE_FAILED', 'lock');
      }
      try {
        const mode = db.pragma('journal_mode = DELETE', { simple: true });
        if (String(mode).toLowerCase() !== 'delete') throw new BackupError('PERMISSIONS_UNVERIFIED', 'lock-journal');
        db.exec('BEGIN EXCLUSIVE');
      } catch (e) {
        if (e instanceof BackupError) throw e;
        throw isBusy(e) ? new BackupError('BACKUP_IN_PROGRESS', 'lock') : new BackupError('WRITE_FAILED', 'lock');
      }
      // after opening: the same file, still a plain single-link file in the verified folder (and so is the journal)
      if (!(await assertPlainFileOrMissing(layout.lockFile))) throw new BackupError('PATH_REJECTED', 'lock');
      await assertPlainFileOrMissing(journal);
      const listed = (db.pragma('database_list') as Array<{ name: string; file: string }>).find((d) => d.name === 'main')?.file ?? '';
      const real = await realpathNative(layout.lockFile).catch(() => '');
      if (!real || !samePath(listed, real, platform) || !samePath(real, layout.lockFile, platform)) throw new BackupError('PATH_REJECTED', 'lock');
      await verifyPrivateDir(layout.workDir, opts);
      if (platform !== 'win32') await fs.chmod(layout.lockFile, 0o600).catch(() => undefined); // inside a 0700 folder anyway
      return new BackupLock(layout, db, k, opts);
    } catch (e) {
      if (db) { try { if (db.inTransaction) db.exec('ROLLBACK'); } catch { /* ignore */ } try { db.close(); } catch { /* ignore */ } }
      heldHere.delete(k);
      throw e instanceof BackupError ? e : new BackupError('WRITE_FAILED', 'lock');
    }
  }

  /** Release the lock (idempotent). */
  release(): void {
    const db = this.db;
    if (!db) return;
    this.db = null;
    try { if (db.inTransaction) db.exec('ROLLBACK'); } catch { /* the OS lock goes with the handle anyway */ }
    try { db.close(); } finally { heldHere.delete(this.keyPath); }
  }
}

export interface SweepResult {
  /** temporary files removed */
  removed: number;
  /** entries left alone because they are not ours or not plain files (folders, links, unknown names) */
  skipped: number;
  /** our temporary files that could not be removed (still locked by another program) */
  failed: number;
}

/**
 * Remove leftover temporary files from .work. Requires the held lock for the same layout. A `.btbackup.partial`
 * that still has a second name is removed only when that second name is a published file in encrypted/ (the
 * cleanup-pending case after publishing); every other file must have exactly one name.
 */
export async function sweepWorkDir(lock: BackupLock, opts: LockOptions = {}): Promise<SweepResult> {
  if (!lock.held) throw new BackupError('BACKUP_IN_PROGRESS', 'sweep');
  const { layout } = lock;
  const platform = opts.platform ?? process.platform;
  await verifyPrivateDir(layout.workDir, opts);
  const workReal = await realpathNative(layout.workDir);
  if (!samePath(workReal, layout.workDir, platform)) throw new BackupError('PATH_REJECTED', 'sweep');

  // identities of published backups, to recognise the second name of a leftover .partial
  const published = new Set<string>();
  try {
    const encSt = await fs.lstat(layout.encryptedDir);
    if (encSt.isDirectory() && !encSt.isSymbolicLink()) {
      for (const e of await fs.readdir(layout.encryptedDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const st = await fs.lstat(path.join(layout.encryptedDir, e.name), { bigint: true }).catch(() => null);
        if (st?.isFile()) published.add(`${st.dev}:${st.ino}`);
      }
    }
  } catch { /* no encrypted folder yet */ }

  const result: SweepResult = { removed: 0, skipped: 0, failed: 0 };
  for (const entry of await fs.readdir(layout.workDir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === LOCK_FILE_NAME || name === LOCK_JOURNAL_NAME) continue;
    if (!WORK_NAME.test(name)) { result.skipped++; continue; }
    const full = path.join(layout.workDir, name);
    if (!samePath(path.dirname(full), workReal, platform)) { result.skipped++; continue; }
    const st = await fs.lstat(full, { bigint: true }).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) { result.skipped++; continue; }
    const secondNameIsPublished = PARTIAL_NAME.test(name) && st.nlink === 2n && published.has(`${st.dev}:${st.ino}`);
    if (st.nlink !== 1n && !secondNameIsPublished) { result.skipped++; continue; }
    try { await removeWithRetry(full, opts.retry); result.removed++; } catch { result.failed++; }
  }
  try { await syncDir(layout.workDir, platform); } catch { /* best effort */ }
  return result;
}
