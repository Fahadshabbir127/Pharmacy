/**
 * Phase 9A.1: backup key derivation (server/backup/kdf.ts).
 * Uses the lowest accepted work factor (N = 2^15) so the suite stays fast; the production default is not set here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { assertKdfParams, deriveKeys, newSalt, passwordBytes, scryptMemoryBytes, KDF_BOUNDS, KDF_CANDIDATES, SALT_BYTES } from '../../server/backup/kdf';
import { BackupError } from '../../server/backup/errors';

const FAST = { N: 2 ** 15, r: 8, p: 1 };
const salt = Buffer.alloc(SALT_BYTES, 7);

afterEach(() => vi.restoreAllMocks());

describe('deriveKeys', () => {
  it('is deterministic and gives two different 32-byte keys (encryption and MAC)', async () => {
    const a = await deriveKeys('Correct horse 9', salt, FAST);
    const b = await deriveKeys('Correct horse 9', salt, FAST);
    expect(a.encKey).toHaveLength(32);
    expect(a.macKey).toHaveLength(32);
    expect(a.encKey.equals(b.encKey)).toBe(true);
    expect(a.macKey.equals(b.macKey)).toBe(true);
    expect(a.encKey.equals(a.macKey)).toBe(false);
  });

  it('matches an independent computation: scrypt, then HKDF-SHA256 with the documented labels', async () => {
    const k = await deriveKeys('pässwörd-1', salt, FAST);
    const master = crypto.scryptSync(Buffer.from('pässwörd-1'.normalize('NFC')), salt, 32, { ...FAST, maxmem: 64 * 1024 * 1024 });
    const enc = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'BTBACKUP v1 aes-256-gcm records', 32));
    const mac = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'BTBACKUP v1 hmac-sha256 header', 32));
    expect(k.encKey.equals(enc)).toBe(true);
    expect(k.macKey.equals(mac)).toBe(true);
  });

  it('normalises the password to Unicode NFC (composed and decomposed forms give the same keys)', async () => {
    const composed = 'Café-Ångström1';
    const decomposed = 'Café-Ångström1';
    expect(composed).not.toBe(decomposed);
    expect(passwordBytes(composed).equals(passwordBytes(decomposed))).toBe(true);
    const a = await deriveKeys(composed, salt, FAST);
    const b = await deriveKeys(decomposed, salt, FAST);
    expect(a.encKey.equals(b.encKey)).toBe(true);
    expect(a.macKey.equals(b.macKey)).toBe(true);
  });

  it('different salts or different passwords give different keys; newSalt is random and 32 bytes', async () => {
    const s1 = newSalt();
    const s2 = newSalt();
    expect(s1).toHaveLength(32);
    expect(s1.equals(s2)).toBe(false);
    const a = await deriveKeys('Same pass 1', s1, FAST);
    const b = await deriveKeys('Same pass 1', s2, FAST);
    const c = await deriveKeys('Other pass 1', s1, FAST);
    expect(a.encKey.equals(b.encKey)).toBe(false);
    expect(a.macKey.equals(b.macKey)).toBe(false);
    expect(a.encKey.equals(c.encKey)).toBe(false);
  });

  it('wipe() zeroes both keys', async () => {
    const k = await deriveKeys('Wipe me 1', salt, FAST);
    k.wipe();
    expect(k.encKey.every((b) => b === 0)).toBe(true);
    expect(k.macKey.every((b) => b === 0)).toBe(true);
  });

  it('wipes its own copy of the password bytes and the scrypt master key', async () => {
    const seen: Buffer[] = [];
    const real = crypto.scrypt;
    vi.spyOn(crypto, 'scrypt').mockImplementation(((pw: Buffer, s: Buffer, len: number, opts: any, cb: any) => {
      seen.push(pw);
      real(pw, s, len, opts, (err: Error | null, key: Buffer) => { if (key) seen.push(key); cb(err, key); });
    }) as any);
    await deriveKeys('Secret pass 1', salt, FAST);
    expect(seen).toHaveLength(2);
    for (const b of seen) expect(b.every((x) => x === 0)).toBe(true);
  });

  it('rejects an empty password and a salt of the wrong size', async () => {
    await expect(deriveKeys('', salt, FAST)).rejects.toMatchObject({ code: 'EMPTY_SECRET' });
    await expect(deriveKeys('x', Buffer.alloc(16), FAST)).rejects.toMatchObject({ code: 'KDF_PARAMS_REJECTED' });
    await expect(deriveKeys('x', 'not a buffer' as any, FAST)).rejects.toMatchObject({ code: 'KDF_PARAMS_REJECTED' });
  });
});

describe('KDF parameter bounds (checked before any derivation)', () => {
  const hostile: Array<[string, unknown]> = [
    ['N too small', { N: 2 ** 14, r: 8, p: 1 }],
    ['N too large', { N: 2 ** 21, r: 8, p: 1 }],
    ['N 2^30 (would need 1 TiB)', { N: 2 ** 30, r: 8, p: 1 }],
    ['N not a power of two', { N: 100_000, r: 8, p: 1 }],
    ['N fractional', { N: 32768.5, r: 8, p: 1 }],
    ['N as text', { N: '32768', r: 8, p: 1 }],
    ['N negative', { N: -32768, r: 8, p: 1 }],
    ['N NaN', { N: NaN, r: 8, p: 1 }],
    ['N Infinity', { N: Infinity, r: 8, p: 1 }],
    ['r too small', { N: 2 ** 15, r: 1, p: 1 }],
    ['r too large', { N: 2 ** 15, r: 17, p: 1 }],
    ['p zero', { N: 2 ** 15, r: 8, p: 0 }],
    ['p too large', { N: 2 ** 15, r: 8, p: 5 }],
    ['p huge', { N: 2 ** 15, r: 8, p: 2 ** 40 }],
    ['memory over the cap (N 2^20, r 8 = 1 GiB)', { N: 2 ** 20, r: 8, p: 1 }],
    ['memory over the cap (N 2^18, r 16 = 512 MiB)', { N: 2 ** 18, r: 16, p: 1 }],
    ['missing p', { N: 2 ** 15, r: 8 }],
    ['null', null],
    ['not an object', 42],
  ];
  for (const [name, params] of hostile) {
    it(`rejects ${name} without calling scrypt`, async () => {
      const spy = vi.spyOn(crypto, 'scrypt');
      expect(() => assertKdfParams(params)).toThrow(BackupError);
      await expect(deriveKeys('Some pass 1', salt, params as any)).rejects.toMatchObject({ code: 'KDF_PARAMS_REJECTED' });
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('accepts the bounds themselves and every benchmark candidate', () => {
    expect(() => assertKdfParams({ N: 2 ** KDF_BOUNDS.minLog2N, r: KDF_BOUNDS.minR, p: 1 })).not.toThrow();
    expect(() => assertKdfParams({ N: 2 ** 18, r: 8, p: KDF_BOUNDS.maxP })).not.toThrow();
    expect(() => assertKdfParams({ N: 2 ** 17, r: 16, p: 1 })).not.toThrow(); // exactly 256 MiB
    for (const c of KDF_CANDIDATES) {
      expect(() => assertKdfParams(c)).not.toThrow();
      expect(scryptMemoryBytes(c)).toBeLessThanOrEqual(KDF_BOUNDS.maxMemoryBytes);
    }
    expect(scryptMemoryBytes({ N: 2 ** 17, r: 8, p: 1 })).toBe(128 * 1024 * 1024);
  });
});
