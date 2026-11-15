/**
 * Phase 9A.3: messages between the engine (main thread) and the backup worker, with strict validation in both
 * directions. Anything malformed, unexpected or carrying extra fields is rejected (WORKER_FAILED 'protocol'), so a
 * misbehaving worker cannot smuggle data (or secrets) into results or errors. Only the job message carries the
 * password; no worker message ever does.
 */
import { BackupError, isBackupErrorCode, type BackupErrorCode } from './errors';
import type { BackupHeaderInfo, BackupManifest } from './format';
import type { SnapshotFacts } from './snapshot';

export interface CreateJob {
  type: 'create';
  jobId: string;
  dbFile: string;
  snapshotPath: string;
  partialFd: number;
  secret: string;
  kdf: { N: number; r: number; p: number };
  chunkSize: number;
  appVersion: string;
  kind: string;
  backupId: string;
  createdAt: string;
  maxPlaintextBytes: number;
}
export interface VerifyJob { type: 'verify'; jobId: string; file: string; secret: string; maxPlaintextBytes: number }
export type WorkerJob = CreateJob | VerifyJob;

export type WorkerStage = 'snapshot' | 'inspect' | 'encrypt' | 'verify';
export interface CreateFacts {
  pages: number;
  snapshot: SnapshotFacts;
  fileBytes: number;
  plaintextBytes: number;
  plaintextSha256: string;
  dataRecords: number;
  info: BackupHeaderInfo;
}
export interface VerifyFacts { info: BackupHeaderInfo; manifest: BackupManifest; fileBytes: number }
export type WorkerMessage =
  | { type: 'progress'; jobId: string; stage: WorkerStage; bytesDone: number; bytesTotal: number }
  | { type: 'done'; jobId: string; result: CreateFacts | VerifyFacts }
  | { type: 'failed'; jobId: string; code: BackupErrorCode; stage: string };

const bad = (): BackupError => new BackupError('WORKER_FAILED', 'protocol');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const SHA = /^[0-9a-f]{64}$/;
const STAGE_LABEL = /^[A-Za-z0-9:_-]{1,48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGES: readonly WorkerStage[] = ['snapshot', 'inspect', 'encrypt', 'verify'];

/** Validate a job (in the worker). Throws WORKER_FAILED 'protocol'. */
export function parseJob(v: unknown): WorkerJob {
  if (!isObj(v)) throw bad();
  if (v.type === 'create') {
    const keys = ['type', 'jobId', 'dbFile', 'snapshotPath', 'partialFd', 'secret', 'kdf', 'chunkSize', 'appVersion', 'kind', 'backupId', 'createdAt', 'maxPlaintextBytes'];
    const kdf = v.kdf;
    const ok = exactKeys(v, keys) && str(v.jobId, 64) && str(v.dbFile) && str(v.snapshotPath) && nat(v.partialFd) && typeof v.secret === 'string'
      && isObj(kdf) && exactKeys(kdf, ['N', 'r', 'p']) && nat(kdf.N) && nat(kdf.r) && nat(kdf.p)
      && nat(v.chunkSize) && str(v.appVersion, 64) && str(v.kind, 32) && str(v.backupId, 36) && UUID.test(v.backupId as string)
      && str(v.createdAt, 40) && nat(v.maxPlaintextBytes);
    if (!ok) throw bad();
    return v as unknown as CreateJob;
  }
  if (v.type === 'verify') {
    const ok = exactKeys(v, ['type', 'jobId', 'file', 'secret', 'maxPlaintextBytes']) && str(v.jobId, 64) && str(v.file) && typeof v.secret === 'string' && nat(v.maxPlaintextBytes);
    if (!ok) throw bad();
    return v as unknown as VerifyJob;
  }
  throw bad();
}

function isInfo(v: unknown): v is BackupHeaderInfo {
  if (!isObj(v) || !exactKeys(v, ['formatVersion', 'backupId', 'createdAt', 'appVersion', 'schemaVersion', 'kind', 'kdf', 'chunkSize', 'payload'])) return false;
  const k = v.kdf;
  return nat(v.formatVersion) && str(v.backupId, 36) && str(v.createdAt, 40) && str(v.appVersion, 64) && nat(v.schemaVersion) && str(v.kind, 32)
    && isObj(k) && exactKeys(k, ['N', 'r', 'p']) && nat(k.N) && nat(k.r) && nat(k.p) && nat(v.chunkSize) && v.payload === 'sqlite3';
}
function isRowCounts(v: unknown): v is Record<string, number> {
  return isObj(v) && Object.keys(v).length <= 1000 && Object.entries(v).every(([k, n]) => k.length > 0 && k.length <= 256 && nat(n));
}
function isSnapshotFacts(v: unknown): v is SnapshotFacts {
  return isObj(v) && exactKeys(v, ['bytes', 'pageSize', 'pageCount', 'schemaVersion', 'sqliteVersion', 'rowCounts'])
    && nat(v.bytes) && nat(v.pageSize) && nat(v.pageCount) && nat(v.schemaVersion) && str(v.sqliteVersion, 32) && isRowCounts(v.rowCounts);
}
function isCreateFacts(v: unknown): v is CreateFacts {
  return isObj(v) && exactKeys(v, ['pages', 'snapshot', 'fileBytes', 'plaintextBytes', 'plaintextSha256', 'dataRecords', 'info'])
    && nat(v.pages) && isSnapshotFacts(v.snapshot) && nat(v.fileBytes) && nat(v.plaintextBytes) && typeof v.plaintextSha256 === 'string'
    && SHA.test(v.plaintextSha256) && nat(v.dataRecords) && isInfo(v.info);
}
function isVerifyFacts(v: unknown): v is VerifyFacts {
  if (!isObj(v) || !exactKeys(v, ['info', 'manifest', 'fileBytes']) || !isInfo(v.info) || !nat(v.fileBytes)) return false;
  const m = v.manifest;
  return isObj(m) && exactKeys(m, ['dataRecords', 'plaintextSize', 'plaintextSha256', 'meta']) && nat(m.dataRecords) && nat(m.plaintextSize)
    && typeof m.plaintextSha256 === 'string' && SHA.test(m.plaintextSha256) && isObj(m.meta) && JSON.stringify(m.meta).length <= 64 * 1024;
}

/** Validate a message from the worker for the given job (in the engine). Throws WORKER_FAILED 'protocol'. */
export function parseWorkerMessage(v: unknown, job: WorkerJob): WorkerMessage {
  if (!isObj(v) || v.jobId !== job.jobId) throw bad();
  if (v.type === 'progress') {
    if (!exactKeys(v, ['type', 'jobId', 'stage', 'bytesDone', 'bytesTotal']) || !STAGES.includes(v.stage as WorkerStage) || !nat(v.bytesDone) || !nat(v.bytesTotal)) throw bad();
    return v as unknown as WorkerMessage;
  }
  if (v.type === 'failed') {
    if (!exactKeys(v, ['type', 'jobId', 'code', 'stage']) || !isBackupErrorCode(v.code) || typeof v.stage !== 'string' || !STAGE_LABEL.test(v.stage)) throw bad();
    return v as unknown as WorkerMessage;
  }
  if (v.type === 'done') {
    if (!exactKeys(v, ['type', 'jobId', 'result'])) throw bad();
    if (job.type === 'create' ? !isCreateFacts(v.result) : !isVerifyFacts(v.result)) throw bad();
    return v as unknown as WorkerMessage;
  }
  throw bad();
}
