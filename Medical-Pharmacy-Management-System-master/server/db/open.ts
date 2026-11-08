/**
 * Opening the live database safely.
 *
 * An existing file is checked READ-ONLY first. If it cannot be read or fails
 * integrity_check, startup stops with DatabaseIntegrityError and the file is
 * left exactly as it was (the legacy app renamed it and silently started an
 * empty demo database). Then pending migrations run with a verified backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DbAdapter } from './adapter';
import { migrate, MigrationReport } from './migrate';
import { MIGRATIONS } from './migrations';

export class DatabaseIntegrityError extends Error {
  constructor(readonly file: string, readonly problems: string[]) {
    super(
      `The pharmacy database at ${file} failed its integrity check and was NOT opened or modified.\n` +
        `Problems: ${problems.slice(0, 5).join('; ')}\n` +
        `Restore the most recent backup (see docs/DATABASE_BACKUP_RESTORE.md) or contact support. Do not delete the file.`,
    );
    this.name = 'DatabaseIntegrityError';
  }
}

export function checkExistingDatabase(file: string): string[] {
  let ro: DbAdapter | null = null;
  try {
    ro = DbAdapter.open(file, { readonly: true });
    return ro.integrityCheck();
  } catch (e: any) {
    return [e.message || String(e)];
  } finally {
    ro?.close();
  }
}

export async function openDatabase(
  file: string,
  opts: { backupDir: string; appVersion?: string; log?: (m: string) => void },
): Promise<{ db: DbAdapter; migration: MigrationReport; created: boolean }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file) && fs.statSync(file).size > 0;
  if (existed) {
    const problems = checkExistingDatabase(file);
    if (problems.length) throw new DatabaseIntegrityError(file, problems);
  }
  const db = DbAdapter.open(file);
  try {
    const migration = await migrate(db, MIGRATIONS, opts);
    return { db, migration, created: !existed };
  } catch (e) {
    db.close();
    throw e;
  }
}
