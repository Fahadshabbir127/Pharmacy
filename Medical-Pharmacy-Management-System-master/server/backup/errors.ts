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
  | 'MANIFEST_INVALID' //        the manifest is malformed or does not match the data that was decrypted
  // Phase 9A.2: file-system operations
  | 'DISK_SPACE' //              not enough free disk space (checked before writing; also a full disk while writing)
  | 'WRITE_FAILED' //            a backup file could not be created or written
  | 'PUBLISH_FAILED' //          the finished backup could not be moved into place (a file of that name exists)
  | 'HARDLINK_UNSUPPORTED' //    the disk does not support hard links, so the backup cannot be published safely
  | 'BACKUP_IN_PROGRESS' //      another backup or restore operation holds the backup lock
  | 'PATH_REJECTED' //           an unsafe path: outside the backup folders, a link, a protected file or a bad name
  | 'FILE_TOO_LARGE' //          the database or backup file is larger than the supported limit
  | 'FS_BUSY' //                 a file stayed locked by another program (e.g. antivirus) after all retries
  | 'PERMISSIONS_UNVERIFIED'; // the private backup folder's access rights could not be set or verified

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
  DISK_SPACE: 'There is not enough free disk space for the backup.',
  WRITE_FAILED: 'The backup file could not be written.',
  PUBLISH_FAILED: 'The finished backup could not be saved because a file with the same name already exists.',
  HARDLINK_UNSUPPORTED: 'The backup folder is on a disk that does not support safe saving (hard links). Use a local NTFS disk.',
  BACKUP_IN_PROGRESS: 'Another backup or restore is already running. Try again when it has finished.',
  PATH_REJECTED: 'An unsafe file location was refused.',
  FILE_TOO_LARGE: 'The database or backup file is larger than the supported limit.',
  FS_BUSY: 'A backup file is in use by another program (for example antivirus). Try again in a moment.',
  PERMISSIONS_UNVERIFIED: 'The private backup folder could not be protected or its access rights could not be verified, so no backup was written.',
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
