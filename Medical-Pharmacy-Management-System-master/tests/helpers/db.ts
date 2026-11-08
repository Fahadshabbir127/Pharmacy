/**
 * Read-only database inspection for tests.
 *
 * Uses a read-only better-sqlite3 connection so committed data that is still in
 * the WAL file is visible (reading the main file bytes, as the Phase 2 sql.js
 * version did, would miss it). Works for files written by both the original
 * sql.js app and the new better-sqlite3 backend.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export async function openReadOnly(file: string): Promise<Db> {
  return new Database(file, { readonly: true, fileMustExist: true });
}

export function all<T = any>(db: Db, sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T = any>(db: Db, sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function tableNames(db: Db): string[] {
  return all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}

export function rowCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tableNames(db)) out[t] = one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM "${t}"`)!.c;
  return out;
}

export function integrityCheck(db: Db): string[] {
  const msgs = all<{ integrity_check: string }>(db, 'PRAGMA integrity_check').map((r) => r.integrity_check);
  return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
}

export function foreignKeyViolations(db: Db): any[] {
  return all(db, 'PRAGMA foreign_key_check');
}

/**
 * Modify a database file (TEST COPIES ONLY) while its server is stopped.
 * Refuses to touch anything outside the OS temp directory.
 */
export async function editDbFile(file: string, fn: (db: Db) => void): Promise<void> {
  const os = await import('node:os');
  const path = await import('node:path');
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
    throw new Error(`editDbFile refuses to modify a file outside the temp dir: ${real}`);
  }
  const db = new Database(file, { fileMustExist: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
}
