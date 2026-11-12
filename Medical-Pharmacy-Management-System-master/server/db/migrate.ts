/**
 * Versioned, forward-only migrations with data-safety checks.
 *
 * For every run with pending migrations:
 *   1. integrity_check the live database            -> abort if not clean
 *   2. verified pre-migration backup (if it has data) -> abort if backup fails or differs
 *   3. each migration in its own transaction:
 *        row counts before -> up() -> record version -> row counts after
 *        any table that lost rows / disappeared (unless the migration declares it) -> ROLLBACK
 *        integrity_check                                                          -> ROLLBACK
 * Nothing is auto-repaired. Failures throw MigrationError with a report; the caller must stop.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DbAdapter } from './adapter';

export interface Migration {
  version: number;
  name: string;
  up(db: DbAdapter): void;
  /** Tables whose row count this migration is allowed to change (default: none may shrink or vanish). */
  allowRowCountChanges?: string[];
}

export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  applied: { version: number; name: string }[];
  backupFile: string | null;
  rowCountsBefore: Record<string, number>;
  rowCountsAfter: Record<string, number>;
}

export class MigrationError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MigrationError';
  }
}

const TABLE = 'schema_migrations';

export function migrationChecksum(m: Migration): string {
  return crypto.createHash('sha256').update(`${m.version}:${m.name}:${m.up.toString()}`).digest('hex').slice(0, 16);
}

export function appliedVersions(db: DbAdapter): number[] {
  const exists = db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [TABLE]);
  if (!exists) return [];
  return db.all<{ version: number }>(`SELECT version FROM ${TABLE} ORDER BY version`).map((r) => r.version);
}

export function currentVersion(db: DbAdapter): number {
  const v = appliedVersions(db);
  return v.length ? v[v.length - 1] : 0;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copy the live DB with the online backup API and prove the copy matches. */
export async function verifiedBackup(db: DbAdapter, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = `${destination}.partial`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
  const sourceCounts = db.rowCounts();
  await db.backupTo(tmp);
  const copy = DbAdapter.open(tmp, { readonly: true });
  try {
    const problems = copy.integrityCheck();
    if (problems.length) throw new MigrationError('Backup copy failed integrity_check', { problems });
    const copyCounts = copy.rowCounts();
    if (JSON.stringify(copyCounts) !== JSON.stringify(sourceCounts)) {
      throw new MigrationError('Backup copy row counts differ from the live database', { sourceCounts, copyCounts });
    }
  } finally {
    copy.close();
  }
  fs.renameSync(tmp, destination);
}

export async function migrate(
  db: DbAdapter,
  migrations: Migration[],
  opts: { backupDir: string; appVersion?: string; log?: (msg: string) => void },
): Promise<MigrationReport> {
  const log = opts.log ?? (() => {});
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (i > 0 && m.version === sorted[i - 1].version) throw new MigrationError(`Duplicate migration version ${m.version}`);
  });

  const done = new Set(appliedVersions(db));
  const fromVersion = done.size ? Math.max(...done) : 0;
  const unknown = [...done].filter((v) => !sorted.some((m) => m.version === v));
  if (unknown.length) {
    throw new MigrationError(
      `Database was migrated by a newer version of the application (schema versions ${unknown.join(', ')} are unknown). Install the newer version; do not use this one with this database.`,
      { unknown },
    );
  }
  const pending = sorted.filter((m) => !done.has(m.version));
  const before = db.rowCounts();
  const report: MigrationReport = { fromVersion, toVersion: fromVersion, applied: [], backupFile: null, rowCountsBefore: before, rowCountsAfter: before };
  if (!pending.length) return report;

  const integrity = db.integrityCheck();
  if (integrity.length) throw new MigrationError('Database failed integrity_check before migration; nothing was changed.', { integrity });

  const hasData = Object.keys(before).some((t) => t !== TABLE);
  if (hasData) {
    const target = pending[pending.length - 1].version;
    const file = path.join(opts.backupDir, `pre-migration-v${fromVersion}-to-v${target}-${timestamp()}.sqlite`);
    try {
      await verifiedBackup(db, file);
    } catch (e: any) {
      throw new MigrationError(`Pre-migration backup failed; nothing was changed. ${e.message}`, { cause: e.message, ...(e.details ?? {}) });
    }
    report.backupFile = file;
    log(`pre-migration backup written: ${file}`);
  }

  for (const m of pending) {
    try {
      db.transaction(() => {
        const pre = db.rowCounts();
        m.up(db);
        db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          app_version TEXT,
          checksum TEXT NOT NULL
        )`);
        db.run(`INSERT INTO ${TABLE} (version, name, applied_at, app_version, checksum) VALUES (?, ?, ?, ?, ?)`, [
          m.version, m.name, new Date().toISOString(), opts.appVersion ?? null, migrationChecksum(m),
        ]);
        const post = db.rowCounts();
        const allowed = new Set(m.allowRowCountChanges ?? []);
        const lost = Object.entries(pre)
          .filter(([t, n]) => !allowed.has(t) && (post[t] === undefined || post[t] < n))
          .map(([t, n]) => ({ table: t, before: n, after: post[t] ?? 'table missing' }));
        if (lost.length) throw new MigrationError(`Migration ${m.version} (${m.name}) would remove data; rolled back.`, { lost });
        const problems = db.integrityCheck();
        if (problems.length) throw new MigrationError(`Migration ${m.version} (${m.name}) broke integrity; rolled back.`, { problems });
        // Crash-test hook (tests only): hard-kill the process inside this migration's transaction, before COMMIT.
        if (process.env.PHARMACY_TEST_CRASH_MIGRATION === String(m.version)) process.kill(process.pid, 'SIGKILL');
      });
    } catch (e: any) {
      if (e instanceof MigrationError) throw Object.assign(e, { details: { ...e.details, migration: m.version, backupFile: report.backupFile } });
      throw new MigrationError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e.message}`, { migration: m.version, backupFile: report.backupFile });
    }
    report.applied.push({ version: m.version, name: m.name });
    report.toVersion = m.version;
    log(`applied migration ${m.version} ${m.name}`);
  }
  report.rowCountsAfter = db.rowCounts();
  return report;
}
