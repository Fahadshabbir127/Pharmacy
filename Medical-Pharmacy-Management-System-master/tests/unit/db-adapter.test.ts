import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DbAdapter, DbParamError, normalizeParams } from '../../server/db/adapter';

let dir: string;
let db: DbAdapter;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-'));
  db = DbAdapter.open(path.join(dir, 'a.sqlite'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b REAL); CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id));');
});
afterEach(() => {
  if (db.isOpen) db.close();
});

describe('normalizeParams', () => {
  it('passes strings, numbers, bigint, null and Buffers through', () => {
    const buf = Buffer.from('x');
    expect(normalizeParams(['s', 1, 2.5, 3n, null, buf])).toEqual(['s', 1, 2.5, 3n, null, buf]);
  });
  it('converts booleans to 1/0 (sql.js behaviour)', () => {
    expect(normalizeParams([true, false])).toEqual([1, 0]);
  });
  it('converts Uint8Array to Buffer', () => {
    expect(Buffer.isBuffer(normalizeParams([new Uint8Array([1])])[0])).toBe(true);
  });
  it('rejects undefined with the 1-based position (sql.js also threw)', () => {
    expect(() => normalizeParams(['a', undefined])).toThrow(new DbParamError('SQL parameter 2 is undefined'));
  });
  it('rejects objects, arrays and Dates', () => {
    expect(() => normalizeParams([{ a: 1 } as any])).toThrow(DbParamError);
    expect(() => normalizeParams([[1] as any])).toThrow(DbParamError);
    expect(() => normalizeParams([new Date() as any])).toThrow(DbParamError);
  });
  it('rejects a non-array parameter list', () => {
    expect(() => normalizeParams('x' as any)).toThrow(DbParamError);
  });
});

describe('DbAdapter', () => {
  it('sets WAL, synchronous=FULL, busy_timeout and foreign_keys OFF by default', () => {
    expect(db.pragma('journal_mode')).toBe('wal');
    expect(db.pragma('synchronous')).toBe(2);
    expect(db.pragma('busy_timeout')).toBe(5000);
    expect(db.pragma('foreign_keys')).toBe(0);
  });

  it('foreign keys can be enabled explicitly', () => {
    const f = DbAdapter.open(path.join(dir, 'fk.sqlite'), { foreignKeys: true });
    expect(f.pragma('foreign_keys')).toBe(1);
    f.close();
  });

  it('run returns changes and lastInsertRowid; get/all read back', () => {
    const r = db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 1.5]);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.get('SELECT a, b FROM t WHERE id = ?', [1])).toEqual({ a: 'x', b: 1.5 });
    expect(db.get('SELECT a FROM t WHERE id = ?', [99])).toBeUndefined();
    db.run('INSERT INTO t (a) VALUES (?)', ['y']);
    expect(db.all('SELECT a FROM t ORDER BY id')).toEqual([{ a: 'x' }, { a: 'y' }]);
  });

  it('stores booleans as integers', () => {
    db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['bool', true]);
    expect(db.get('SELECT b FROM t')).toEqual({ b: 1 });
  });

  it('rejects too few / too many parameters', () => {
    expect(() => db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['x'])).toThrow(/Too few/);
    expect(() => db.run('INSERT INTO t (a) VALUES (?)', ['x', 'y'])).toThrow(/Too many/);
  });

  it('rejects double-quoted string literals (SQLITE_DQS=0)', () => {
    expect(() => db.all('SELECT * FROM t WHERE a = "x"')).toThrow(/no such column/);
  });

  it('run() refuses multiple statements; exec() runs them', () => {
    expect(() => db.run("INSERT INTO t (a) VALUES ('1'); INSERT INTO t (a) VALUES ('2')")).toThrow(/more than one statement/);
    db.exec("INSERT INTO t (a) VALUES ('1'); INSERT INTO t (a) VALUES ('2')");
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM t')!.n).toBe(2);
  });

  it('transaction commits on success and rolls back everything on throw', () => {
    db.transaction(() => {
      db.run("INSERT INTO t (a) VALUES ('ok1')");
      db.run("INSERT INTO t (a) VALUES ('ok2')");
    });
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (a) VALUES ('lost')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('SELECT a FROM t ORDER BY id').map((r: any) => r.a)).toEqual(['ok1', 'ok2']);
  });

  it('nested transaction rolls back only the inner unit when the inner error is caught', () => {
    db.transaction(() => {
      db.run("INSERT INTO t (a) VALUES ('outer')");
      try {
        db.transaction(() => {
          db.run("INSERT INTO t (a) VALUES ('inner')");
          throw new Error('inner');
        });
      } catch { /* handled */ }
    });
    expect(db.all('SELECT a FROM t').map((r: any) => r.a)).toEqual(['outer']);
  });

  it('a committed write is visible to a second connection immediately (WAL)', () => {
    db.run("INSERT INTO t (a) VALUES ('shared')");
    const reader = DbAdapter.open(db.file, { readonly: true });
    expect(reader.get('SELECT a FROM t')).toEqual({ a: 'shared' });
    reader.close();
  });

  it('a second writer waits for busy_timeout then fails cleanly instead of corrupting', () => {
    const other = DbAdapter.open(db.file, { busyTimeoutMs: 100 });
    db.exec('BEGIN IMMEDIATE');
    db.run("INSERT INTO t (a) VALUES ('locked')");
    const t0 = Date.now();
    expect(() => other.run("INSERT INTO t (a) VALUES ('blocked')")).toThrow(/locked|busy/i);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    db.exec('COMMIT');
    other.run("INSERT INTO t (a) VALUES ('after')");
    expect(db.all('SELECT a FROM t ORDER BY id').map((r: any) => r.a)).toEqual(['locked', 'after']);
    other.close();
  });

  it('backupTo produces an identical, healthy copy while the source stays open', async () => {
    for (let i = 0; i < 50; i++) db.run('INSERT INTO t (a, b) VALUES (?, ?)', [`r${i}`, i]);
    const dest = path.join(dir, 'backup.sqlite');
    await db.backupTo(dest);
    const copy = DbAdapter.open(dest, { readonly: true });
    expect(copy.integrityCheck()).toEqual([]);
    expect(copy.rowCounts()).toEqual(db.rowCounts());
    copy.close();
  });

  it('serialize() includes data still in the WAL', () => {
    db.run("INSERT INTO t (a) VALUES ('in-wal')");
    const snapshotFile = path.join(dir, 'snap.sqlite');
    fs.writeFileSync(snapshotFile, db.serialize());
    const snap = DbAdapter.open(snapshotFile, { readonly: true });
    expect(snap.get('SELECT a FROM t')).toEqual({ a: 'in-wal' });
    snap.close();
  });

  it('integrityCheck reports [] for a healthy db and rowCounts lists every table', () => {
    expect(db.integrityCheck()).toEqual([]);
    expect(db.rowCounts()).toEqual({ c: 0, p: 0, t: 0 });
  });

  it('opening a non-database file read-only fails on first use', () => {
    const bad = path.join(dir, 'bad.sqlite');
    fs.writeFileSync(bad, 'not a database'.repeat(500));
    const b = DbAdapter.open(bad, { readonly: true });
    expect(() => b.integrityCheck()).toThrow(/not a database/);
    b.close();
  });

  it('close() checkpoints the WAL so the main file is self-contained', () => {
    db.run("INSERT INTO t (a) VALUES ('ckpt')");
    db.close();
    expect(fs.existsSync(`${db.file}-wal`) ? fs.statSync(`${db.file}-wal`).size : 0).toBe(0);
  });
});
