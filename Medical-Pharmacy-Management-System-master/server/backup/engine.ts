/**
 * Phase 9A.3: the encrypted backup engine (library only; wired into the server in Phase 9A.4).
 *
 * createBackup (main thread holds the backup lock for the whole operation):
 *   1  validate options; private folders .work/ and encrypted/ (created/tightened and verified)
 *   2  take the backup lock; sweep leftovers of earlier crashes (including plaintext snapshots) from .work
 *   3  check database size (<= 4 GiB) and free space (2 x (database + WAL) + 256 MiB)
 *   4  create the empty snapshot file and the .partial ('wx' / 'wx+'), and verify EACH file's own access rights
 *      before any plaintext is written
 *   5  one worker thread: snapshot (own read-only connection, one step), checks, KDF, streaming encryption into the
 *      .partial (file descriptor), full read-back verification against independently measured facts
 *   6  after the worker has fully stopped: delete the plaintext snapshot and its SQLite side files, then publish the
 *      verified .partial into encrypted/ with a hard link (never replacing anything)
 *   7  on every failure path: the worker is stopped first, then the snapshot (+ side files) and the unpublished
 *      .partial are deleted, still under the lock; then the lock is released
 * Nothing is logged here; errors are BackupErrors with fixed messages. The password is handed to the worker once.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { BackupError } from './errors';
import { DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, type BackupHeaderInfo, type BackupManifest } from './format';
import {
  checkBackupSpace, createWorkFile, publishByHardLink, removeWithRetry, syncAndClose, type CreatedFile, type PublishOptions,
  type RetryOptions, type StatfsFn,
} from './fsSafe';
import { assertKdfParams, DEFAULT_KDF, type ScryptParams } from './kdf';
import { BackupLock, sweepWorkDir, type SweepResult } from './lock';
import { backupLayout, MAX_BACKUP_FILE_BYTES, MAX_DATABASE_BYTES, newBackupName } from './paths';
import { ensurePrivateDir, verifyPrivateFile, type PrivateDirOptions } from './privateDir';
import { SQLITE_SIDECARS } from './snapshot';
import { parseWorkerMessage, type CreateFacts, type VerifyFacts, type WorkerJob, type WorkerStage } from './workerProtocol';

export const BACKUP_KINDS = ['manual', 'scheduled', 'prerestore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120 * 1000;
/**
 * Limits for the worker's JavaScript heap only. Native memory is NOT covered by this: scrypt needs 128 MiB with
 * DEFAULT_KDF (at most 256 MiB within KDF_BOUNDS), SQLite's page cache a few MiB per connection, plus streaming
 * buffers of a few chunks (1 MiB each). Expected worst case for the whole worker is well under 512 MiB.
 */
export const WORKER_RESOURCE_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };
const APP_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;

export interface WorkerEntry { file: string; execArgv: string[]; workerData?: Record<string, unknown> }

/** The worker script: next to the bundle as backup-worker.cjs, or worker.ts through the tsx loader (development, tests). */
export function defaultWorkerEntry(): WorkerEntry {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.cjs')) return { file: path.join(path.dirname(here), 'backup-worker.cjs'), execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { file: path.join(path.dirname(here), 'worker.ts'), execArgv: ['--import', tsx] };
}

export interface BackupProgress { stage: WorkerStage | 'prepare' | 'publish'; bytesDone: number; bytesTotal: number }

type Outcome<T> = { ok: true; value: T } | { ok: false; error: BackupError };

interface RunOptions {
  entry: WorkerEntry;
  signal?: AbortSignal;
  timeoutMs: number;
  idleTimeoutMs: number;
  resourceLimits: ResourceLimits;
  onProgress?: (p: BackupProgress) => void;
}

/**
 * Run one job in a new worker. Settles only after the worker thread has exited, so the caller never cleans up files
 * the worker might still be using. Timeouts, cancellation, crashes, memory exhaustion and protocol violations end the
 * worker (terminate) and become TIMEOUT / CANCELLED / WORKER_FAILED.
 */
export function runWorker<T extends CreateFacts | VerifyFacts>(job: WorkerJob, o: RunOptions): Promise<T> {
  if (o.signal?.aborted) return Promise.reject(new BackupError('CANCELLED', 'start'));
  return new Promise<T>((resolve, reject) => {
    let outcome: Outcome<T> | null = null;
    let overall: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    let worker: Worker;
    const stopTimers = () => { clearTimeout(overall); clearTimeout(idle); o.signal?.removeEventListener('abort', onAbort); };
    const settle = (r: Outcome<T>) => {
      if (outcome) return;
      outcome = r;
      stopTimers();
      void worker.terminate().catch(() => undefined); // resolves the promise through 'exit'
    };
    const fail = (code: 'TIMEOUT' | 'CANCELLED' | 'WORKER_FAILED', stage: string) => settle({ ok: false, error: new BackupError(code, stage) });
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => fail('TIMEOUT', 'idle'), o.idleTimeoutMs); };
    const onAbort = () => fail('CANCELLED', 'signal');
    try {
      worker = new Worker(o.entry.file, {
        execArgv: o.entry.execArgv,
        workerData: { ...(o.entry.workerData ?? {}), jobId: job.jobId },
        resourceLimits: o.resourceLimits,
      });
    } catch {
      reject(new BackupError('WORKER_FAILED', 'start'));
      return;
    }
    overall = setTimeout(() => fail('TIMEOUT', 'overall'), o.timeoutMs);
    armIdle();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (raw: unknown) => {
      if (outcome) return;
      let m;
      try { m = parseWorkerMessage(raw, job); } catch { fail('WORKER_FAILED', 'protocol'); return; }
      armIdle();
      if (m.type === 'progress') { try { o.onProgress?.({ stage: m.stage, bytesDone: m.bytesDone, bytesTotal: m.bytesTotal }); } catch { /* caller's callback */ } }
      else if (m.type === 'done') settle({ ok: true, value: m.result as T });
      else settle({ ok: false, error: new BackupError(m.code, m.stage) });
    });
    worker.on('messageerror', () => fail('WORKER_FAILED', 'protocol'));
    worker.on('error', (e: NodeJS.ErrnoException) => fail('WORKER_FAILED', e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash'));
    worker.on('exit', () => {
      stopTimers();
      const final: Outcome<T> = outcome ?? { ok: false, error: new BackupError('WORKER_FAILED', 'exit') };
      outcome = final;
      if (final.ok === true) resolve(final.value);
      else reject((final as { error: BackupError }).error);
    });
    worker.postMessage(job); // the structured clone is the worker's copy of the password
    (job as { secret: string }).secret = ''; // drop this thread's reference
  });
}

export interface CreateBackupOptions {
  /** absolute paths of the data folder and the live database (as the server uses them) */
  dataDir: string;
  dbFile: string;
  secret: string;
  kind: BackupKind;
  appVersion: string;
  /** default DEFAULT_KDF (N 2^17, r 8, p 1) */
  kdf?: ScryptParams;
  chunkSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onProgress?: (p: BackupProgress) => void;
  // injection for tests only
  workerEntry?: WorkerEntry;
  workerResourceLimits?: ResourceLimits;
  privateDir?: PrivateDirOptions;
  statfs?: StatfsFn;
  retry?: RetryOptions;
  publish?: Pick<PublishOptions, 'link'>;
}

export interface CreateBackupResult {
  name: string;
  path: string;
  backupId: string;
  createdAt: string;
  kind: BackupKind;
  fileBytes: number;
  plaintextBytes: number;
  plaintextSha256: string;
  dataRecords: number;
  schemaVersion: number;
  rowCounts: Record<string, number>;
  kdf: ScryptParams;
  durationMs: number;
  /** names left behind for the next sweep (plaintext snapshot or temporary name that could not be removed) */
  cleanupPending: number;
}

function assertOptions(o: CreateBackupOptions): void {
  if (typeof o.secret !== 'string' || o.secret.length === 0) throw new BackupError('EMPTY_SECRET', 'options');
  if (!BACKUP_KINDS.includes(o.kind)) throw new TypeError('kind must be one of manual, scheduled, prerestore');
  if (typeof o.appVersion !== 'string' || !APP_VERSION.test(o.appVersion)) throw new TypeError('appVersion is invalid');
  const chunk = o.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunk) || chunk < MIN_CHUNK_SIZE || chunk > MAX_CHUNK_SIZE) throw new TypeError('chunkSize is out of range');
  for (const t of [o.timeoutMs, o.idleTimeoutMs]) if (t !== undefined && (!Number.isSafeInteger(t) || t <= 0)) throw new TypeError('timeouts must be positive integers');
  assertKdfParams(o.kdf ?? DEFAULT_KDF);
}

/** Delete the snapshot and its SQLite side files (never following links). Returns how many could not be removed. */
async function removeSnapshot(snapshotPath: string, retry?: RetryOptions): Promise<number> {
  let pending = 0;
  for (const p of [snapshotPath, ...SQLITE_SIDECARS.map((ext) => `${snapshotPath}${ext}`)]) {
    const st = await fs.promises.lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) { pending++; continue; } // never recurse; left for inspection
    try { await removeWithRetry(p, retry); } catch { pending++; } // a link is removed itself, never its target
  }
  return pending;
}

const sameInfo = (a: BackupHeaderInfo, e: { backupId: string; createdAt: string; kind: string; appVersion: string; kdf: ScryptParams; chunkSize: number }) =>
  a.backupId === e.backupId && a.createdAt === e.createdAt && a.kind === e.kind && a.appVersion === e.appVersion
  && a.kdf.N === e.kdf.N && a.kdf.r === e.kdf.r && a.kdf.p === e.kdf.p && a.chunkSize === e.chunkSize;

/** Create, verify and publish one encrypted backup. */
export async function createBackup(o: CreateBackupOptions): Promise<CreateBackupResult> {
  const started = Date.now();
  assertOptions(o);
  const layout = backupLayout(o.dataDir, o.dbFile);
  const kdf = { ...(o.kdf ?? DEFAULT_KDF) };
  const chunkSize = o.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const pd = o.privateDir ?? {};
  const progress = (p: BackupProgress) => { try { o.onProgress?.(p); } catch { /* caller's callback */ } };
  if (o.signal?.aborted) throw new BackupError('CANCELLED', 'start');

  progress({ stage: 'prepare', bytesDone: 0, bytesTotal: 0 });
  try { await fs.promises.mkdir(layout.backupsDir, { recursive: true }); } catch { throw new BackupError('WRITE_FAILED', 'backups-dir'); }
  await ensurePrivateDir(layout.workDir, pd);
  await ensurePrivateDir(layout.encryptedDir, pd);
  const lock = await BackupLock.acquire(layout, { ...pd, retry: o.retry });
  let snap: CreatedFile | null = null;
  let part: CreatedFile | null = null;
  let partOpen = false;
  let snapshotRemoved = false;
  let published = false;
  let cleanupPending = 0;
  try {
    await sweepWorkDir(lock, { ...pd, retry: o.retry });
    await checkBackupSpace(layout, o.statfs);

    snap = await createWorkFile(lock, 'snapshot');
    await snap.handle.close();
    await verifyPrivateFile(snap.path, pd); // before SQLite writes any plaintext into it
    part = await createWorkFile(lock, 'btbackup', { readWrite: true });
    partOpen = true;
    await verifyPrivateFile(part.path, pd);

    const backupId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const facts = await runWorker<CreateFacts>({
      type: 'create', jobId: crypto.randomUUID(), dbFile: layout.dbFile, snapshotPath: snap.path, partialFd: part.handle.fd,
      secret: o.secret, kdf, chunkSize, appVersion: o.appVersion, kind: o.kind, backupId, createdAt, maxPlaintextBytes: MAX_DATABASE_BYTES,
    }, {
      entry: o.workerEntry ?? defaultWorkerEntry(), signal: o.signal, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, resourceLimits: o.workerResourceLimits ?? WORKER_RESOURCE_LIMITS, onProgress: progress,
    });

    // the worker has stopped; check what it reported against what this thread asked for and sees on disk
    if (!sameInfo(facts.info, { backupId, createdAt, kind: o.kind, appVersion: o.appVersion, kdf, chunkSize })) throw new BackupError('VERIFY_FAILED', 'header');
    const st = await part.handle.stat();
    if (!st.isFile() || st.size !== facts.fileBytes || st.size > MAX_BACKUP_FILE_BYTES) throw new BackupError('VERIFY_FAILED', 'size');
    await syncAndClose(part.handle);
    partOpen = false;

    // plaintext first: if it cannot be deleted, the verified backup is still published (D5) and counted
    cleanupPending += await removeSnapshot(snap.path, o.retry);
    snapshotRemoved = true;
    if (o.signal?.aborted) throw new BackupError('CANCELLED', 'publish');
    progress({ stage: 'publish', bytesDone: 0, bytesTotal: facts.fileBytes });
    const r = await publishByHardLink(lock, part.path, newBackupName(o.kind), { ...(o.retry ?? {}), ...(o.publish ?? {}) });
    published = true;
    cleanupPending += r.cleanupPending;
    progress({ stage: 'publish', bytesDone: facts.fileBytes, bytesTotal: facts.fileBytes });
    return {
      name: path.basename(r.finalPath), path: r.finalPath, backupId, createdAt, kind: o.kind,
      fileBytes: facts.fileBytes, plaintextBytes: facts.plaintextBytes, plaintextSha256: facts.plaintextSha256, dataRecords: facts.dataRecords,
      schemaVersion: facts.snapshot.schemaVersion, rowCounts: facts.snapshot.rowCounts, kdf, durationMs: Date.now() - started, cleanupPending,
    };
  } finally {
    if (part && partOpen) await part.handle.close().catch(() => undefined);
    if (snap && !snapshotRemoved) await removeSnapshot(snap.path, o.retry).catch(() => undefined); // leftovers: next sweep
    if (part && !published) await removeWithRetry(part.path, o.retry).catch(() => undefined);
    lock.release();
  }
}

export interface VerifyBackupFileOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onProgress?: (p: BackupProgress) => void;
  workerEntry?: WorkerEntry;
  workerResourceLimits?: ResourceLimits;
}

/**
 * Fully verify any .btbackup file with the password (size checked before reading; every tag, the FINAL record and
 * the end of file; the manifest). Writes nothing. Reader errors keep their codes (WRONG_SECRET_OR_HEADER_DAMAGED,
 * CORRUPT, TRUNCATED, ...).
 */
export async function verifyBackupFile(file: string, secret: string, o: VerifyBackupFileOptions = {}): Promise<{ info: BackupHeaderInfo; manifest: BackupManifest; fileBytes: number }> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new BackupError('PATH_REJECTED', 'verify');
  if (typeof secret !== 'string' || secret.length === 0) throw new BackupError('EMPTY_SECRET', 'verify');
  for (const t of [o.timeoutMs, o.idleTimeoutMs]) if (t !== undefined && (!Number.isSafeInteger(t) || t <= 0)) throw new TypeError('timeouts must be positive integers');
  return runWorker<VerifyFacts>({ type: 'verify', jobId: crypto.randomUUID(), file: path.resolve(file), secret, maxPlaintextBytes: MAX_DATABASE_BYTES }, {
    entry: o.workerEntry ?? defaultWorkerEntry(), signal: o.signal, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, resourceLimits: o.workerResourceLimits ?? WORKER_RESOURCE_LIMITS, onProgress: o.onProgress,
  });
}

/**
 * Remove leftovers of interrupted backups (plaintext snapshots, side files, .partial) from .work, under the lock.
 * BACKUP_IN_PROGRESS while a backup runs. Nothing to do when .work does not exist yet.
 */
export async function cleanupStaleArtifacts(o: { dataDir: string; dbFile: string; privateDir?: PrivateDirOptions; retry?: RetryOptions }): Promise<SweepResult> {
  const layout = backupLayout(o.dataDir, o.dbFile);
  const st = await fs.promises.lstat(layout.workDir).catch(() => null);
  if (!st) return { removed: 0, skipped: 0, failed: 0 };
  await ensurePrivateDir(layout.workDir, o.privateDir ?? {});
  const lock = await BackupLock.acquire(layout, { ...(o.privateDir ?? {}), retry: o.retry });
  try {
    return await sweepWorkDir(lock, { ...(o.privateDir ?? {}), retry: o.retry });
  } finally {
    lock.release();
  }
}
