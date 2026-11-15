/**
 * Phase 9A.2: backup folder layout, file names, path checks and size limits.
 *
 *   <dataDir>/backups/              existing folder (pre-migration / pre-restore *.sqlite copies stay untouched)
 *   <dataDir>/backups/encrypted/    finished .btbackup files (private folder)
 *   <dataDir>/backups/.work/        in-progress files and the lock database (private folder)
 *
 * All names are generated here and checked against strict patterns; no caller-supplied path is ever joined in.
 * Paths are compared after resolving real paths, case-insensitively on Windows.
 */
import crypto from 'node:crypto';
import { realpath as realpathCb } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { BackupError } from './errors';
import { FRAME_HEADER_BYTES, MAC_BYTES, MAX_HEADER_BYTES, MAX_MANIFEST_BYTES, MIN_CHUNK_SIZE, PREAMBLE_BYTES, TAG_BYTES } from './format';

export interface BackupLayout {
  dataDir: string;
  dbFile: string;
  backupsDir: string;
  encryptedDir: string;
  workDir: string;
  lockFile: string;
}

export const LOCK_FILE_NAME = 'backup.lock';
export const LOCK_JOURNAL_NAME = `${LOCK_FILE_NAME}-journal`;

/** Largest database (main file + WAL) that will be backed up. */
export const MAX_DATABASE_BYTES = 4 * 1024 ** 3;
/**
 * Largest .btbackup file accepted for reading: MAX_DATABASE_BYTES of data plus the worst-case format overhead
 * (largest header, one record per smallest chunk, largest manifest).
 */
export const MAX_BACKUP_FILE_BYTES = PREAMBLE_BYTES + MAX_HEADER_BYTES + MAC_BYTES
  + Math.ceil(MAX_DATABASE_BYTES / MIN_CHUNK_SIZE) * (FRAME_HEADER_BYTES + TAG_BYTES) + MAX_DATABASE_BYTES
  + FRAME_HEADER_BYTES + MAX_MANIFEST_BYTES + TAG_BYTES;

const KIND = /^[a-z][a-z0-9]{0,15}$/;
const PURPOSE = KIND;
export const BACKUP_NAME = /^[a-z][a-z0-9]{0,15}-\d{8}T\d{6}Z-[0-9a-f]{8}\.btbackup$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** temporary names inside .work, including SQLite's side files of a temporary database */
export const WORK_NAME = new RegExp(`^${UUID}\\.(?:[a-z][a-z0-9]{0,15}\\.tmp|btbackup\\.partial)(?:-journal|-wal|-shm)?$`);
export const PARTIAL_NAME = new RegExp(`^${UUID}\\.btbackup\\.partial$`);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** fs.realpath.native (resolves symlinks, junctions, 8.3 short names and the real letter case on Windows) */
export const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);

const isWin = (platform: NodeJS.Platform) => platform === 'win32';
/** compare two absolute paths (case-insensitively on Windows) */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const pa = path.resolve(a); const pb = path.resolve(b);
  return isWin(platform) ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}
/** true when child is base itself or inside it */
export function isInside(base: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => (isWin(platform) ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(base), norm(child));
  // only the parent-folder step itself ('..' or '../...') leaves base; a child name may start with '..'
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function backupLayout(dataDir: string, dbFile: string): BackupLayout {
  if (typeof dataDir !== 'string' || typeof dbFile !== 'string' || !path.isAbsolute(dataDir) || !path.isAbsolute(dbFile)) throw new BackupError('PATH_REJECTED', 'layout');
  const data = path.resolve(dataDir);
  const backupsDir = path.join(data, 'backups');
  const workDir = path.join(backupsDir, '.work');
  return { dataDir: data, dbFile: path.resolve(dbFile), backupsDir, encryptedDir: path.join(backupsDir, 'encrypted'), workDir, lockFile: path.join(workDir, LOCK_FILE_NAME) };
}

/** Throws PATH_REJECTED unless `name` is a single safe file name matching `pattern`. */
export function assertSafeName(name: unknown, pattern: RegExp): asserts name is string {
  const ok = typeof name === 'string' && name.length > 0 && name.length <= 128 && pattern.test(name)
    && !/[\\/:\0]/.test(name) && !/[. ]$/.test(name) && !WINDOWS_RESERVED.test(name.split('.')[0]);
  if (!ok) throw new BackupError('PATH_REJECTED', 'name');
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20261115T123456Z

export function newBackupName(kind: string, at: Date = new Date()): string {
  if (typeof kind !== 'string' || !KIND.test(kind) || Number.isNaN(at.getTime())) throw new BackupError('PATH_REJECTED', 'name');
  const name = `${kind}-${stamp(at)}-${crypto.randomBytes(4).toString('hex')}.btbackup`;
  assertSafeName(name, BACKUP_NAME);
  return name;
}

export function newWorkName(purpose: string): string {
  if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) throw new BackupError('PATH_REJECTED', 'name');
  const name = purpose === 'btbackup' ? `${crypto.randomUUID()}.btbackup.partial` : `${crypto.randomUUID()}.${purpose}.tmp`;
  assertSafeName(name, WORK_NAME);
  return name;
}

/** Join a checked name to a base folder; the result is always directly inside base. */
export function resolveInside(base: string, name: unknown, pattern: RegExp): string {
  assertSafeName(name, pattern);
  const full = path.join(base, name);
  if (path.dirname(full) !== path.resolve(base)) throw new BackupError('PATH_REJECTED', 'name');
  return full;
}

/** The real path, or the plain resolved path only when it does not exist (any other error: PATH_REJECTED). */
async function realOrResolved(p: string): Promise<string> {
  try { return await realpathNative(p); } catch (e: any) {
    if (e?.code === 'ENOENT') return path.resolve(p);
    throw new BackupError('PATH_REJECTED', 'path');
  }
}

/** The real path of an existing target, or of its (existing) parent plus its name. */
async function realTarget(target: string): Promise<string> {
  try { return await realpathNative(target); } catch (e: any) {
    if (e?.code !== 'ENOENT') throw new BackupError('PATH_REJECTED', 'path');
    return path.join(await realOrResolved(path.dirname(target)), path.basename(target));
  }
}

/**
 * Throws PATH_REJECTED unless `target` lies inside the encrypted/ or .work/ folder (real paths) and is not the live
 * database or one of its -wal/-shm/-journal files (also compared by real path, case-insensitively on Windows).
 */
export async function assertNotProtected(target: string, layout: BackupLayout, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new BackupError('PATH_REJECTED', 'path');
  const real = await realTarget(target);
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const p = `${layout.dbFile}${ext}`;
    if (samePath(real, await realOrResolved(p), platform) || samePath(path.resolve(target), p, platform)) throw new BackupError('PATH_REJECTED', 'protected');
  }
  const allowed = [await realOrResolved(layout.encryptedDir), await realOrResolved(layout.workDir)];
  if (!allowed.some((dir) => isInside(dir, real, platform) && !samePath(dir, real, platform))) throw new BackupError('PATH_REJECTED', 'protected');
}
