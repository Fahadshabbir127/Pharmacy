/**
 * Database adapter: the only way application code talks to SQLite.
 *
 * Backed by better-sqlite3 (synchronous, durable, WAL). The API is defined
 * here on purpose and is NOT a copy of sql.js:
 *
 *   all<T>(sql, params)   -> T[]
 *   get<T>(sql, params)   -> T | undefined
 *   run(sql, params)      -> { changes, lastInsertRowid }
 *   exec(sql)             -> multi-statement DDL / scripts, no parameters
 *   transaction(fn)       -> runs fn inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK on throw)
 *
 * Parameter rules (chosen to match what the legacy sql.js code accepted, see
 * docs/DB_CALLSITE_MIGRATION.md):
 *   - boolean  -> 1 / 0                      (sql.js did the same)
 *   - undefined -> DbParamError              (sql.js threw; better-sqlite3 would silently bind NULL)
 *   - objects / arrays / Dates -> DbParamError (sql.js threw)
 *   - fewer or more params than placeholders -> error (sql.js padded missing ones with NULL;
 *     every call site was audited to make sure none relies on that, see scripts/audit-db-callsites.ts)
 */
import Database from 'better-sqlite3';
import type { Database as BetterDb, Statement } from 'better-sqlite3';

export type Param = string | number | bigint | Buffer | null;
export type InputParam = Param | boolean | Uint8Array | undefined;

export class DbParamError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'DbParamError';
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface OpenOptions {
  readonly?: boolean;
  /** Keep false until the FK audit is resolved (better-sqlite3 defaults to ON, sql.js to OFF). */
  foreignKeys?: boolean;
  busyTimeoutMs?: number;
}

export function normalizeParams(params: readonly InputParam[] | undefined): Param[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new DbParamError('SQL parameters must be an array');
  return params.map((v, i) => {
    if (v === null) return null;
    switch (typeof v) {
      case 'string':
      case 'number':
      case 'bigint':
        return v;
      case 'boolean':
        return v ? 1 : 0;
      case 'undefined':
        throw new DbParamError(`SQL parameter ${i + 1} is undefined`);
      default:
        if (Buffer.isBuffer(v)) return v;
        if (v instanceof Uint8Array) return Buffer.from(v);
        throw new DbParamError(`SQL parameter ${i + 1} has unsupported type ${Object.prototype.toString.call(v)}`);
    }
  });
}

export class DbAdapter {
  readonly file: string;
  private readonly conn: BetterDb;
  private readonly cache = new Map<string, Statement>();
  private closed = false;

  private constructor(file: string, conn: BetterDb) {
    this.file = file;
    this.conn = conn;
  }

  static open(file: string, opts: OpenOptions = {}): DbAdapter {
    const conn = new Database(file, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
    const db = new DbAdapter(file, conn);
    conn.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    conn.pragma(`foreign_keys = ${opts.foreignKeys ? 'ON' : 'OFF'}`);
    if (!opts.readonly) {
      conn.pragma('journal_mode = WAL');
      conn.pragma('synchronous = FULL');
      conn.pragma('temp_store = MEMORY');
    }
    return db;
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.conn.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = any>(sql: string, params?: readonly InputParam[]): T[] {
    return this.stmt(sql).all(...normalizeParams(params)) as T[];
  }

  get<T = any>(sql: string, params?: readonly InputParam[]): T | undefined {
    return this.stmt(sql).get(...normalizeParams(params)) as T | undefined;
  }

  run(sql: string, params?: readonly InputParam[]): RunResult {
    const r = this.stmt(sql).run(...normalizeParams(params));
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Multi-statement SQL without parameters (DDL, scripts). */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  /**
   * Run fn atomically. Uses BEGIN IMMEDIATE so the write lock is taken up front.
   * Nested calls become savepoints. Any throw rolls the whole unit back.
   */
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn).immediate();
  }

  /** Rows violating declared foreign keys ([] = clean). */
  foreignKeyViolations(): { table: string; rowid: number; parent: string; fkid: number }[] {
    return this.conn.pragma('foreign_key_check') as any[];
  }

  /** Switch FK enforcement on/off (only outside a transaction; SQLite ignores it inside one). */
  setForeignKeys(on: boolean): void {
    if (this.conn.inTransaction) throw new Error('foreign_keys cannot be changed inside a transaction');
    this.conn.pragma(`foreign_keys = ${on ? 'ON' : 'OFF'}`);
  }

  get inTransaction(): boolean {
    return this.conn.inTransaction;
  }

  pragma<T = unknown>(source: string): T {
    return this.conn.pragma(source, { simple: true }) as T;
  }

  /** Consistent in-memory snapshot of the whole database (includes WAL content). */
  serialize(): Buffer {
    return this.conn.serialize();
  }

  /** Online, consistent backup to a new file (safe while the app keeps writing). */
  async backupTo(destination: string): Promise<void> {
    await this.conn.backup(destination);
  }

  /** [] when the database is healthy, otherwise SQLite's messages. */
  integrityCheck(): string[] {
    const rows = this.conn.pragma('integrity_check') as { integrity_check: string }[];
    const msgs = rows.map((r) => r.integrity_check);
    return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
  }

  tableNames(): string[] {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  }

  rowCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.tableNames()) out[t] = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`)!.n;
    return out;
  }

  checkpoint(): void {
    if (!this.closed) this.conn.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    this.cache.clear();
    try {
      if (!this.conn.readonly) this.conn.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.conn.close();
      this.closed = true;
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }
}
