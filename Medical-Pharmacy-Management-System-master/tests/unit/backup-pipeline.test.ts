/**
 * Phase 9A.3: streaming encryption and independent verification (server/backup/pipeline.ts).
 * Uses the lowest accepted scrypt work factor (N = 2^15) for speed; the engine uses DEFAULT_KDF.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertVerifiedMatches, defaultIo, encryptFileToFd, snapshotMeta, verifyEncryptedFd, type EncryptResult, type PipelineIo, type VerifyResult,
} from '../../server/backup/pipeline';
import { decodeBackup, MIN_CHUNK_SIZE } from '../../server/backup/format';
import type { SnapshotFacts } from '../../server/backup/snapshot';

const FAST = { N: 2 ** 15, r: 8, p: 1 };
const SECRET = 'Pipeline-Pass 1';
const MiB = 1024 * 1024;
let dir: string;
const fds: number[] = [];

const factsFor = (bytes: number): SnapshotFacts => ({ bytes, pageSize: 4096, pageCount: Math.ceil(bytes / 4096), schemaVersion: 11, sqliteVersion: '3.53.4', rowCounts: { users: 2, products: 7 } });
const writerOpts = (facts: SnapshotFacts, extra: Record<string, unknown> = {}) => ({
  secret: SECRET, kdf: FAST, chunkSize: MIN_CHUNK_SIZE, appVersion: '1.0.0', schemaVersion: facts.schemaVersion, kind: 'manual',
  meta: snapshotMeta(facts), maxPlaintextBytes: 4 * 1024 ** 3, ...extra,
});
function source(bytes: number): string {
  const p = path.join(dir, `src-${crypto.randomUUID()}.bin`);
  const fd = fs.openSync(p, 'w');
  const block = crypto.randomBytes(MiB);
  for (let done = 0; done < bytes; done += MiB) fs.writeSync(fd, block, 0, Math.min(MiB, bytes - done));
  fs.closeSync(fd);
  return p;
}
function partial(): { fd: number; path: string } {
  const p = path.join(dir, `${crypto.randomUUID()}.btbackup.partial`);
  const fd = fs.openSync(p, 'wx+', 0o600);
  fds.push(fd);
  return { fd, path: p };
}
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pipe-'))); });
afterEach(() => {
  for (const fd of fds.splice(0)) { try { fs.closeSync(fd); } catch { /* closed */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('encrypt and verify', () => {
  it('round trip: the verified facts match the source exactly; an independent full decode gives the same bytes', async () => {
    const bytes = 3 * MiB + 12345;
    const src = source(bytes);
    const facts = factsFor(bytes);
    const out = partial();
    const enc = await encryptFileToFd(src, out.fd, writerOpts(facts));
    expect(enc.plaintextBytes).toBe(bytes);
    expect(enc.plaintextSha256).toBe(sha(src));
    expect(enc.fileBytes).toBe(fs.statSync(out.path).size);
    expect(enc.dataRecords).toBe(Math.ceil(bytes / MIN_CHUNK_SIZE));
    const ver = await verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: bytes });
    expect(ver.plaintextSha256).toBe(sha(src));
    expect(ver.manifest.meta).toEqual(snapshotMeta(facts));
    assertVerifiedMatches(facts, enc, ver);
    const decoded = await decodeBackup(fs.readFileSync(out.path), SECRET);
    expect(crypto.createHash('sha256').update(decoded.data).digest('hex')).toBe(sha(src));
  });

  it('64 MiB streams with bounded memory: Buffer memory never grows by more than a few chunks while encrypting or verifying', async () => {
    const bytes = 64 * MiB;
    const src = source(bytes);
    const facts = factsFor(bytes);
    const out = partial();
    global.gc?.();
    const base = process.memoryUsage().arrayBuffers;
    let peak = base;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
    let progressCalls = 0;
    try {
      const enc = await encryptFileToFd(src, out.fd, { ...writerOpts(facts), chunkSize: MiB, onBytes: () => { progressCalls++; peak = Math.max(peak, process.memoryUsage().arrayBuffers); } });
      const ver = await verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: bytes, onBytes: () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); } });
      assertVerifiedMatches(facts, enc, ver);
    } finally {
      clearInterval(sampler);
    }
    expect(progressCalls).toBe(64);
    // a 64 MiB file must not be held: allow 32 MiB of Buffer churn (chunks, records, garbage not yet collected)
    expect(peak - base).toBeLessThan(32 * MiB);
  }, 120_000);

  it('a source larger than the limit is FILE_TOO_LARGE, checked before any key derivation', async () => {
    const src = source(2 * MiB);
    const out = partial();
    const started = Date.now();
    await expect(encryptFileToFd(src, out.fd, writerOpts(factsFor(2 * MiB), { maxPlaintextBytes: 2 * MiB - 1 }))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(fs.statSync(out.path).size).toBe(0);
  });

  it('write failures: a full disk is DISK_SPACE, other errors WRITE_FAILED; short writes are completed', async () => {
    const src = source(MiB);
    const facts = factsFor(MiB);
    const failing = (code: string, after: number): PipelineIo => {
      let calls = 0;
      return { ...defaultIo, write: async (...a) => { if (++calls > after) throw Object.assign(new Error('x'), { code }); return defaultIo.write(...a); } };
    };
    await expect(encryptFileToFd(src, partial().fd, { ...writerOpts(facts), io: failing('ENOSPC', 3) })).rejects.toMatchObject({ code: 'DISK_SPACE' });
    await expect(encryptFileToFd(src, partial().fd, { ...writerOpts(facts), io: failing('EIO', 0) })).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    await expect(encryptFileToFd(src, partial().fd, { ...writerOpts(facts), io: { ...defaultIo, fsync: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } } })).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    const out = partial();
    const short: PipelineIo = { ...defaultIo, write: (fd, b, off, len, pos) => defaultIo.write(fd, b, off, Math.min(len, 1000), pos) };
    const enc = await encryptFileToFd(src, out.fd, { ...writerOpts(facts), io: short });
    assertVerifiedMatches(facts, enc, await verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: MiB }));
  });

  it('a run-time KDF failure surfaces as KDF_FAILED and nothing is written', async () => {
    const src = source(MiB);
    const out = partial();
    const real = crypto.scrypt;
    (crypto as any).scrypt = (_p: any, _s: any, _l: any, _o: any, cb: any) => cb(new Error('out of memory'));
    try {
      await expect(encryptFileToFd(src, out.fd, writerOpts(factsFor(MiB)))).rejects.toMatchObject({ code: 'KDF_FAILED' });
    } finally {
      (crypto as any).scrypt = real;
    }
    expect(fs.statSync(out.path).size).toBe(0);
  });
});

describe('verification rejects anything that is not exactly the backup', () => {
  let src: string; let facts: SnapshotFacts; let out: { fd: number; path: string }; let enc: EncryptResult;
  beforeEach(async () => {
    src = source(MiB + 777);
    facts = factsFor(MiB + 777);
    out = partial();
    enc = await encryptFileToFd(src, out.fd, writerOpts(facts));
  });
  const reopen = (bytes: Buffer) => { const p = partial(); fs.writeSync(p.fd, bytes, 0, bytes.length, 0); return p.fd; };

  it('wrong password', async () => {
    await expect(verifyEncryptedFd(out.fd, 'wrong password 1', { maxPlaintextBytes: MiB * 2 })).rejects.toMatchObject({ code: 'WRONG_SECRET_OR_HEADER_DAMAGED' });
  });

  it('a flipped bit in a record, truncation, appended bytes and a damaged header are all refused', async () => {
    const good = fs.readFileSync(out.path);
    const flipped = Buffer.from(good); flipped[good.length - 100] ^= 1;
    await expect(verifyEncryptedFd(reopen(flipped), SECRET, { maxPlaintextBytes: MiB * 2 })).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(verifyEncryptedFd(reopen(good.subarray(0, good.length - 10)), SECRET, { maxPlaintextBytes: MiB * 2 })).rejects.toMatchObject({ code: 'TRUNCATED' });
    await expect(verifyEncryptedFd(reopen(Buffer.concat([good, Buffer.from([0])])), SECRET, { maxPlaintextBytes: MiB * 2 })).rejects.toMatchObject({ code: 'TRAILING_DATA' });
    const header = Buffer.from(good); header[20] ^= 1;
    await expect(verifyEncryptedFd(reopen(header), SECRET, { maxPlaintextBytes: MiB * 2 })).rejects.toBeTruthy();
    await expect(verifyEncryptedFd(reopen(Buffer.alloc(0)), SECRET, { maxPlaintextBytes: MiB * 2 })).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
  });

  it('the plaintext limit is enforced while verifying; an oversized file is refused before reading', async () => {
    await expect(verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: MiB })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    let reads = 0;
    const huge: PipelineIo = { ...defaultIo, fstat: async () => ({ size: 10 * 1024 ** 3, isFile: () => true }), read: async (...a) => { reads++; return defaultIo.read(...a); } };
    await expect(verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: MiB * 2, io: huge })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(reads).toBe(0);
  });

  it('assertVerifiedMatches: any differing field is VERIFY_FAILED mismatch', async () => {
    const ver = await verifyEncryptedFd(out.fd, SECRET, { maxPlaintextBytes: MiB * 2 });
    assertVerifiedMatches(facts, enc, ver);
    const bad: Array<[SnapshotFacts, EncryptResult, VerifyResult]> = [
      [{ ...facts, bytes: facts.bytes + 1 }, enc, ver],
      [{ ...facts, rowCounts: { ...facts.rowCounts, products: 8 } }, enc, ver],
      [{ ...facts, schemaVersion: 12 }, enc, ver],
      [{ ...facts, pageCount: facts.pageCount + 1 }, enc, ver],
      [facts, { ...enc, plaintextSha256: '0'.repeat(64) }, ver],
      [facts, { ...enc, dataRecords: enc.dataRecords + 1 }, ver],
      [facts, { ...enc, fileBytes: enc.fileBytes - 1 }, ver],
      [facts, enc, { ...ver, plaintextBytes: ver.plaintextBytes - 1 }],
      [facts, enc, { ...ver, plaintextSha256: 'f'.repeat(64) }],
      [facts, enc, { ...ver, info: { ...ver.info, backupId: crypto.randomUUID() } }],
      [facts, enc, { ...ver, manifest: { ...ver.manifest, meta: { ...ver.manifest.meta, integrity: 'unknown' } } }],
    ];
    for (const [f, e, v] of bad) expect(() => assertVerifiedMatches(f, e, v)).toThrow(expect.objectContaining({ code: 'VERIFY_FAILED', stage: 'mismatch' }));
  });
});
