/**
 * Read-only database inspection for tests.
 * The file is read into memory with sql.js; nothing is ever written back.
 */
import fs from 'node:fs';
import initSqlJs, { Database } from 'sql.js';

let SQLPromise: ReturnType<typeof initSqlJs> | null = null;

export async function openReadOnly(file: string): Promise<Database> {
  SQLPromise ??= initSqlJs();
  const SQL = await SQLPromise;
  return new SQL.Database(new Uint8Array(fs.readFileSync(file)));
}

export function all<T = any>(db: Database, sql: string, params: any[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

export function one<T = any>(db: Database, sql: string, params: any[] = []): T | undefined {
  return all<T>(db, sql, params)[0];
}

export function tableNames(db: Database): string[] {
  return all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}

export function rowCounts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tableNames(db)) out[t] = one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM "${t}"`)!.c;
  return out;
}

export function integrityCheck(db: Database): string[] {
  const rows = all<{ integrity_check: string }>(db, 'PRAGMA integrity_check');
  const msgs = rows.map((r) => r.integrity_check);
  return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
}

export function foreignKeyViolations(db: Database): any[] {
  return all(db, 'PRAGMA foreign_key_check');
}

/**
 * Modify a database file (TEST COPIES ONLY) while its server is stopped.
 * Refuses to touch anything outside the OS temp directory.
 */
export async function editDbFile(file: string, fn: (db: Database) => void): Promise<void> {
  const os = await import('node:os');
  const path = await import('node:path');
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
    throw new Error(`editDbFile refuses to modify a file outside the temp dir: ${real}`);
  }
  const db = await openReadOnly(file);
  fn(db);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}
