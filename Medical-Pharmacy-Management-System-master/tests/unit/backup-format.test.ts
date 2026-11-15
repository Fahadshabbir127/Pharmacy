/**
 * Phase 9A.1: .btbackup encoding and decoding (server/backup/format.ts): round trips, header and record tampering,
 * wrong password, record type/order framing, truncation, insertion, removal, appended data, unsupported versions,
 * hostile header values, and no secrets in errors or logs.
 * Uses the lowest accepted scrypt work factor (N = 2^15) and the smallest chunk size so records are numerous.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  BackupReader, BackupWriter, decodeBackup, encodeBackup, FRAME_HEADER_BYTES, MAC_BYTES, MAGIC, MIN_CHUNK_SIZE,
  PREAMBLE_BYTES, RecordType, TAG_BYTES,
} from '../../server/backup/format';
import { BackupError } from '../../server/backup/errors';
import { deriveKeys } from '../../server/backup/kdf';

const FAST = { N: 2 ** 15, r: 8, p: 1 };
const SECRET = 'Backup-Pässword 42';
const CHUNK = MIN_CHUNK_SIZE;
const base = { secret: SECRET, kdf: FAST, chunkSize: CHUNK, appVersion: '1.0.0', schemaVersion: 11, kind: 'manual' };

/** 3 full chunks and a short one */
const payload = crypto.randomBytes(CHUNK * 3 + 1234);
let file: Buffer;

interface Rec { offset: number; type: number; index: number; length: number; end: number }
const headerEnd = (f: Buffer) => PREAMBLE_BYTES + f.readUInt32BE(12) + MAC_BYTES;
function records(f: Buffer): Rec[] {
  const out: Rec[] = [];
  let o = headerEnd(f);
  while (o < f.length) {
    const length = f.readUInt32BE(o + 5);
    const end = o + FRAME_HEADER_BYTES + length + TAG_BYTES;
    out.push({ offset: o, type: f[o], index: f.readUInt32BE(o + 1), length, end });
    o = end;
  }
  return out;
}
const slice = (f: Buffer, r: Rec) => f.subarray(r.offset, r.end);
const headerJson = (f: Buffer) => f.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + f.readUInt32BE(12)).toString('utf8');

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(BackupError);
  await expect(p).rejects.toMatchObject({ code });
}

/** rebuild a file with a changed header JSON, re-MACed with the right key (so only the change itself is tested) */
async function withHeader(f: Buffer, edit: (h: any) => void, opts: { remac?: boolean } = { remac: true }): Promise<Buffer> {
  const h = JSON.parse(headerJson(f));
  edit(h);
  const json = Buffer.from(JSON.stringify(h), 'utf8');
  const pre = Buffer.from(f.subarray(0, PREAMBLE_BYTES));
  pre.writeUInt32BE(json.length, 12);
  let mac = f.subarray(PREAMBLE_BYTES + f.readUInt32BE(12), headerEnd(f));
  if (opts.remac) {
    const orig = JSON.parse(headerJson(f));
    const keys = await deriveKeys(SECRET, Buffer.from(orig.kdf.salt, 'base64'), FAST);
    mac = crypto.createHmac('sha256', keys.macKey).update(pre).update(json).digest();
  }
  return Buffer.concat([pre, json, mac, f.subarray(headerEnd(f))]);
}

beforeAll(async () => { file = await encodeBackup(payload, { ...base, meta: { rowCounts: { sales: 3 } } }); });
afterEach(() => vi.restoreAllMocks());

describe('round trip', () => {
  it('encodes and decodes the payload, the header info and the manifest', async () => {
    expect(file.subarray(0, 8).equals(MAGIC)).toBe(true);
    const { data, info, manifest } = await decodeBackup(file, SECRET);
    expect(data.equals(payload)).toBe(true);
    expect(info).toMatchObject({ formatVersion: 1, appVersion: '1.0.0', schemaVersion: 11, kind: 'manual', kdf: FAST, chunkSize: CHUNK, payload: 'sqlite3' });
    expect(info).not.toHaveProperty('salt');
    expect(JSON.stringify(info)).not.toContain(JSON.parse(headerJson(file)).kdf.salt);
    expect(manifest).toEqual({ dataRecords: 4, plaintextSize: payload.length, plaintextSha256: crypto.createHash('sha256').update(payload).digest('hex'), meta: { rowCounts: { sales: 3 } } });
  });

  it('has the documented record layout: DATA 0..3 (full chunks, then the short one), then one FINAL', () => {
    const rs = records(file);
    expect(rs.map((r) => [r.type, r.index])).toEqual([[1, 0], [1, 1], [1, 2], [1, 3], [2, 4]]);
    expect(rs.slice(0, 3).every((r) => r.length === CHUNK)).toBe(true);
    expect(rs[3].length).toBe(1234);
    expect(rs[4].end).toBe(file.length);
  });

  it('decodes when fed in small and odd-sized pieces (streaming)', async () => {
    for (const piece of [1, 7, 4096, CHUNK + 3]) {
      const { data } = await decodeBackup(file, SECRET, piece);
      expect(data.equals(payload)).toBe(true);
    }
  });

  it('handles an empty payload and a payload of exactly one chunk', async () => {
    const empty = await encodeBackup(Buffer.alloc(0), base);
    expect(records(empty).map((r) => r.type)).toEqual([RecordType.FINAL]);
    expect((await decodeBackup(empty, SECRET)).data.length).toBe(0);
    const one = crypto.randomBytes(CHUNK);
    const f = await encodeBackup(one, base);
    expect(records(f).map((r) => r.type)).toEqual([1, 2]);
    expect((await decodeBackup(f, SECRET)).data.equals(one)).toBe(true);
  });

  it('the writer produces the same bytes however the input is split', async () => {
    const w = await BackupWriter.create(base);
    const parts: Buffer[] = [w.header];
    for (let i = 0; i < payload.length; i += 5000) parts.push(...w.push(payload.subarray(i, i + 5000)));
    parts.push(...w.finish());
    const { data, manifest } = await decodeBackup(Buffer.concat(parts), SECRET);
    expect(data.equals(payload)).toBe(true);
    expect(manifest.dataRecords).toBe(4);
    expect(() => w.push(Buffer.from('x'))).toThrow(); // closed after finish
  });

  it('every file has a fresh salt, nonce prefix and backup id; equal input gives different ciphertext', async () => {
    const a = await encodeBackup(payload.subarray(0, 100), base);
    const b = await encodeBackup(payload.subarray(0, 100), base);
    const ha = JSON.parse(headerJson(a)); const hb = JSON.parse(headerJson(b));
    expect(ha.kdf.salt).not.toBe(hb.kdf.salt);
    expect(ha.aead.noncePrefix).not.toBe(hb.aead.noncePrefix);
    expect(ha.backupId).not.toBe(hb.backupId);
    expect(a.subarray(headerEnd(a)).equals(b.subarray(headerEnd(b)))).toBe(false);
  });

  it('the password is normalised (NFC): a decomposed spelling opens a file made with the composed one', async () => {
    const decomposed = SECRET.normalize('NFD');
    expect(decomposed).not.toBe(SECRET);
    expect((await decodeBackup(file, decomposed)).data.equals(payload)).toBe(true);
  });

  it('the writer refuses bad options before deriving anything', async () => {
    const spy = vi.spyOn(crypto, 'scrypt');
    await expectCode(BackupWriter.create({ ...base, kdf: { N: 2 ** 22, r: 8, p: 1 } }), 'KDF_PARAMS_REJECTED');
    await expectCode(BackupWriter.create({ ...base, kdf: undefined as any }), 'KDF_PARAMS_REJECTED');
    await expectCode(BackupWriter.create({ ...base, chunkSize: 1024 }), 'HEADER_INVALID');
    await expectCode(BackupWriter.create({ ...base, chunkSize: 64 * 1024 * 1024 }), 'HEADER_INVALID');
    await expectCode(BackupWriter.create({ ...base, kind: 'Bad Kind!' }), 'HEADER_INVALID');
    await expectCode(BackupWriter.create({ ...base, appVersion: '' }), 'HEADER_INVALID');
    await expectCode(BackupWriter.create({ ...base, schemaVersion: -1 }), 'HEADER_INVALID');
    expect(spy).not.toHaveBeenCalled();
    await expectCode(BackupWriter.create({ ...base, secret: '' }), 'EMPTY_SECRET');
  });

  it('the manifest meta must be a plain object', async () => {
    const w = await BackupWriter.create(base);
    expect(() => w.finish([1, 2] as any)).toThrow(expect.objectContaining({ code: 'MANIFEST_INVALID' }));
  });
});

describe('wrong password and header tampering', () => {
  it('a wrong password is reported as WRONG_SECRET_OR_HEADER_DAMAGED, before any record is decrypted', async () => {
    await expectCode(decodeBackup(file, 'wrong password 42'), 'WRONG_SECRET_OR_HEADER_DAMAGED');
    await expectCode(decodeBackup(file, SECRET + ' '), 'WRONG_SECRET_OR_HEADER_DAMAGED');
  });

  it('changing any header field (keeping valid JSON) fails the header MAC', async () => {
    const edits: Array<(h: any) => void> = [
      (h) => { h.appVersion = '9.9.9'; },
      (h) => { h.schemaVersion = 12; },
      (h) => { h.kind = 'scheduled'; },
      (h) => { h.createdAt = '2030-01-01T00:00:00.000Z'; },
      (h) => { h.aead.chunkSize = CHUNK * 2; },
      (h) => { h.aead.noncePrefix = Buffer.alloc(8, 1).toString('base64'); },
    ];
    for (const e of edits) await expectCode(decodeBackup(await withHeader(file, e, { remac: false }), SECRET), 'WRONG_SECRET_OR_HEADER_DAMAGED');
  });

  it('changing the salt or the work factor changes the keys, so the MAC fails', async () => {
    await expectCode(decodeBackup(await withHeader(file, (h) => { h.kdf.salt = Buffer.alloc(32, 9).toString('base64'); }, { remac: false }), SECRET), 'WRONG_SECRET_OR_HEADER_DAMAGED');
    await expectCode(decodeBackup(await withHeader(file, (h) => { h.kdf.N = 2 ** 16; }, { remac: false }), SECRET), 'WRONG_SECRET_OR_HEADER_DAMAGED');
  });

  it('flipping a bit in the MAC or in the header JSON is detected', async () => {
    const m = Buffer.from(file); m[headerEnd(file) - 1] ^= 1;
    await expectCode(decodeBackup(m, SECRET), 'WRONG_SECRET_OR_HEADER_DAMAGED');
    const j = Buffer.from(file);
    const at = PREAMBLE_BYTES + headerJson(file).indexOf('"manual"') + 1; j[at] ^= 0x20; // "manual" -> "Manual" (still valid JSON)
    await expect(decodeBackup(j, SECRET)).rejects.toBeInstanceOf(BackupError);
  });

  it('a header re-MACed with the right key but in a non-canonical form (spaces, extra field) is refused', async () => {
    const h = JSON.parse(headerJson(file));
    const spaced = Buffer.from(JSON.stringify(h, null, 1), 'utf8');
    const pre = Buffer.from(file.subarray(0, PREAMBLE_BYTES)); pre.writeUInt32BE(spaced.length, 12);
    const keys = await deriveKeys(SECRET, Buffer.from(h.kdf.salt, 'base64'), FAST);
    const mac = crypto.createHmac('sha256', keys.macKey).update(pre).update(spaced).digest();
    await expectCode(decodeBackup(Buffer.concat([pre, spaced, mac, file.subarray(headerEnd(file))]), SECRET), 'HEADER_INVALID');
    await expectCode(decodeBackup(await withHeader(file, (x) => { x.extra = 1; }), SECRET), 'HEADER_INVALID');
  });
});

describe('preamble: magic, versions, lengths', () => {
  it('not a backup', async () => {
    await expectCode(decodeBackup(Buffer.from('hello world, definitely not a backup'), SECRET), 'NOT_A_BACKUP');
    await expectCode(decodeBackup(Buffer.alloc(0), SECRET), 'NOT_A_BACKUP');
    await expectCode(decodeBackup(Buffer.from('BTB-'), SECRET), 'NOT_A_BACKUP');
  });

  it('unsupported format versions and unknown flags are refused before the key derivation', async () => {
    const spy = vi.spyOn(crypto, 'scrypt');
    for (const v of [0, 2, 0xffff]) {
      const f = Buffer.from(file); f.writeUInt16BE(v, 8);
      await expectCode(decodeBackup(f, SECRET), 'UNSUPPORTED_VERSION');
    }
    const g = Buffer.from(file); g.writeUInt16BE(1, 10);
    await expectCode(decodeBackup(g, SECRET), 'UNSUPPORTED_VERSION');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a header length of 0, 1 or over 64 KiB is refused at once (nothing is allocated for it)', async () => {
    const spy = vi.spyOn(crypto, 'scrypt');
    for (const n of [0, 1, 64 * 1024 + 1, 0xffffffff]) {
      const f = Buffer.from(file); f.writeUInt32BE(n, 12);
      const r = new BackupReader(SECRET);
      await expect(r.push(f.subarray(0, PREAMBLE_BYTES))).rejects.toMatchObject({ code: 'HEADER_INVALID' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('hostile KDF parameters in an otherwise valid header are refused before scrypt runs', async () => {
    const spy = vi.spyOn(crypto, 'scrypt');
    for (const edit of [(h: any) => { h.kdf.N = 2 ** 30; }, (h: any) => { h.kdf.r = 1024; }, (h: any) => { h.kdf.p = 64; }, (h: any) => { h.kdf.N = 3; }]) {
      const f = await withHeader(file, edit, { remac: false });
      spy.mockClear();
      const started = Date.now();
      await expectCode(decodeBackup(f, SECRET), 'KDF_PARAMS_REJECTED');
      expect(spy).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('malformed header JSON and wrong field types are HEADER_INVALID', async () => {
    const bad: Array<(h: any) => void> = [
      (h) => { delete h.backupId; },
      (h) => { h.backupId = 'not-a-uuid'; },
      (h) => { h.payload = 'mysql'; },
      (h) => { h.kdf.alg = 'pbkdf2'; },
      (h) => { h.aead.alg = 'aes-256-cbc'; },
      (h) => { h.kdf.salt = Buffer.alloc(16).toString('base64'); },
      (h) => { h.kdf.salt = '!!!!'; },
      (h) => { h.aead.noncePrefix = Buffer.alloc(12).toString('base64'); },
      (h) => { h.aead.chunkSize = 16 * 1024 * 1024 + 1; },
      (h) => { h.createdAt = 'yesterday'; },
    ];
    for (const e of bad) await expectCode(decodeBackup(await withHeader(file, e, { remac: false }), SECRET), 'HEADER_INVALID');
    const notJson = Buffer.from(file);
    notJson[PREAMBLE_BYTES] = 0x5b; // '[' instead of '{'
    await expectCode(decodeBackup(notJson, SECRET), 'HEADER_INVALID');
    const badUtf8 = Buffer.from(file);
    badUtf8[PREAMBLE_BYTES + headerJson(file).indexOf('manual')] = 0xff;
    await expectCode(decodeBackup(badUtf8, SECRET), 'HEADER_INVALID');
  });
});

describe('records: tampering, type, order, truncation, insertion, removal, appended data', () => {
  it('a flipped bit in any record (frame header, ciphertext or tag) is detected', async () => {
    for (const r of records(file)) {
      for (const at of [r.offset + FRAME_HEADER_BYTES, r.end - TAG_BYTES - 1, r.end - 1]) {
        const f = Buffer.from(file); f[at] ^= 0x01;
        await expectCode(decodeBackup(f, SECRET), 'CORRUPT');
      }
      const lenFlip = Buffer.from(file); lenFlip[r.offset + 8] ^= 0x01; // length field: misframes or fails auth
      await expect(decodeBackup(lenFlip, SECRET)).rejects.toBeInstanceOf(BackupError);
    }
  });

  it('the record type is authenticated: DATA relabelled FINAL, or FINAL relabelled DATA, fails', async () => {
    const rs = records(file);
    const a = Buffer.from(file); a[rs[3].offset] = RecordType.FINAL; // last DATA claims to be FINAL
    await expectCode(decodeBackup(a, SECRET), 'CORRUPT');
    const b = Buffer.from(file); b[rs[0].offset] = RecordType.FINAL;
    await expectCode(decodeBackup(b, SECRET), 'CORRUPT');
    // FINAL claims to be DATA: after a short DATA record that is already a framing error (RECORD_INVALID) ...
    const c = Buffer.from(file); c[rs[4].offset] = RecordType.DATA;
    await expectCode(decodeBackup(c, SECRET), 'RECORD_INVALID');
    // ... and after a full one it fails authentication
    const one = await encodeBackup(crypto.randomBytes(CHUNK), base);
    const d = Buffer.from(one); d[records(one)[1].offset] = RecordType.DATA;
    await expectCode(decodeBackup(d, SECRET), 'CORRUPT');
  });

  it('an unknown record type is rejected before its body is read', async () => {
    for (const t of [0x00, 0x03, 0x7f, 0xff]) {
      const f = Buffer.from(file); f[records(file)[1].offset] = t;
      await expectCode(decodeBackup(f, SECRET), 'RECORD_INVALID');
    }
  });

  it('impossible record lengths are rejected before the body is read (no allocation from the length field)', async () => {
    const rs = records(file);
    for (const [r, len] of [[rs[0], 0], [rs[0], CHUNK + 1], [rs[0], 0xffffffff], [rs[4], 64 * 1024 + 1], [rs[4], 0]] as const) {
      const f = Buffer.from(file); f.writeUInt32BE(len, r.offset + 5);
      const reader = new BackupReader(SECRET);
      await expect(reader.push(f.subarray(0, r.offset + FRAME_HEADER_BYTES))).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    }
  });

  it('swapping two records (even with the index fields rewritten to look in order) fails', async () => {
    const rs = records(file);
    const hdr = file.subarray(0, headerEnd(file));
    const swapped = Buffer.concat([hdr, slice(file, rs[1]), slice(file, rs[0]), ...rs.slice(2).map((r) => slice(file, r))]);
    await expectCode(decodeBackup(swapped, SECRET), 'CORRUPT');
    const fixed = Buffer.from(swapped);
    const r0 = headerEnd(file); fixed.writeUInt32BE(0, r0 + 1); fixed.writeUInt32BE(1, r0 + rs[1].end - rs[1].offset + 1);
    await expectCode(decodeBackup(fixed, SECRET), 'CORRUPT');
  });

  it('removing a DATA record, duplicating one, or inserting one from another backup fails', async () => {
    const rs = records(file);
    const hdr = file.subarray(0, headerEnd(file));
    const without = (i: number) => Buffer.concat([hdr, ...rs.filter((_, k) => k !== i).map((r) => slice(file, r))]);
    await expectCode(decodeBackup(without(1), SECRET), 'CORRUPT');
    await expectCode(decodeBackup(without(0), SECRET), 'CORRUPT');
    const dup = Buffer.concat([hdr, slice(file, rs[0]), slice(file, rs[0]), ...rs.slice(1).map((r) => slice(file, r))]);
    await expectCode(decodeBackup(dup, SECRET), 'CORRUPT');
    // a record from another backup made with the same password, at the same position and index
    const other = await encodeBackup(crypto.randomBytes(CHUNK * 3 + 1234), base);
    const ors = records(other);
    const mixed = Buffer.concat([hdr, slice(file, rs[0]), slice(other, ors[1]), ...rs.slice(2).map((r) => slice(file, r))]);
    await expectCode(decodeBackup(mixed, SECRET), 'CORRUPT');
    // even the other backup's FINAL record cannot end this one
    const foreignFinal = Buffer.concat([hdr, ...rs.slice(0, 4).map((r) => slice(file, r)), slice(other, ors[4])]);
    await expectCode(decodeBackup(foreignFinal, SECRET), 'CORRUPT');
  });

  it('a missing FINAL record (cut at a record boundary) is TRUNCATED', async () => {
    const rs = records(file);
    for (const i of [0, 1, 4]) await expectCode(decodeBackup(file.subarray(0, rs[i].offset), SECRET), 'TRUNCATED');
    await expectCode(decodeBackup(file.subarray(0, headerEnd(file)), SECRET), 'TRUNCATED');
  });

  it('a file cut anywhere (inside the header, a frame header, a body or a tag) is TRUNCATED', async () => {
    const rs = records(file);
    const cuts = [9, PREAMBLE_BYTES, PREAMBLE_BYTES + 5, headerEnd(file) - 1, rs[0].offset + 4, rs[1].offset + 100, rs[3].end - 3, rs[4].offset + FRAME_HEADER_BYTES + 2, file.length - 1];
    for (const n of cuts) await expectCode(decodeBackup(file.subarray(0, n), SECRET), 'TRUNCATED');
  });

  it('any data after the FINAL record is TRAILING_DATA (in the same piece or in a later one)', async () => {
    await expectCode(decodeBackup(Buffer.concat([file, Buffer.from([0])]), SECRET), 'TRAILING_DATA');
    await expectCode(decodeBackup(Buffer.concat([file, slice(file, records(file)[4])]), SECRET), 'TRAILING_DATA');
    const r = new BackupReader(SECRET);
    await r.push(file);
    await expect(r.push(Buffer.from('x'))).rejects.toMatchObject({ code: 'TRAILING_DATA' });
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRAILING_DATA' })); // stays failed
  });

  it('non-canonical chunking (a short DATA record followed by another DATA record) is refused', async () => {
    // the public writer cannot produce this, so seal the records by hand with the writer's real keys
    const w = await BackupWriter.create(base);
    const h = w.header;
    const keys = (w as any).keys;
    const prefix = (w as any).noncePrefix as Buffer;
    const hh = (w as any).headerHash as Buffer;
    const seal = (type: number, index: number, pt: Buffer) => {
      const fh = Buffer.alloc(9); fh[0] = type; fh.writeUInt32BE(index, 1); fh.writeUInt32BE(pt.length, 5);
      const iv = Buffer.alloc(12); prefix.copy(iv); iv.writeUInt32BE(index, 8);
      const c = crypto.createCipheriv('aes-256-gcm', keys.encKey, iv); c.setAAD(Buffer.concat([hh, fh]));
      return Buffer.concat([fh, c.update(pt), c.final(), c.getAuthTag()]);
    };
    const bad = Buffer.concat([h, seal(1, 0, Buffer.alloc(10)), seal(1, 1, Buffer.alloc(CHUNK))]);
    w.abort();
    await expectCode(decodeBackup(bad, SECRET), 'RECORD_INVALID');
  });

  it('a validly encrypted FINAL whose manifest disagrees with the data is MANIFEST_INVALID', async () => {
    const w = await BackupWriter.create(base);
    const data = w.push(Buffer.alloc(CHUNK, 1));
    const keys = (w as any).keys;
    const prefix = (w as any).noncePrefix as Buffer;
    const hh = (w as any).headerHash as Buffer;
    const final = (m: unknown) => {
      const pt = Buffer.from(JSON.stringify(m));
      const fh = Buffer.alloc(9); fh[0] = 2; fh.writeUInt32BE(1, 1); fh.writeUInt32BE(pt.length, 5);
      const iv = Buffer.alloc(12); prefix.copy(iv); iv.writeUInt32BE(1, 8);
      const c = crypto.createCipheriv('aes-256-gcm', keys.encKey, iv); c.setAAD(Buffer.concat([hh, fh]));
      return Buffer.concat([w.header, ...data, fh, c.update(pt), c.final(), c.getAuthTag()]);
    };
    const sha = crypto.createHash('sha256').update(Buffer.alloc(CHUNK, 1)).digest('hex');
    const cases = [
      { dataRecords: 2, plaintextSize: CHUNK, plaintextSha256: sha, meta: {} },
      { dataRecords: 1, plaintextSize: CHUNK + 1, plaintextSha256: sha, meta: {} },
      { dataRecords: 1, plaintextSize: CHUNK, plaintextSha256: '00'.repeat(32), meta: {} },
      { dataRecords: 1, plaintextSize: CHUNK, plaintextSha256: sha },
      { dataRecords: 1, plaintextSize: CHUNK, plaintextSha256: sha, meta: [] },
      'not an object',
    ];
    const files = cases.map(final);
    w.abort();
    for (const f of files) await expectCode(decodeBackup(f, SECRET), 'MANIFEST_INVALID');
    // and the valid manifest is accepted, proving the helper is right
    const okWriter = await BackupWriter.create(base);
    const ok = Buffer.concat([okWriter.header, ...okWriter.push(Buffer.alloc(CHUNK, 1)), ...okWriter.finish()]);
    expect((await decodeBackup(ok, SECRET)).manifest.dataRecords).toBe(1);
  });
});

describe('no secrets in errors or logs', () => {
  it('errors carry fixed messages only, and nothing is written to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const h = JSON.parse(headerJson(file));
    const secrets = [SECRET, SECRET.normalize('NFD'), 'wrong password 42', h.kdf.salt, Buffer.from(h.kdf.salt, 'base64').toString('hex'), h.aead.noncePrefix];
    const keys = await deriveKeys(SECRET, Buffer.from(h.kdf.salt, 'base64'), FAST);
    secrets.push(keys.encKey.toString('hex'), keys.macKey.toString('hex'), keys.encKey.toString('base64'));
    const errors: unknown[] = [];
    const attempts: Array<() => Promise<unknown>> = [
      () => decodeBackup(file, 'wrong password 42'),
      () => decodeBackup(file.subarray(0, file.length - 5), SECRET),
      () => decodeBackup(Buffer.concat([file, Buffer.from('zz')]), SECRET),
      () => { const f = Buffer.from(file); f[records(file)[2].offset + 20] ^= 1; return decodeBackup(f, SECRET); },
      async () => decodeBackup(await withHeader(file, (x) => { x.kdf.N = 2 ** 30; }, { remac: false }), SECRET),
      () => BackupWriter.create({ ...base, secret: '' }),
    ];
    for (const a of attempts) await a().catch((e) => errors.push(e));
    expect(errors).toHaveLength(attempts.length);
    for (const e of errors) {
      expect(e).toBeInstanceOf(BackupError);
      const text = [String(e), (e as Error).stack ?? '', JSON.stringify(e), JSON.stringify(Object.entries(e as object))].join('\n');
      for (const s of secrets) expect(text).not.toContain(s);
    }
    await decodeBackup(file, SECRET);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('the reader wipes its keys after a failure and after success', async () => {
    const ok = new BackupReader(SECRET);
    await ok.push(file); ok.end();
    expect((ok as any).keys).toBeNull();
    const bad = new BackupReader(SECRET);
    const f = Buffer.from(file); f[records(file)[0].offset + 30] ^= 1;
    await expect(bad.push(f)).rejects.toMatchObject({ code: 'CORRUPT' });
    expect((bad as any).keys).toBeNull();
  });
});

describe('end() during an in-flight push (review finding M1)', () => {
  /** capture every key HKDF derives (deriveKeys wraps these ArrayBuffers without copying, so wiping zeroes them) */
  function captureDerivedKeys() {
    const derived: ArrayBuffer[] = [];
    const real = crypto.hkdfSync;
    vi.spyOn(crypto, 'hkdfSync').mockImplementation(((...args: Parameters<typeof crypto.hkdfSync>) => {
      const k = real(...args);
      derived.push(k);
      return k;
    }) as typeof crypto.hkdfSync);
    return derived;
  }

  it('end() while the header key is being derived fails the reader; the push rejects; the new keys are wiped', async () => {
    const derived = captureDerivedKeys();
    const r = new BackupReader(SECRET);
    const pending = r.push(file.subarray(0, headerEnd(file))); // a complete header: push is now inside deriveKeys
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
    await expect(pending).rejects.toMatchObject({ code: 'TRUNCATED' });
    expect(derived).toHaveLength(2); // encryption and MAC key were derived after end() ...
    for (const k of derived) expect(new Uint8Array(k).every((b) => b === 0)).toBe(true); // ... and wiped
    expect((r as any).keys).toBeNull();
    expect((r as any).state).toBe('failed');
    expect(r.info).toBeNull(); // the header was never accepted
  });

  it('a failed reader never goes back to reading records: later push and end() keep failing', async () => {
    const r = new BackupReader(SECRET);
    const pending = r.push(file.subarray(0, headerEnd(file)));
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
    await expect(pending).rejects.toMatchObject({ code: 'TRUNCATED' });
    expect((r as any).state).toBe('failed');
    await expect(r.push(file.subarray(headerEnd(file)))).rejects.toMatchObject({ code: 'TRUNCATED' });
    expect((r as any).state).toBe('failed');
    expect((r as any).keys).toBeNull();
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
  });

  it('end() during a push that is only buffering (no key derivation yet) makes that push reject too', async () => {
    const r = new BackupReader(SECRET);
    const pending = r.push(file.subarray(0, 10)); // part of the preamble; push is suspended at its final await
    expect((r as any).busy).toBe(true); // genuinely in flight when end() runs
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
    await expect(pending).rejects.toMatchObject({ code: 'TRUNCATED' });
    expect((r as any).state).toBe('failed');
    await expect(r.push(file.subarray(10))).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('end() after drain has decrypted records but before push resumes: push rejects and hands out no chunks', async () => {
    const r = new BackupReader(SECRET);
    await r.push(file.subarray(0, headerEnd(file))); // header accepted, keys derived; the reader is ready for records
    // hold the push at its final await with a controlled gate, after drain has run to completion
    const realDrain = (r as any).drain.bind(r);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let drained: Buffer[] = [];
    (r as any).drain = async () => { drained = await realDrain(); await gate; return drained; };
    const pending = r.push(file.subarray(headerEnd(file))); // every record, FINAL included
    await new Promise((resolve) => setImmediate(resolve)); // let drain finish
    expect((r as any).state).toBe('done'); // all records were decrypted and verified ...
    expect(drained).toHaveLength(4);
    expect(Buffer.concat(drained).equals(payload)).toBe(true); // ... and their plaintext is ready to be returned
    expect((r as any).busy).toBe(true); // but the push has not resumed yet
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
    release();
    await expect(pending).rejects.toMatchObject({ code: 'TRUNCATED' });
    for (const b of drained) expect(b.every((x) => x === 0)).toBe(true); // the withheld chunks were wiped
    expect((r as any).state).toBe('failed');
    expect((r as any).keys).toBeNull();
    expect(() => r.end()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
  });

  it('without the race, the same reader works normally (the guard does not affect sequential use)', async () => {
    const r = new BackupReader(SECRET);
    const parts = [...await r.push(file.subarray(0, headerEnd(file))), ...await r.push(file.subarray(headerEnd(file)))];
    expect(r.end().manifest.plaintextSize).toBe(payload.length);
    expect(Buffer.concat(parts).equals(payload)).toBe(true);
  });
});
