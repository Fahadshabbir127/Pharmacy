/**
 * Phase 9A.1: key derivation for .btbackup files (Node.js built-in crypto only).
 *
 *   password --NFC--> UTF-8 --scrypt(salt, N, r, p)--> 32-byte master key
 *   master --HKDF-SHA256(salt, "BTBACKUP v1 aes-256-gcm records")--> encKey  (record encryption)
 *   master --HKDF-SHA256(salt, "BTBACKUP v1 hmac-sha256 header")---> macKey  (header authentication)
 *
 * - every backup gets a fresh 32-byte random salt (newSalt), so every file has its own keys
 * - parameters are always explicit (no hidden default): the production default is chosen only after the Windows
 *   benchmark (scripts/backup-kdf-benchmark.ts) has been reviewed
 * - parameters read from a file are checked against hard bounds BEFORE the expensive derivation, so a crafted
 *   header cannot make the program use excessive memory or time
 * - nothing here logs; the password copy, the master key and the derived keys are wiped on a best-effort basis
 */
import crypto from 'node:crypto';
import { BackupError } from './errors';

export interface ScryptParams { N: number; r: number; p: number }

export const SALT_BYTES = 32;
export const KEY_BYTES = 32;

/** Hard bounds accepted when writing or reading a backup. */
export const KDF_BOUNDS = {
  minLog2N: 15, //  N >= 32768 (32 MiB at r = 8): the lowest work factor accepted at all
  maxLog2N: 20, //  N <= 1,048,576
  minR: 8,
  maxR: 16,
  minP: 1,
  maxP: 4,
  /** scrypt needs about 128 * N * r bytes; files asking for more are refused (a pharmacy PC must stay usable) */
  maxMemoryBytes: 256 * 1024 * 1024,
} as const;

/**
 * Candidates for the production default, to be measured on the pharmacy's Windows PC with
 * `npx tsx scripts/backup-kdf-benchmark.ts`. None of them is used automatically.
 */
export const KDF_CANDIDATES: readonly ScryptParams[] = [
  { N: 2 ** 15, r: 8, p: 1 }, //  32 MiB
  { N: 2 ** 16, r: 8, p: 1 }, //  64 MiB
  { N: 2 ** 17, r: 8, p: 1 }, // 128 MiB (planned candidate)
  { N: 2 ** 18, r: 8, p: 1 }, // 256 MiB
];

/**
 * Production default, approved after the Windows benchmark (128 MiB of scrypt memory). Writers pass it explicitly;
 * the reader always uses the parameters stored in the file (within KDF_BOUNDS).
 */
export const DEFAULT_KDF: Readonly<ScryptParams> = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

export const scryptMemoryBytes = (p: ScryptParams) => 128 * p.N * p.r;

/** Throws KDF_PARAMS_REJECTED unless the parameters are within KDF_BOUNDS. Cheap: no derivation happens. */
export function assertKdfParams(params: unknown): asserts params is ScryptParams {
  const p = params as ScryptParams;
  const ok = !!p && typeof p === 'object'
    && Number.isSafeInteger(p.N) && Number.isSafeInteger(p.r) && Number.isSafeInteger(p.p)
    && p.N > 1 && (p.N & (p.N - 1)) === 0 // a power of two
    && p.N >= 2 ** KDF_BOUNDS.minLog2N && p.N <= 2 ** KDF_BOUNDS.maxLog2N
    && p.r >= KDF_BOUNDS.minR && p.r <= KDF_BOUNDS.maxR
    && p.p >= KDF_BOUNDS.minP && p.p <= KDF_BOUNDS.maxP
    && scryptMemoryBytes(p) <= KDF_BOUNDS.maxMemoryBytes;
  if (!ok) throw new BackupError('KDF_PARAMS_REJECTED', 'kdf');
}

export function newSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

/** The password as bytes: Unicode NFC first, so differently composed but equal texts give the same key. */
export function passwordBytes(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length === 0) throw new BackupError('EMPTY_SECRET', 'kdf');
  return Buffer.from(secret.normalize('NFC'), 'utf8');
}

export interface DerivedKeys {
  encKey: Buffer;
  macKey: Buffer;
  /** overwrite both keys with zeros (best effort; JavaScript may keep copies elsewhere) */
  wipe(): void;
}

const HKDF_INFO_ENC = Buffer.from('BTBACKUP v1 aes-256-gcm records', 'utf8');
const HKDF_INFO_MAC = Buffer.from('BTBACKUP v1 hmac-sha256 header', 'utf8');

function scryptAsync(password: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: scryptMemoryBytes(params) + 16 * 1024 * 1024 }, (err, key) => {
      if (err) reject(new BackupError('KDF_PARAMS_REJECTED', 'kdf')); // never pass the native message through
      else resolve(key);
    });
  });
}

/** Derive the record-encryption and header-MAC keys. Validates everything before the expensive step. */
export async function deriveKeys(secret: string, salt: Buffer, params: ScryptParams): Promise<DerivedKeys> {
  assertKdfParams(params);
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) throw new BackupError('KDF_PARAMS_REJECTED', 'kdf');
  const pw = passwordBytes(secret);
  let master: Buffer | null = null;
  try {
    master = await scryptAsync(pw, salt, params);
    const encKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, HKDF_INFO_ENC, KEY_BYTES));
    const macKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, HKDF_INFO_MAC, KEY_BYTES));
    return { encKey, macKey, wipe() { encKey.fill(0); macKey.fill(0); } };
  } finally {
    pw.fill(0);
    master?.fill(0);
  }
}
