/**
 * Phase 9A.3: the backup worker (one per job, started by engine.ts). It does the CPU- and I/O-heavy work away from
 * the server's main thread: the snapshot (its own read-only SQLite connection), its checks, the key derivation,
 * streaming encryption into the .partial (through the file descriptor the engine created) and the full read-back
 * verification. It never holds the backup lock, never publishes and never deletes; the engine does that after this
 * thread has stopped. Keys exist only here and are wiped by the writer/reader; messages never contain secrets.
 */
import fs from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BackupError } from './errors';
import { assertVerifiedMatches, encryptFileToFd, snapshotMeta, verifyEncryptedFd } from './pipeline';
import { inspectSnapshot, snapshotDatabase } from './snapshot';
import { parseJob, type CreateFacts, type CreateJob, type VerifyFacts, type VerifyJob, type WorkerJob, type WorkerMessage, type WorkerStage } from './workerProtocol';

export type Progress = (stage: WorkerStage, bytesDone: number, bytesTotal: number) => void;

/** reader errors during the self-check of a new backup are reported as VERIFY_FAILED (with the reader's code as stage) */
const asVerifyFailure = (e: unknown): BackupError => {
  if (e instanceof BackupError && (e.code === 'VERIFY_FAILED' || e.code === 'DISK_SPACE')) return e;
  return new BackupError('VERIFY_FAILED', e instanceof BackupError ? `verify:${e.code}` : 'verify');
};

export async function runCreate(job: CreateJob, progress: Progress): Promise<CreateFacts> {
  progress('snapshot', 0, 0);
  const { pages } = await snapshotDatabase(job.dbFile, job.snapshotPath);
  progress('inspect', 0, 0);
  const snapshot = await inspectSnapshot(job.snapshotPath);
  if (snapshot.pageCount !== pages) throw new BackupError('SNAPSHOT_FAILED', 'size');
  progress('encrypt', 0, snapshot.bytes);
  const enc = await encryptFileToFd(job.snapshotPath, job.partialFd, {
    secret: job.secret, kdf: job.kdf, chunkSize: job.chunkSize, appVersion: job.appVersion, schemaVersion: snapshot.schemaVersion,
    kind: job.kind, backupId: job.backupId, createdAt: job.createdAt, meta: snapshotMeta(snapshot), maxPlaintextBytes: job.maxPlaintextBytes,
    onBytes: (n) => progress('encrypt', n, snapshot.bytes),
  });
  progress('verify', 0, enc.fileBytes);
  let ver;
  try {
    ver = await verifyEncryptedFd(job.partialFd, job.secret, { maxPlaintextBytes: job.maxPlaintextBytes, onBytes: (n) => progress('verify', n, enc.fileBytes) });
    assertVerifiedMatches(snapshot, enc, ver);
  } catch (e) {
    throw asVerifyFailure(e);
  }
  return { pages, snapshot, fileBytes: enc.fileBytes, plaintextBytes: enc.plaintextBytes, plaintextSha256: enc.plaintextSha256, dataRecords: enc.dataRecords, info: enc.info };
}

export async function runVerify(job: VerifyJob, progress: Progress): Promise<VerifyFacts> {
  const st = await fs.promises.lstat(job.file).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile()) throw new BackupError('PATH_REJECTED', 'verify');
  const fd = fs.openSync(job.file, 'r');
  try {
    progress('verify', 0, st.size);
    const ver = await verifyEncryptedFd(fd, job.secret, { maxPlaintextBytes: job.maxPlaintextBytes, onBytes: (n) => progress('verify', n, st.size) });
    return { info: ver.info, manifest: ver.manifest, fileBytes: ver.fileBytes };
  } finally {
    fs.closeSync(fd);
  }
}

export async function runJob(job: WorkerJob, progress: Progress): Promise<CreateFacts | VerifyFacts> {
  try {
    return job.type === 'create' ? await runCreate(job, progress) : await runVerify(job, progress);
  } finally {
    (job as { secret: string }).secret = ''; // drop this thread's reference (strings cannot be wiped)
  }
}

/** an error as a protocol message: fixed code and stage label only */
export function failureMessage(jobId: string, e: unknown): WorkerMessage {
  if (e instanceof BackupError && /^[A-Za-z0-9:_-]{1,48}$/.test(e.stage)) return { type: 'failed', jobId, code: e.code, stage: e.stage };
  return { type: 'failed', jobId, code: 'WORKER_FAILED', stage: 'internal' };
}

/** Receive one job, run it, report, and let the thread end. */
export function startWorker(): void {
  const port = parentPort!;
  port.once('message', async (raw: unknown) => {
    let job: WorkerJob;
    try { job = parseJob(raw); } catch {
      port.postMessage({ type: 'failed', jobId: String((raw as { jobId?: unknown })?.jobId ?? '').slice(0, 64), code: 'WORKER_FAILED', stage: 'protocol' });
      return;
    }
    const jobId = job.jobId;
    let lastSent = 0;
    const progress: Progress = (stage, bytesDone, bytesTotal) => {
      const now = Date.now();
      if (bytesDone !== 0 && bytesDone !== bytesTotal && now - lastSent < 200) return; // at most ~5 per second
      lastSent = now;
      port.postMessage({ type: 'progress', jobId, stage, bytesDone, bytesTotal });
    };
    try {
      const result = await runJob(job, progress);
      port.postMessage({ type: 'done', jobId, result });
    } catch (e) {
      port.postMessage(failureMessage(jobId, e));
    }
  });
}

if (!isMainThread && parentPort && !(workerData && (workerData as { manual?: unknown }).manual === true)) startWorker();
