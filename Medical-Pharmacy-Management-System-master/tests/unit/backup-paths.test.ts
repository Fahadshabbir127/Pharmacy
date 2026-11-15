/**
 * Phase 9A.2: backup folder layout, names, path checks and size limits (server/backup/paths.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_NAME, MAX_BACKUP_FILE_BYTES, MAX_DATABASE_BYTES, WORK_NAME, PARTIAL_NAME, assertNotProtected, assertSafeName,
  backupLayout, isInside, newBackupName, newWorkName, resolveInside, samePath,
} from '../../server/backup/paths';
import { BackupError } from '../../server/backup/errors';

const isWin = process.platform === 'win32';
let root: string;
let layout: ReturnType<typeof backupLayout>;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-paths-')));
  layout = backupLayout(root, path.join(root, 'pharmacy.sqlite'));
  fs.writeFileSync(layout.dbFile, 'db');
  fs.writeFileSync(`${layout.dbFile}-wal`, 'wal');
  fs.mkdirSync(layout.encryptedDir, { recursive: true });
  fs.mkdirSync(layout.workDir, { recursive: true });
  fs.writeFileSync(path.join(layout.backupsDir, 'pre-migration-v1-to-v2.sqlite'), 'old');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const rejected = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(BackupError); await expect(p).rejects.toMatchObject({ code: 'PATH_REJECTED' }); };

describe('layout', () => {
  it('derives the approved folders from the data folder; relative paths are refused', () => {
    expect(layout.backupsDir).toBe(path.join(root, 'backups'));
    expect(layout.encryptedDir).toBe(path.join(root, 'backups', 'encrypted'));
    expect(layout.workDir).toBe(path.join(root, 'backups', '.work'));
    expect(layout.lockFile).toBe(path.join(root, 'backups', '.work', 'backup.lock'));
    expect(() => backupLayout('data', '/x/db.sqlite')).toThrow(expect.objectContaining({ code: 'PATH_REJECTED' }));
    expect(() => backupLayout(root, 'db.sqlite')).toThrow(expect.objectContaining({ code: 'PATH_REJECTED' }));
  });
});

describe('names', () => {
  it('backup names: kind, UTC time stamp, random suffix; unique', () => {
    const n = newBackupName('manual', new Date('2026-11-15T12:34:56.789Z'));
    expect(n).toMatch(/^manual-20261115T123456Z-[0-9a-f]{8}\.btbackup$/);
    const names = new Set(Array.from({ length: 1000 }, () => newBackupName('scheduled')));
    expect(names.size).toBe(1000);
    for (const bad of ['', 'Manual', 'man ual', '../x', 'a'.repeat(17), 'pre-restore', 1 as any]) expect(() => newBackupName(bad)).toThrow(BackupError);
    expect(() => newBackupName('manual', new Date('invalid'))).toThrow(BackupError);
  });

  it('work names: random UUID with a purpose, or a .btbackup.partial; unique', () => {
    expect(newWorkName('snapshot')).toMatch(WORK_NAME);
    expect(newWorkName('snapshot')).toMatch(/\.snapshot\.tmp$/);
    expect(newWorkName('btbackup')).toMatch(PARTIAL_NAME);
    const names = new Set(Array.from({ length: 1000 }, () => newWorkName('snapshot')));
    expect(names.size).toBe(1000);
    expect(() => newWorkName('../x')).toThrow(BackupError);
  });

  it('rejects traversal, separators, streams, reserved device names, trailing dots/spaces, look-alikes and long names', () => {
    const bad = [
      '', '.', '..', '../manual-20261115T123456Z-0123abcd.btbackup', 'a/b.btbackup', 'a\\b.btbackup', 'manual-20261115T123456Z-0123abcd.btbackup:secret',
      'con', 'NUL', 'nul.btbackup', 'manual-20261115T123456Z-0123abcd.btbackup.', 'manual-20261115T123456Z-0123abcd.btbackup ',
      '\uff4danual-20261115T123456Z-0123abcd.btbackup', // full-width "m"
      'MANUAL-20261115T123456Z-0123ABCD.btbackup', `${'a'.repeat(200)}.btbackup`, 42 as any, null as any,
      '/etc/passwd', 'C:\\Windows\\x.btbackup',
    ];
    for (const b of bad) expect(() => assertSafeName(b, BACKUP_NAME), String(b)).toThrow(expect.objectContaining({ code: 'PATH_REJECTED' }));
    expect(() => assertSafeName('manual-20261115T123456Z-0123abcd.btbackup', BACKUP_NAME)).not.toThrow();
  });

  it('resolveInside returns a direct child of the base folder only', () => {
    const p = resolveInside(layout.encryptedDir, 'manual-20261115T123456Z-0123abcd.btbackup', BACKUP_NAME);
    expect(path.dirname(p)).toBe(layout.encryptedDir);
    expect(() => resolveInside(layout.encryptedDir, '../pharmacy.sqlite', BACKUP_NAME)).toThrow(BackupError);
  });
});

describe('path comparison', () => {
  it('samePath and isInside are case-insensitive on Windows only', () => {
    expect(samePath('/a/Data/X', '/a/data/x', 'win32')).toBe(true);
    expect(samePath('/a/Data/X', '/a/data/x', 'linux')).toBe(false);
    expect(isInside('/a/data', '/a/DATA/backups/x', 'win32')).toBe(true);
    expect(isInside('/a/data', '/a/DATA/backups/x', 'linux')).toBe(false);
    expect(isInside('/a/data', '/a/data-other/x', 'linux')).toBe(false);
    expect(isInside('/a/data', '/a/x', 'linux')).toBe(false);
    // L2: a child whose name starts with '..' is inside; only the parent step itself leaves the folder
    expect(isInside('/a/data', '/a/data/..foo', 'linux')).toBe(true);
    expect(isInside('/a/data', '/a/data/...', 'linux')).toBe(true);
    expect(isInside('/a/data', '/a/data/../x', 'linux')).toBe(false);
    expect(isInside('/a/data', '/a', 'linux')).toBe(false);
    expect(isInside('/a/data', '/a/data', 'linux')).toBe(true);
  });
});

describe('assertNotProtected', () => {
  it('allows only targets inside encrypted/ or .work/', async () => {
    await expect(assertNotProtected(path.join(layout.encryptedDir, 'manual-20261115T123456Z-0123abcd.btbackup'), layout)).resolves.toBeUndefined();
    await expect(assertNotProtected(path.join(layout.workDir, newWorkName('snapshot')), layout)).resolves.toBeUndefined();
  });

  it('refuses the live database, its side files, the data folder, legacy backups and the folders themselves', async () => {
    for (const p of [
      layout.dbFile, `${layout.dbFile}-wal`, `${layout.dbFile}-shm`, `${layout.dbFile}-journal`,
      path.join(root, 'config.json'), path.join(layout.backupsDir, 'pre-migration-v1-to-v2.sqlite'), path.join(layout.backupsDir, 'x.btbackup'),
      layout.encryptedDir, layout.workDir, path.join(layout.workDir, '..', '..', 'pharmacy.sqlite'), 'relative.btbackup', path.join(os.tmpdir(), 'elsewhere.btbackup'),
    ]) await rejected(assertNotProtected(p, layout));
  });

  it.skipIf(isWin)('refuses a link inside .work that points at the live database (real paths are compared)', async () => {
    const link = path.join(layout.workDir, newWorkName('snapshot'));
    fs.symlinkSync(layout.dbFile, link);
    try { await rejected(assertNotProtected(link, layout)); } finally { fs.unlinkSync(link); }
    expect(fs.readFileSync(layout.dbFile, 'utf8')).toBe('db');
  });

  it.skipIf(isWin)('L3: a real-path error other than "missing" (a symlink loop at a database side file) is PATH_REJECTED, not ignored', async () => {
    const shm = `${layout.dbFile}-shm`;
    fs.symlinkSync(shm, shm); // ELOOP
    try {
      await rejected(assertNotProtected(path.join(layout.encryptedDir, 'manual-20261115T123456Z-0123abcd.btbackup'), layout));
    } finally { fs.unlinkSync(shm); }
    // with the loop gone (ENOENT again) the same target is allowed
    await expect(assertNotProtected(path.join(layout.encryptedDir, 'manual-20261115T123456Z-0123abcd.btbackup'), layout)).resolves.toBeUndefined();
  });

  it.skipIf(!isWin)('Windows: a differently-cased path to the live database is refused', async () => {
    await rejected(assertNotProtected(layout.dbFile.toUpperCase(), layout));
    await rejected(assertNotProtected(`${layout.dbFile}-WAL`, layout));
  });
});

describe('size limits', () => {
  it('4 GiB database limit; the backup-file limit adds exactly the worst-case format overhead (under 2 MiB)', () => {
    expect(MAX_DATABASE_BYTES).toBe(4 * 1024 ** 3);
    const overhead = MAX_BACKUP_FILE_BYTES - MAX_DATABASE_BYTES;
    // 16 + 65536 + 32 (header) + 65536 records x 25 + 9 + 65536 + 16 (final)
    expect(overhead).toBe(16 + 65536 + 32 + 65536 * 25 + 9 + 65536 + 16);
    expect(overhead).toBeLessThan(2 * 1024 * 1024);
    expect(Number.isSafeInteger(MAX_BACKUP_FILE_BYTES)).toBe(true);
  });
});
