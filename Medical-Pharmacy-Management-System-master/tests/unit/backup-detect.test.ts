/**
 * Phase 9A.1: backup file detection (server/backup/detect.ts). Detection reads the start of a file only; it never
 * decrypts, parses in full or writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { detectBackupBytes, detectBackupFile, DETECT_BYTES } from '../../server/backup/detect';
import { encodeBackup } from '../../server/backup/format';

let dir: string;
let btbackup: Buffer;
let sqliteFile: Buffer;

/** exactly what the legacy /api/backup/export route writes */
function legacyExport(db: Buffer, password: string): string {
  const key = crypto.scryptSync(password, 'khushi_pharmacy_salt', 32);
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([c.update(db), c.final()]);
  return JSON.stringify({ version: '1.0', timestamp: new Date().toISOString(), iv: iv.toString('hex'), data: encrypted.toString('base64') }, null, 2);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-detect-'));
  const db = new Database(path.join(dir, 'real.sqlite'));
  db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
  db.close();
  sqliteFile = fs.readFileSync(path.join(dir, 'real.sqlite'));
  btbackup = await encodeBackup(crypto.randomBytes(1000), { secret: 'Detect pass 1', kdf: { N: 2 ** 15, r: 8, p: 1 }, chunkSize: 64 * 1024, appVersion: '1.0.0', schemaVersion: 11, kind: 'manual' });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('detectBackupBytes', () => {
  it('a new .btbackup file, with its format version', () => {
    expect(detectBackupBytes(btbackup)).toEqual({ kind: 'btbackup', formatVersion: 1, supported: true });
    const v2 = Buffer.from(btbackup); v2.writeUInt16BE(2, 8);
    expect(detectBackupBytes(v2)).toEqual({ kind: 'btbackup', formatVersion: 2, supported: false });
    const flags = Buffer.from(btbackup); flags.writeUInt16BE(1, 10);
    expect(detectBackupBytes(flags)).toEqual({ kind: 'btbackup', formatVersion: 1, supported: false });
    expect(detectBackupBytes(btbackup.subarray(0, 10))).toEqual({ kind: 'btbackup', formatVersion: 0, supported: false });
  });

  it('a legacy .kmhbackup export (pretty-printed JSON, as the old route writes it) and compact variants', () => {
    const legacy = legacyExport(sqliteFile, 'Old pass 1');
    expect(detectBackupBytes(Buffer.from(legacy))).toEqual({ kind: 'legacy-kmhbackup' });
    expect(detectBackupBytes(Buffer.from(JSON.stringify(JSON.parse(legacy))))).toEqual({ kind: 'legacy-kmhbackup' });
    expect(detectBackupBytes(Buffer.from('﻿' + legacy))).toEqual({ kind: 'legacy-kmhbackup' }); // with a UTF-8 BOM
    // only the start of a large legacy file is needed
    expect(detectBackupBytes(Buffer.from(legacy).subarray(0, 300))).toEqual({ kind: 'legacy-kmhbackup' });
  });

  it('a plain SQLite file, and a base64 text of one (accepted by the old import)', () => {
    expect(detectBackupBytes(sqliteFile)).toEqual({ kind: 'sqlite' });
    expect(detectBackupBytes(Buffer.from(sqliteFile.toString('base64')))).toEqual({ kind: 'sqlite-base64' });
  });

  it('unknown or invalid input', () => {
    const unknown = [
      Buffer.alloc(0),
      Buffer.from('BTBACKU'), // a shorter-than-magic prefix
      Buffer.from('btbackup lowercase is not the magic'),
      Buffer.from('SQLite format 2\0'),
      Buffer.from('{"hello": "world"}'),
      Buffer.from('{"version": "1.0", "iv": "nothex", "data": "AAAA"}'),
      Buffer.from(JSON.stringify({ iv: 'ab'.repeat(16), data: 'AAAA' })), // no version
      Buffer.from('%PDF-1.7'),
      crypto.randomBytes(DETECT_BYTES),
    ];
    for (const b of unknown) expect(detectBackupBytes(b)).toEqual({ kind: 'unknown' });
  });
});

describe('detectBackupFile', () => {
  it('reads at most DETECT_BYTES, never writes, and classifies each kind', async () => {
    const files: Record<string, Buffer> = {
      'a.btbackup': btbackup,
      'b.kmhbackup': Buffer.from(legacyExport(Buffer.concat([sqliteFile, crypto.randomBytes(200_000)]), 'Old pass 1')),
      'c.sqlite': sqliteFile,
      'd.bin': crypto.randomBytes(10_000),
      'e.empty': Buffer.alloc(0),
    };
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
    const before = Object.fromEntries(Object.keys(files).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]));
    const kinds: Record<string, string> = {};
    for (const n of Object.keys(files)) kinds[n] = (await detectBackupFile(path.join(dir, n))).kind;
    expect(kinds).toEqual({ 'a.btbackup': 'btbackup', 'b.kmhbackup': 'legacy-kmhbackup', 'c.sqlite': 'sqlite', 'd.bin': 'unknown', 'e.empty': 'unknown' });
    for (const [name, data] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(dir, name)).equals(data)).toBe(true);
      expect(fs.statSync(path.join(dir, name)).mtimeMs).toBe(before[name]);
    }
  });

  it('a missing file is an error from the file system (nothing is created)', async () => {
    const missing = path.join(dir, 'missing.btbackup');
    await expect(detectBackupFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(missing)).toBe(false);
  });
});
