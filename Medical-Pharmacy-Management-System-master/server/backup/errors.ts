/**
 * Phase 9A.1: typed errors of the backup engine.
 *
 * Messages are fixed, human-readable texts chosen here; they never include passwords, derived keys, salts, file
 * contents or other caller-supplied values, so an error can be logged or shown as it is.
 */
export type BackupErrorCode =
  | 'EMPTY_SECRET' //            no password given
  | 'KDF_PARAMS_REJECTED' //     key-derivation parameters outside the safe bounds (checked before any work)
  | 'NOT_A_BACKUP' //            the file does not start with the BTBACKUP magic
  | 'UNSUPPORTED_VERSION' //     a .btbackup format version this program cannot read
  | 'HEADER_INVALID' //          header length, JSON or fields malformed
  | 'WRONG_SECRET_OR_HEADER_DAMAGED' // the header authentication failed: wrong password, or the header was changed
  | 'RECORD_INVALID' //          record framing malformed: unknown type, impossible length, order or count
  | 'CORRUPT' //                 a record failed authentication (changed, moved, inserted or removed data)
  | 'TRUNCATED' //               the file ends before its final manifest record
  | 'TRAILING_DATA' //           bytes after the final manifest record
  | 'MANIFEST_INVALID'; //       the manifest is malformed or does not match the data that was decrypted

const MESSAGES: Record<BackupErrorCode, string> = {
  EMPTY_SECRET: 'A backup password is required.',
  KDF_PARAMS_REJECTED: 'The backup file uses key-derivation settings outside the safe limits and was not opened.',
  NOT_A_BACKUP: 'This file is not a BrainTech backup (.btbackup).',
  UNSUPPORTED_VERSION: 'This backup was made by a newer or unknown version of the program and cannot be read here.',
  HEADER_INVALID: 'The backup file header is damaged or invalid.',
  WRONG_SECRET_OR_HEADER_DAMAGED: 'Wrong backup password, or the backup file header is damaged.',
  RECORD_INVALID: 'The backup file structure is damaged.',
  CORRUPT: 'The backup file is damaged or has been changed.',
  TRUNCATED: 'The backup file is incomplete (it ends too early).',
  TRAILING_DATA: 'The backup file has unexpected data after its end.',
  MANIFEST_INVALID: 'The backup file contents do not match its manifest.',
};

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  /** where it happened, e.g. 'kdf', 'header', 'record', 'manifest' (fixed labels only) */
  readonly stage: string;
  constructor(code: BackupErrorCode, stage: string) {
    super(MESSAGES[code]);
    this.name = 'BackupError';
    this.code = code;
    this.stage = stage;
  }
  toJSON() { return { name: this.name, code: this.code, stage: this.stage, message: this.message }; }
}

export const isBackupError = (e: unknown, code?: BackupErrorCode): e is BackupError =>
  e instanceof BackupError && (code === undefined || e.code === code);
