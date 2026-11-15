/**
 * Phase 9A.3: streaming encryption of the snapshot into the .partial file, and independent verification of that
 * file read back from disk (runs in the backup worker).
 *
 * - Bounded memory: the snapshot is read in chunkSize pieces (1 MiB by default) and every record is written (awaited)
 *   before the next piece is read, so nothing larger than a few chunks is ever held. No whole database or backup is
 *   buffered.
 * - Positional writes and reads on the file descriptor the engine created ('wx+'); the file is never reopened by name.
 * - Verification uses a NEW BackupReader (its own key derivation from the header on disk): every authentication tag,
 *   the FINAL record and the end-of-file rules are checked by the reader; the decrypted chunks are hashed and counted
 *   as they stream past and then zeroed, never collected. The results are then compared field by field with the
 *   facts measured independently from the snapshot and while encrypting (assertVerifiedMatches).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { BackupError } from './errors';
import { BackupReader, BackupWriter, type BackupHeaderInfo, type BackupManifest, type BackupWriterOptions } from './format';
import { MAX_BACKUP_FILE_BYTES } from './paths';
import type { SnapshotFacts } from './snapshot';

export const VERIFY_PIECE_BYTES = 1024 * 1024;

/** file operations on a descriptor (injectable for failure tests) */
export interface PipelineIo {
  read(fd: number, buf: Buffer, offset: number, length: number, position: number): Promise<number>;
  write(fd: number, buf: Buffer, offset: number, length: number, position: number): Promise<number>;
  fsync(fd: number): Promise<void>;
  fstat(fd: number): Promise<{ size: number; isFile(): boolean }>;
}
const pRead = promisify(fs.read);
const pWrite = promisify(fs.write);
export const defaultIo: PipelineIo = {
  read: async (fd, buf, off, len, pos) => (await pRead(fd, buf, off, len, pos)).bytesRead,
  write: async (fd, buf, off, len, pos) => (await pWrite(fd, buf, off, len, pos)).bytesWritten,
  fsync: promisify(fs.fsync),
  fstat: promisify(fs.fstat),
};

const writeError = (e: unknown): BackupError => {
  if (e instanceof BackupError) return e;
  return new BackupError((e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'DISK_SPACE' : 'WRITE_FAILED', 'encrypt');
};

/** the manifest metadata recorded from the snapshot facts (the same function is used to check it) */
export function snapshotMeta(f: SnapshotFacts): Record<string, unknown> {
  return {
    snapshotMethod: 'sqlite-online-backup',
    integrity: 'ok',
    schemaVersion: f.schemaVersion,
    pageSize: f.pageSize,
    pageCount: f.pageCount,
    sqliteVersion: f.sqliteVersion,
    rowCounts: Object.fromEntries(Object.entries(f.rowCounts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

export interface EncryptOptions extends BackupWriterOptions {
  meta: Record<string, unknown>;
  maxPlaintextBytes: number;
  onBytes?: (plaintextBytesDone: number) => void;
  io?: PipelineIo;
}
export interface EncryptResult {
  fileBytes: number;
  plaintextBytes: number;
  /** computed here from the bytes read, independently of the writer's own hash */
  plaintextSha256: string;
  dataRecords: number;
  info: BackupHeaderInfo;
}

/** Encrypt the file at `srcPath` into `fd` (empty, writable, readable) and flush it to disk. */
export async function encryptFileToFd(srcPath: string, fd: number, o: EncryptOptions): Promise<EncryptResult> {
  const io = o.io ?? defaultIo;
  const st = await fs.promises.lstat(srcPath).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile()) throw new BackupError('PATH_REJECTED', 'encrypt');
  if (st.size > o.maxPlaintextBytes) throw new BackupError('FILE_TOO_LARGE', 'encrypt');
  const writer = await BackupWriter.create(o); // KDF here (KDF_FAILED / KDF_PARAMS_REJECTED)
  const src = await fs.promises.open(srcPath, 'r');
  const piece = Buffer.alloc(writer.info.chunkSize);
  const hash = crypto.createHash('sha256');
  let position = 0;
  let records = 0;
  let plaintextBytes = 0;
  const writeAt = async (b: Buffer) => {
    let off = 0;
    while (off < b.length) {
      let n: number;
      try { n = await io.write(fd, b, off, b.length - off, position); } catch (e) { throw writeError(e); }
      if (!(n > 0)) throw new BackupError('WRITE_FAILED', 'encrypt');
      off += n; position += n;
    }
  };
  try {
    await writeAt(writer.header);
    for (;;) {
      const { bytesRead } = await src.read(piece, 0, piece.length, plaintextBytes);
      if (bytesRead === 0) break;
      plaintextBytes += bytesRead;
      if (plaintextBytes > o.maxPlaintextBytes) throw new BackupError('FILE_TOO_LARGE', 'encrypt');
      const chunk = piece.subarray(0, bytesRead);
      hash.update(chunk);
      for (const rec of writer.push(chunk)) { await writeAt(rec); records++; }
      o.onBytes?.(plaintextBytes);
    }
    const tail = writer.finish(o.meta);
    for (const rec of tail) { await writeAt(rec); records++; }
    try { await io.fsync(fd); } catch (e) { throw writeError(e); }
    return { fileBytes: position, plaintextBytes, plaintextSha256: hash.digest('hex'), dataRecords: records - 1, info: writer.info };
  } catch (e) {
    throw e instanceof BackupError ? e : writeError(e);
  } finally {
    writer.abort(); // wipes the keys if finish() did not run
    piece.fill(0);
    await src.close().catch(() => undefined);
  }
}

export interface VerifyResult {
  info: BackupHeaderInfo;
  manifest: BackupManifest;
  fileBytes: number;
  /** counted and hashed here from the decrypted stream, independently of the reader's own checks */
  plaintextBytes: number;
  plaintextSha256: string;
}

/**
 * Read `fd` from the start and verify it completely with a new reader. Reader errors keep their own codes
 * (WRONG_SECRET_OR_HEADER_DAMAGED, CORRUPT, TRUNCATED, TRAILING_DATA, ...); the caller decides how to report them.
 */
export async function verifyEncryptedFd(fd: number, secret: string, o: { maxPlaintextBytes: number; onBytes?: (encryptedBytesDone: number) => void; io?: PipelineIo; pieceBytes?: number }): Promise<VerifyResult> {
  const io = o.io ?? defaultIo;
  let st;
  try { st = await io.fstat(fd); } catch { throw new BackupError('PATH_REJECTED', 'verify'); }
  if (!st.isFile()) throw new BackupError('PATH_REJECTED', 'verify');
  if (st.size > MAX_BACKUP_FILE_BYTES) throw new BackupError('FILE_TOO_LARGE', 'verify');
  const reader = new BackupReader(secret, { maxPlaintextBytes: o.maxPlaintextBytes });
  const piece = Buffer.alloc(o.pieceBytes ?? VERIFY_PIECE_BYTES);
  const hash = crypto.createHash('sha256');
  let position = 0;
  let plaintextBytes = 0;
  try {
    for (;;) {
      let n: number;
      try { n = await io.read(fd, piece, 0, piece.length, position); } catch { throw new BackupError('VERIFY_FAILED', 'read'); }
      if (n === 0) break;
      position += n;
      if (position > MAX_BACKUP_FILE_BYTES) throw new BackupError('FILE_TOO_LARGE', 'verify');
      for (const chunk of await reader.push(piece.subarray(0, n))) {
        hash.update(chunk);
        plaintextBytes += chunk.length;
        chunk.fill(0); // streamed into the hash only, never kept
      }
      o.onBytes?.(position);
    }
    const { info, manifest } = reader.end(); // TRUNCATED if the FINAL record is missing
    return { info, manifest, fileBytes: position, plaintextBytes, plaintextSha256: hash.digest('hex') };
  } finally {
    piece.fill(0);
  }
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * Every relevant field must agree between: the snapshot facts (measured from the checked snapshot), the encryption
 * pass (bytes read and hashed while encrypting) and the verification pass (bytes decrypted from disk), including the
 * authenticated manifest and header. Any difference: VERIFY_FAILED 'mismatch'.
 */
export function assertVerifiedMatches(facts: SnapshotFacts, enc: EncryptResult, ver: VerifyResult): void {
  const m = ver.manifest;
  const checks: boolean[] = [
    ver.fileBytes === enc.fileBytes,
    facts.bytes === enc.plaintextBytes, enc.plaintextBytes === ver.plaintextBytes, ver.plaintextBytes === m.plaintextSize,
    enc.plaintextSha256 === ver.plaintextSha256, ver.plaintextSha256 === m.plaintextSha256,
    m.dataRecords === enc.dataRecords,
    canonical(m.meta) === canonical(snapshotMeta(facts)),
    canonical(ver.info) === canonical(enc.info),
    ver.info.schemaVersion === facts.schemaVersion,
  ];
  if (!checks.every(Boolean)) throw new BackupError('VERIFY_FAILED', 'mismatch');
}
