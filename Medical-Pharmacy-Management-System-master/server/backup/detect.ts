/**
 * Phase 9A.1: recognise a backup file by its first bytes. Nothing is decrypted, parsed in full or written; a file
 * is only opened for reading, and at most DETECT_BYTES are read.
 *
 *   btbackup         "BTBACKUP" magic (version and whether this program can read it are reported)
 *   legacy-kmhbackup the old JSON export: {"version": ..., "timestamp": ..., "iv": "<32 hex>", "data": "<base64>"}
 *                    (AES-256-CBC with a fixed salt; kept readable for restore of old files)
 *   sqlite           a plain SQLite database file ("SQLite format 3\0")
 *   sqlite-base64    a base64 text of a SQLite file (also accepted by the old import)
 *   unknown          anything else, including empty files
 */
import fs from 'node:fs/promises';
import { FORMAT_VERSION, MAGIC, PREAMBLE_BYTES } from './format';

export const DETECT_BYTES = 4096;

export type DetectedBackup =
  | { kind: 'btbackup'; formatVersion: number; supported: boolean }
  | { kind: 'legacy-kmhbackup' }
  | { kind: 'sqlite' }
  | { kind: 'sqlite-base64' }
  | { kind: 'unknown' };

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SQLITE_BASE64_PREFIX = SQLITE_MAGIC.toString('base64').slice(0, 20); // "U1FMaXRlIGZvcm1hdCAz" = "SQLite format 3"
/** the legacy export's keys, in any order, with a 16-byte hex IV, as JSON.stringify(payload, null, 2) wrote them */
const LEGACY_IV = /"iv"\s*:\s*"[0-9a-fA-F]{32}"/;
const LEGACY_DATA = /"data"\s*:\s*"[A-Za-z0-9+/=]/;
const LEGACY_VERSION = /"version"\s*:\s*"[^"\\]{1,16}"/;

/** Classify the first bytes of a file (pass at least DETECT_BYTES when available). */
export function detectBackupBytes(head: Buffer): DetectedBackup {
  if (head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (head.length < PREAMBLE_BYTES) return { kind: 'btbackup', formatVersion: 0, supported: false };
    const formatVersion = head.readUInt16BE(8);
    return { kind: 'btbackup', formatVersion, supported: formatVersion === FORMAT_VERSION && head.readUInt16BE(10) === 0 };
  }
  if (head.length >= SQLITE_MAGIC.length && head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return { kind: 'sqlite' };
  const text = head.toString('latin1');
  const trimmed = text.replace(/^\uFEFF?[\s]*/, '').replace(/^\u00EF\u00BB\u00BF\s*/, ''); // allow a UTF-8 BOM
  if (trimmed.startsWith(SQLITE_BASE64_PREFIX)) return { kind: 'sqlite-base64' };
  if (trimmed.startsWith('{') && LEGACY_IV.test(trimmed) && LEGACY_DATA.test(trimmed) && LEGACY_VERSION.test(trimmed)) return { kind: 'legacy-kmhbackup' };
  return { kind: 'unknown' };
}

/** Read at most DETECT_BYTES from the start of a file (read-only) and classify it. */
export async function detectBackupFile(filePath: string): Promise<DetectedBackup> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(DETECT_BYTES);
    const { bytesRead } = await fh.read(buf, 0, DETECT_BYTES, 0);
    return detectBackupBytes(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
