/**
 * Phase 9A.3: consistent SQLite snapshot of the live database (runs in the backup worker).
 *
 * - The live database is opened through a SEPARATE, read-only connection (never the server's connection) and copied
 *   with SQLite's online backup API in ONE step (the progress callback asks for all pages at once). One step is one
 *   read transaction: in WAL mode the server keeps writing, nothing is blocked, the backup never restarts, and the
 *   copy holds exactly the data committed when it started. The live database is never written.
 * - The copy goes into an EMPTY file created beforehand by the engine in the private .work folder (its own access
 *   rights already verified), so plaintext never lands anywhere else; SQLite's side files (-journal, -wal, -shm) are
 *   created next to it, inside .work too, and are checked to be gone afterwards.
 * - The copy is converted to journal_mode=DELETE so the snapshot is one self-contained file, then checked:
 *   integrity_check, the pharmacy tables (users, products), size = page_size x page_count, at most 4 GiB.
 * Nothing here logs; errors are BackupErrors with fixed messages.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import { DbAdapter } from '../db/adapter';
import { currentVersion } from '../db/migrate';
import { BackupError } from './errors';
import { MAX_DATABASE_BYTES } from './paths';

export const SQLITE_SIDECARS = ['-journal', '-wal', '-shm'] as const;
const REQUIRED_TABLES = ['users', 'products'];
const ALL_PAGES = 0x7fffffff;

export interface SnapshotFacts {
  bytes: number;
  pageSize: number;
  pageCount: number;
  schemaVersion: number;
  sqliteVersion: string;
  rowCounts: Record<string, number>;
}

const sqliteCode = (e: unknown) => String((e as { code?: unknown })?.code ?? '');
export function mapSqliteError(e: unknown, stage: string): BackupError {
  if (e instanceof BackupError) return e;
  const code = sqliteCode(e);
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return new BackupError('DISK_SPACE', stage);
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return new BackupError('SNAPSHOT_FAILED', 'busy');
  return new BackupError('SNAPSHOT_FAILED', stage);
}

/** a plain regular file with one name (never a link), or missing */
async function lstatPlain(p: string): Promise<'missing' | 'file'> {
  let st;
  try { st = await fs.lstat(p); } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    throw new BackupError('PATH_REJECTED', 'snapshot');
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new BackupError('PATH_REJECTED', 'snapshot');
  return 'file';
}

/** Throws unless none of the snapshot's SQLite side files exist (and none is a link). */
export async function assertNoSidecars(snapshotPath: string): Promise<void> {
  for (const ext of SQLITE_SIDECARS) {
    if ((await lstatPlain(`${snapshotPath}${ext}`)) !== 'missing') throw new BackupError('SNAPSHOT_FAILED', 'sidecar');
  }
}

/**
 * Copy the live database into `snapshotPath` (an existing, empty, private file) and make it self-contained.
 * Returns the number of pages copied. DISK_SPACE when the disk is full; SNAPSHOT_FAILED ('busy', 'copy', 'journal',
 * 'sidecar') otherwise.
 * Note: when the source is locked, better-sqlite3's backup() RESOLVES with {totalPages: 0} and copies nothing
 * (verified), so the result is checked explicitly; a read first waits (busy timeout) for a short lock to clear.
 */
export async function snapshotDatabase(dbFile: string, snapshotPath: string, opts: { busyTimeoutMs?: number } = {}): Promise<{ pages: number }> {
  const live = await fs.lstat(dbFile).catch(() => null);
  if (!live || !live.isFile()) throw new BackupError('SNAPSHOT_FAILED', 'source');
  if ((await lstatPlain(snapshotPath)) !== 'file' || (await fs.stat(snapshotPath)).size !== 0) throw new BackupError('PATH_REJECTED', 'snapshot');
  await assertNoSidecars(snapshotPath);

  let src: InstanceType<typeof Database> | null = null;
  let pages = 0;
  try {
    src = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000)) });
    src.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get(); // waits up to the busy timeout for a lock held elsewhere
    const progress = await src.backup(snapshotPath, { progress: () => ALL_PAGES });
    pages = Number(progress?.totalPages);
    if (!Number.isSafeInteger(pages) || pages <= 0 || progress?.remainingPages !== 0) throw new BackupError('SNAPSHOT_FAILED', 'busy');
  } catch (e) {
    throw mapSqliteError(e, 'copy');
  } finally {
    try { src?.close(); } catch { /* the read connection only */ }
  }

  // the copy keeps the source's WAL mode: switch it to a single self-contained rollback-journal file
  let dst: InstanceType<typeof Database> | null = null;
  try {
    if ((await lstatPlain(snapshotPath)) !== 'file') throw new BackupError('SNAPSHOT_FAILED', 'copy');
    dst = new Database(snapshotPath, { fileMustExist: true, timeout: 0 });
    const mode = dst.pragma('journal_mode = DELETE', { simple: true });
    if (String(mode).toLowerCase() !== 'delete') throw new BackupError('SNAPSHOT_FAILED', 'journal');
  } catch (e) {
    throw mapSqliteError(e, 'journal');
  } finally {
    try { dst?.close(); } catch { /* reported by the side-file check below */ }
  }
  await assertNoSidecars(snapshotPath);
  return { pages };
}

/**
 * Check the snapshot and measure the facts the encrypted backup is later verified against.
 * FILE_TOO_LARGE over 4 GiB; SNAPSHOT_FAILED ('integrity', 'not-pharmacy', 'size', 'inspect') otherwise.
 */
export async function inspectSnapshot(snapshotPath: string): Promise<SnapshotFacts> {
  if ((await lstatPlain(snapshotPath)) !== 'file') throw new BackupError('SNAPSHOT_FAILED', 'inspect');
  const bytes = (await fs.stat(snapshotPath)).size;
  if (bytes > MAX_DATABASE_BYTES) throw new BackupError('FILE_TOO_LARGE', 'snapshot');
  let db: DbAdapter | null = null;
  let facts: SnapshotFacts;
  try {
    db = DbAdapter.open(snapshotPath, { readonly: true, busyTimeoutMs: 0 });
    if (db.integrityCheck().length) throw new BackupError('SNAPSHOT_FAILED', 'integrity');
    const tables = db.tableNames();
    if (!REQUIRED_TABLES.every((t) => tables.includes(t))) throw new BackupError('SNAPSHOT_FAILED', 'not-pharmacy');
    // DbAdapter.pragma returns the single value (simple mode)
    const pageSize = Number(db.pragma<number>('page_size'));
    const pageCount = Number(db.pragma<number>('page_count'));
    const journal = String(db.pragma<string>('journal_mode')).toLowerCase();
    if (journal !== 'delete') throw new BackupError('SNAPSHOT_FAILED', 'journal');
    if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(pageCount) || pageSize * pageCount !== bytes) throw new BackupError('SNAPSHOT_FAILED', 'size');
    const sqliteVersion = String(db.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? '');
    facts = { bytes, pageSize, pageCount, schemaVersion: currentVersion(db), sqliteVersion, rowCounts: db.rowCounts() };
  } catch (e) {
    throw mapSqliteError(e, 'inspect');
  } finally {
    try { db?.close(); } catch { /* read-only */ }
  }
  await assertNoSidecars(snapshotPath);
  return facts;
}
