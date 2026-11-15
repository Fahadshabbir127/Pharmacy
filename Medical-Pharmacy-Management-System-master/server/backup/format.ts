/**
 * Phase 9A.1: the .btbackup file format, version 1 (encoding and decoding only; no database access).
 *
 * FILE LAYOUT (all integers big-endian)
 *
 *   preamble  16 B   "BTBACKUP" (8) | u16 formatVersion = 1 | u16 flags = 0 | u32 headerLength (2 .. 65536)
 *   header    n B    UTF-8 JSON, canonical (exactly the bytes JSON.stringify produces for the validated header)
 *   headerMac 32 B   HMAC-SHA256(macKey, preamble || header)
 *   record*          one or more records, see below; the last one is the FINAL record; nothing may follow it
 *
 * RECORD FRAME
 *
 *   type      u8     0x01 DATA, 0x02 FINAL (the encrypted manifest); any other value is rejected
 *   index     u32    0, 1, 2, ... (must equal the reader's own count of records read so far)
 *   length    u32    ciphertext length: DATA 1 .. chunkSize, FINAL 1 .. 65536
 *   ciphertext length B
 *   tag       16 B   AES-256-GCM authentication tag
 *
 *   nonce = header.aead.noncePrefix (8 random bytes per file) || u32(index)       -> unique per record and file
 *   AAD   = SHA-256(preamble || header || headerMac) || type || index || length  -> the 9-byte frame header
 *
 * Why the record sequence is unambiguous:
 * - the record type is written in clear (so the reader knows how to bound the length BEFORE reading the body) and
 *   is also authenticated (it is part of the AAD): changing DATA into FINAL or back fails authentication
 * - the index the reader checks and authenticates is the reader's own counter, not a value it trusts from the file:
 *   a moved, removed, duplicated or inserted record has the wrong index or fails authentication
 * - the header hash in the AAD ties every record to this file: a record copied from another backup fails
 * - exactly one FINAL record ends the file: the reader stops there and refuses any byte after it (TRAILING_DATA);
 *   if the input ends before a FINAL record the file is TRUNCATED; an attacker cannot forge a FINAL record
 * - canonical chunking: every DATA record except the last has exactly chunkSize bytes, so one plaintext has one
 *   valid record layout
 * - the FINAL record's manifest repeats the number of DATA records, the plaintext size and its SHA-256, and the
 *   reader checks all three against what it decrypted
 *
 * The header is checked in this order, each step before any expensive work: magic, version, flags, header length,
 * JSON shape and canonical form, KDF bounds, then the (expensive) key derivation, then the header MAC.
 */
import crypto from 'node:crypto';
import { BackupError } from './errors';
import { assertKdfParams, deriveKeys, newSalt, SALT_BYTES, type DerivedKeys, type ScryptParams } from './kdf';

export const MAGIC = Buffer.from('BTBACKUP', 'ascii');
export const FORMAT_VERSION = 1;
export const PREAMBLE_BYTES = 16;
export const MAC_BYTES = 32;
export const MIN_HEADER_BYTES = 2;
export const MAX_HEADER_BYTES = 64 * 1024;
export const FRAME_HEADER_BYTES = 9;
export const TAG_BYTES = 16;
export const NONCE_PREFIX_BYTES = 8;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MAX_RECORD_INDEX = 0xffffffff;

export const RecordType = { DATA: 0x01, FINAL: 0x02 } as const;

export interface BackupHeader {
  backupId: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  kind: string;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  aead: { alg: 'aes-256-gcm'; chunkSize: number; noncePrefix: string };
  payload: 'sqlite3';
}

/** What a caller may see of a header: no salt and no nonce prefix. */
export interface BackupHeaderInfo {
  formatVersion: number;
  backupId: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  kind: string;
  kdf: ScryptParams;
  chunkSize: number;
  payload: 'sqlite3';
}

export interface BackupManifest {
  dataRecords: number;
  plaintextSize: number;
  plaintextSha256: string;
  /** engine-defined details (row counts, page size, ...); a plain JSON object */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// header validation

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const APP_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const hasExactKeys = (o: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
/** strict base64 that decodes to exactly `bytes` bytes and re-encodes to the same text */
const canonicalBase64 = (s: unknown, bytes: number): Buffer | null => {
  if (typeof s !== 'string' || s.length > 4 * Math.ceil(bytes / 3)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === bytes && b.toString('base64') === s ? b : null;
};

interface ParsedHeader { header: BackupHeader; salt: Buffer; noncePrefix: Buffer; kdf: ScryptParams }

/**
 * Validate a header object and rebuild it with the fixed key order. Throws HEADER_INVALID for any shape problem and
 * KDF_PARAMS_REJECTED for out-of-bounds scrypt parameters (both cheap; no key derivation here).
 */
function validateHeader(raw: unknown): ParsedHeader {
  const bad = () => new BackupError('HEADER_INVALID', 'header');
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['backupId', 'createdAt', 'appVersion', 'schemaVersion', 'kind', 'kdf', 'aead', 'payload'])) throw bad();
  const { backupId, createdAt, appVersion, schemaVersion, kind, kdf, aead, payload } = raw;
  if (typeof backupId !== 'string' || !UUID.test(backupId)) throw bad();
  if (typeof createdAt !== 'string' || !ISO_UTC.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw bad();
  if (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion)) throw bad();
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 0 || (schemaVersion as number) > 1_000_000) throw bad();
  if (typeof kind !== 'string' || !KIND.test(kind)) throw bad();
  if (payload !== 'sqlite3') throw bad();
  if (!isPlainObject(kdf) || !hasExactKeys(kdf, ['alg', 'N', 'r', 'p', 'salt']) || kdf.alg !== 'scrypt') throw bad();
  if (!isPlainObject(aead) || !hasExactKeys(aead, ['alg', 'chunkSize', 'noncePrefix']) || aead.alg !== 'aes-256-gcm') throw bad();
  const chunkSize = aead.chunkSize;
  if (!Number.isSafeInteger(chunkSize) || (chunkSize as number) < MIN_CHUNK_SIZE || (chunkSize as number) > MAX_CHUNK_SIZE) throw bad();
  const salt = canonicalBase64(kdf.salt, SALT_BYTES);
  const noncePrefix = canonicalBase64(aead.noncePrefix, NONCE_PREFIX_BYTES);
  if (!salt || !noncePrefix) throw bad();
  const params = { N: kdf.N, r: kdf.r, p: kdf.p };
  assertKdfParams(params); // KDF_PARAMS_REJECTED before anything expensive
  const header: BackupHeader = {
    backupId, createdAt, appVersion, schemaVersion: schemaVersion as number, kind,
    kdf: { alg: 'scrypt', N: params.N, r: params.r, p: params.p, salt: kdf.salt as string },
    aead: { alg: 'aes-256-gcm', chunkSize: chunkSize as number, noncePrefix: aead.noncePrefix as string },
    payload: 'sqlite3',
  };
  return { header, salt, noncePrefix, kdf: params };
}

const headerInfo = (h: BackupHeader): BackupHeaderInfo => ({
  formatVersion: FORMAT_VERSION, backupId: h.backupId, createdAt: h.createdAt, appVersion: h.appVersion,
  schemaVersion: h.schemaVersion, kind: h.kind, kdf: { N: h.kdf.N, r: h.kdf.r, p: h.kdf.p }, chunkSize: h.aead.chunkSize, payload: h.payload,
});

/** Check only the 16-byte preamble. Returns the header length. */
export function parsePreamble(pre: Buffer): { version: number; flags: number; headerLength: number } {
  if (pre.length < PREAMBLE_BYTES || !pre.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('NOT_A_BACKUP', 'header');
  const version = pre.readUInt16BE(8);
  const flags = pre.readUInt16BE(10);
  const headerLength = pre.readUInt32BE(12);
  if (version !== FORMAT_VERSION || flags !== 0) throw new BackupError('UNSUPPORTED_VERSION', 'header');
  if (headerLength < MIN_HEADER_BYTES || headerLength > MAX_HEADER_BYTES) throw new BackupError('HEADER_INVALID', 'header');
  return { version, flags, headerLength };
}

function parseHeaderJson(bytes: Buffer): ParsedHeader {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new BackupError('HEADER_INVALID', 'header'); // invalid UTF-8
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new BackupError('HEADER_INVALID', 'header'); }
  const parsed = validateHeader(raw);
  if (JSON.stringify(parsed.header) !== text) throw new BackupError('HEADER_INVALID', 'header'); // one byte form only
  return parsed;
}

// ---------------------------------------------------------------------------------------------------------------
// record helpers

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const frameHeader = (type: number, index: number, length: number) => {
  const b = Buffer.alloc(FRAME_HEADER_BYTES);
  b[0] = type; b.writeUInt32BE(index, 1); b.writeUInt32BE(length, 5);
  return b;
};
const nonceFor = (prefix: Buffer, index: number) => Buffer.concat([prefix, u32(index)]);

function sealRecord(key: Buffer, prefix: Buffer, headerHash: Buffer, type: number, index: number, plaintext: Buffer): Buffer {
  const fh = frameHeader(type, index, plaintext.length);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(prefix, index), { authTagLength: TAG_BYTES });
  c.setAAD(Buffer.concat([headerHash, fh]));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([fh, ct, c.getAuthTag()]);
}

function openRecord(key: Buffer, prefix: Buffer, headerHash: Buffer, fh: Buffer, index: number, body: Buffer): Buffer {
  const ct = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index), { authTagLength: TAG_BYTES });
    d.setAAD(Buffer.concat([headerHash, fh]));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new BackupError('CORRUPT', 'record');
  }
}

function validateMeta(meta: unknown): Record<string, unknown> {
  if (!isPlainObject(meta)) throw new BackupError('MANIFEST_INVALID', 'manifest');
  return meta;
}

// ---------------------------------------------------------------------------------------------------------------
// writer

export interface BackupWriterOptions {
  secret: string;
  /** explicit scrypt parameters (no hidden default) */
  kdf: ScryptParams;
  chunkSize?: number;
  appVersion: string;
  schemaVersion: number;
  kind: string;
  backupId?: string;
  createdAt?: string;
}

/**
 * Streaming encoder. `header` holds the first bytes of the file; `push` and `finish` return the record bytes to
 * write after it, in order. Keys are wiped by `finish` and `abort`.
 */
export class BackupWriter {
  readonly header: Buffer;
  readonly info: BackupHeaderInfo;
  private keys: DerivedKeys | null;
  private readonly noncePrefix: Buffer;
  private readonly headerHash: Buffer;
  private readonly chunkSize: number;
  private readonly pending: Buffer;
  private pendingLength = 0;
  private index = 0;
  private dataRecords = 0;
  private size = 0;
  private readonly hash = crypto.createHash('sha256');
  private state: 'open' | 'done' | 'aborted' = 'open';

  private constructor(header: Buffer, info: BackupHeaderInfo, keys: DerivedKeys, noncePrefix: Buffer, chunkSize: number) {
    this.header = header; this.info = info; this.keys = keys; this.noncePrefix = noncePrefix; this.chunkSize = chunkSize;
    this.headerHash = crypto.createHash('sha256').update(header).digest();
    this.pending = Buffer.alloc(chunkSize);
  }

  static async create(o: BackupWriterOptions): Promise<BackupWriter> {
    const salt = newSalt();
    const noncePrefix = crypto.randomBytes(NONCE_PREFIX_BYTES);
    const { header, kdf } = validateHeader({
      backupId: o.backupId ?? crypto.randomUUID(),
      createdAt: o.createdAt ?? new Date().toISOString(),
      appVersion: o.appVersion,
      schemaVersion: o.schemaVersion,
      kind: o.kind,
      kdf: { alg: 'scrypt', N: o.kdf?.N, r: o.kdf?.r, p: o.kdf?.p, salt: salt.toString('base64') },
      aead: { alg: 'aes-256-gcm', chunkSize: o.chunkSize ?? DEFAULT_CHUNK_SIZE, noncePrefix: noncePrefix.toString('base64') },
      payload: 'sqlite3',
    });
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    if (json.length > MAX_HEADER_BYTES) throw new BackupError('HEADER_INVALID', 'header');
    const keys = await deriveKeys(o.secret, salt, kdf);
    const pre = Buffer.alloc(PREAMBLE_BYTES);
    MAGIC.copy(pre, 0); pre.writeUInt16BE(FORMAT_VERSION, 8); pre.writeUInt16BE(0, 10); pre.writeUInt32BE(json.length, 12);
    const mac = crypto.createHmac('sha256', keys.macKey).update(pre).update(json).digest();
    return new BackupWriter(Buffer.concat([pre, json, mac]), headerInfo(header), keys, noncePrefix, header.aead.chunkSize);
  }

  private assertOpen() { if (this.state !== 'open' || !this.keys) throw new Error('BackupWriter is closed'); }

  private seal(type: number, plaintext: Buffer): Buffer {
    if (this.index > MAX_RECORD_INDEX) throw new BackupError('RECORD_INVALID', 'record');
    const rec = sealRecord(this.keys!.encKey, this.noncePrefix, this.headerHash, type, this.index, plaintext);
    this.index++;
    return rec;
  }

  private flushChunk(out: Buffer[]) {
    out.push(this.seal(RecordType.DATA, this.pending.subarray(0, this.pendingLength)));
    this.dataRecords++;
    this.pendingLength = 0;
  }

  /** Add plaintext. Returns the complete DATA records it produced (possibly none). */
  push(data: Buffer): Buffer[] {
    this.assertOpen();
    const out: Buffer[] = [];
    this.hash.update(data);
    this.size += data.length;
    let offset = 0;
    while (offset < data.length) {
      const n = Math.min(this.chunkSize - this.pendingLength, data.length - offset);
      data.copy(this.pending, this.pendingLength, offset, offset + n);
      this.pendingLength += n; offset += n;
      if (this.pendingLength === this.chunkSize) this.flushChunk(out);
    }
    return out;
  }

  /** Write the last (short) DATA record, if any, and the FINAL manifest record. Wipes the keys. */
  finish(meta: Record<string, unknown> = {}): Buffer[] {
    this.assertOpen();
    try {
      const out: Buffer[] = [];
      if (this.pendingLength > 0) this.flushChunk(out);
      const manifest: BackupManifest = { dataRecords: this.dataRecords, plaintextSize: this.size, plaintextSha256: this.hash.digest('hex'), meta: validateMeta(meta) };
      const body = Buffer.from(JSON.stringify(manifest), 'utf8');
      if (body.length > MAX_MANIFEST_BYTES) throw new BackupError('MANIFEST_INVALID', 'manifest');
      out.push(this.seal(RecordType.FINAL, body));
      this.state = 'done';
      return out;
    } finally {
      this.close();
    }
  }

  abort() { if (this.state === 'open') this.state = 'aborted'; this.close(); }

  private close() {
    if (this.state === 'open') this.state = 'aborted';
    this.keys?.wipe(); this.keys = null;
    this.pending.fill(0); this.pendingLength = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// reader

class ByteQueue {
  private parts: Buffer[] = [];
  private first = 0; // index of the first unread part (avoids O(n) shifts with many small pieces)
  length = 0;
  push(b: Buffer) { if (b.length) { this.parts.push(Buffer.from(b)); this.length += b.length; } } // own copy
  /** copy the first n bytes (n <= length) without removing them */
  peek(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (let i = this.first; filled < n; i++) filled += this.parts[i].copy(out, filled, 0, Math.min(this.parts[i].length, n - filled));
    return out;
  }
  /** remove and return exactly n bytes (n <= length) */
  take(n: number): Buffer {
    const out = this.peek(n);
    let left = n;
    while (left > 0) {
      const head = this.parts[this.first];
      if (head.length <= left) { left -= head.length; this.parts[this.first++] = EMPTY; }
      else { this.parts[this.first] = head.subarray(left); left = 0; }
    }
    if (this.first > 1024 && this.first * 2 > this.parts.length) { this.parts = this.parts.slice(this.first); this.first = 0; }
    this.length -= n;
    return out;
  }
  clear() { for (let i = this.first; i < this.parts.length; i++) this.parts[i].fill(0); this.parts = []; this.first = 0; this.length = 0; }
}
const EMPTY = Buffer.alloc(0);

type ReaderState = 'preamble' | 'header' | 'frame' | 'body' | 'done' | 'failed';

export interface BackupReaderOptions {
  /** refuse the file (FILE_TOO_LARGE) as soon as its DATA records would exceed this many plaintext bytes */
  maxPlaintextBytes?: number;
}

/**
 * Streaming decoder. Feed the file with `push` (await each call; calls must not overlap) and collect the
 * decrypted DATA chunks it returns; then call `end()`, which returns the verified manifest. Any problem throws a
 * BackupError and the reader stays failed. Decrypted chunks are only trustworthy as a whole after `end()` succeeds.
 */
export class BackupReader {
  private readonly secret: string;
  private state: ReaderState = 'preamble';
  private failure: BackupError | null = null;
  private readonly q = new ByteQueue();
  private busy = false;
  private preamble: Buffer | null = null;
  private headerLength = 0;
  private parsed: ParsedHeader | null = null;
  private headerHash: Buffer | null = null;
  private keys: DerivedKeys | null = null;
  private index = 0;
  private dataRecords = 0;
  private lastDataShort = false;
  private size = 0;
  private readonly hash = crypto.createHash('sha256');
  private frame: { type: number; length: number; bytes: Buffer } | null = null;
  private manifest: BackupManifest | null = null;

  private readonly maxPlaintextBytes: number | null;

  constructor(secret: string, options?: BackupReaderOptions) {
    this.secret = secret;
    const max = options?.maxPlaintextBytes;
    if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) throw new TypeError('maxPlaintextBytes must be a positive safe integer');
    this.maxPlaintextBytes = max ?? null;
  }

  /** header details (no salt or nonce), available once the header has been authenticated */
  get info(): BackupHeaderInfo | null { return this.headerHash && this.parsed ? headerInfo(this.parsed.header) : null; }

  async push(chunk: Buffer): Promise<Buffer[]> {
    if (this.busy) throw new Error('BackupReader.push calls must not overlap');
    this.busy = true;
    try {
      if (this.failure) throw this.failure;
      if (this.state === 'done') { if (chunk.length) throw new BackupError('TRAILING_DATA', 'record'); return []; }
      this.q.push(chunk);
      const out = await this.drain();
      // end() may have failed the reader while this push was suspended: never hand out its decrypted chunks
      if (this.failure) { for (const b of out) b.fill(0); throw this.failure; }
      return out;
    } catch (e) {
      throw this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  /** The input is complete. Returns the verified manifest, or throws (TRUNCATED, ...). */
  end(): { info: BackupHeaderInfo; manifest: BackupManifest } {
    if (this.failure) throw this.failure;
    // the input was declared complete while a push is still being processed (e.g. during key derivation): the
    // reader fails for good; the in-flight push sees the failure, wipes any keys it derived and rejects
    if (this.busy) throw this.fail(new BackupError('TRUNCATED', this.state === 'preamble' || this.state === 'header' ? 'header' : 'record'));
    if (this.state !== 'done' || !this.manifest || !this.parsed) {
      // a few bytes that are not even the start of the magic are "not a backup", not "truncated"
      if (this.state === 'preamble') {
        const head = this.q.length ? this.q.peek(Math.min(this.q.length, MAGIC.length)) : Buffer.alloc(0);
        if (!MAGIC.subarray(0, head.length).equals(head) || head.length === 0) throw this.fail(new BackupError('NOT_A_BACKUP', 'header'));
      }
      throw this.fail(new BackupError('TRUNCATED', this.state === 'preamble' || this.state === 'header' ? 'header' : 'record'));
    }
    return { info: headerInfo(this.parsed.header), manifest: this.manifest };
  }

  private fail(e: unknown): BackupError {
    const err = e instanceof BackupError ? e : new BackupError('CORRUPT', 'record');
    if (!this.failure) this.failure = err;
    this.state = 'failed';
    this.wipe();
    return this.failure;
  }

  private wipe() { this.keys?.wipe(); this.keys = null; this.q.clear(); }

  private async drain(): Promise<Buffer[]> {
    const out: Buffer[] = [];
    for (;;) {
      switch (this.state) {
        case 'preamble': {
          // reject a wrong magic as early as possible, even before 16 bytes have arrived
          const head = this.q.peek(Math.min(this.q.length, MAGIC.length));
          if (!MAGIC.subarray(0, head.length).equals(head)) throw new BackupError('NOT_A_BACKUP', 'header');
          if (this.q.length < PREAMBLE_BYTES) return out;
          this.preamble = this.q.take(PREAMBLE_BYTES);
          this.headerLength = parsePreamble(this.preamble).headerLength;
          this.state = 'header';
          break;
        }
        case 'header': {
          if (this.q.length < this.headerLength + MAC_BYTES) return out;
          const json = this.q.take(this.headerLength);
          const mac = this.q.take(MAC_BYTES);
          const parsed = parseHeaderJson(json); // shape + KDF bounds, cheap
          const keys = await deriveKeys(this.secret, parsed.salt, parsed.kdf); // expensive, bounded
          // the reader may have failed while the keys were being derived (end() called meanwhile): never return to an
          // active state; wipe the new keys and stop
          if (this.failure || this.state !== 'header') {
            keys.wipe();
            throw this.failure ?? new BackupError('CORRUPT', 'record');
          }
          this.keys = keys;
          const expected = crypto.createHmac('sha256', this.keys.macKey).update(this.preamble!).update(json).digest();
          if (!crypto.timingSafeEqual(expected, mac)) throw new BackupError('WRONG_SECRET_OR_HEADER_DAMAGED', 'header');
          this.parsed = parsed;
          this.headerHash = crypto.createHash('sha256').update(this.preamble!).update(json).update(mac).digest();
          this.state = 'frame';
          break;
        }
        case 'frame': {
          if (this.q.length < FRAME_HEADER_BYTES) return out;
          const bytes = this.q.take(FRAME_HEADER_BYTES);
          const type = bytes[0];
          const index = bytes.readUInt32BE(1);
          const length = bytes.readUInt32BE(5);
          if (type !== RecordType.DATA && type !== RecordType.FINAL) throw new BackupError('RECORD_INVALID', 'record');
          if (index !== this.index) throw new BackupError('CORRUPT', 'record'); // moved, removed or inserted record
          const max = type === RecordType.DATA ? this.parsed!.header.aead.chunkSize : MAX_MANIFEST_BYTES;
          if (length < 1 || length > max) throw new BackupError('RECORD_INVALID', 'record');
          if (type === RecordType.DATA && this.lastDataShort) throw new BackupError('RECORD_INVALID', 'record'); // non-canonical chunking
          // size limit, checked before the record body is read or decrypted
          if (type === RecordType.DATA && this.maxPlaintextBytes !== null && this.size + length > this.maxPlaintextBytes) throw new BackupError('FILE_TOO_LARGE', 'record');
          this.frame = { type, length, bytes };
          this.state = 'body';
          break;
        }
        case 'body': {
          const f = this.frame!;
          if (this.q.length < f.length + TAG_BYTES) return out;
          const body = this.q.take(f.length + TAG_BYTES);
          const plain = openRecord(this.keys!.encKey, this.parsed!.noncePrefix, this.headerHash!, f.bytes, this.index, body);
          this.index++;
          this.frame = null;
          if (f.type === RecordType.DATA) {
            this.dataRecords++;
            this.size += plain.length;
            this.hash.update(plain);
            this.lastDataShort = plain.length < this.parsed!.header.aead.chunkSize;
            out.push(plain);
            this.state = 'frame';
          } else {
            this.manifest = this.checkManifest(plain);
            this.state = 'done';
            this.keys!.wipe(); this.keys = null;
            if (this.q.length > 0) throw new BackupError('TRAILING_DATA', 'record');
            return out;
          }
          break;
        }
        default:
          return out;
      }
    }
  }

  private checkManifest(plain: Buffer): BackupManifest {
    const bad = () => new BackupError('MANIFEST_INVALID', 'manifest');
    let m: unknown;
    try { m = JSON.parse(plain.toString('utf8')); } catch { throw bad(); }
    if (!isPlainObject(m) || !hasExactKeys(m, ['dataRecords', 'plaintextSize', 'plaintextSha256', 'meta'])) throw bad();
    const digest = this.hash.digest('hex');
    if (m.dataRecords !== this.dataRecords || m.plaintextSize !== this.size || m.plaintextSha256 !== digest) throw bad();
    return { dataRecords: this.dataRecords, plaintextSize: this.size, plaintextSha256: digest, meta: validateMeta(m.meta) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// whole-buffer helpers (tests and small payloads)

export async function encodeBackup(payload: Buffer, o: BackupWriterOptions & { meta?: Record<string, unknown> }): Promise<Buffer> {
  const w = await BackupWriter.create(o);
  try {
    return Buffer.concat([w.header, ...w.push(payload), ...w.finish(o.meta ?? {})]);
  } finally {
    w.abort();
  }
}

export async function decodeBackup(file: Buffer, secret: string, pieceSize = file.length || 1, options?: BackupReaderOptions): Promise<{ info: BackupHeaderInfo; manifest: BackupManifest; data: Buffer }> {
  const r = new BackupReader(secret, options);
  const parts: Buffer[] = [];
  for (let i = 0; i < file.length; i += pieceSize) parts.push(...await r.push(file.subarray(i, i + pieceSize)));
  const { info, manifest } = r.end();
  return { info, manifest, data: Buffer.concat(parts) };
}
