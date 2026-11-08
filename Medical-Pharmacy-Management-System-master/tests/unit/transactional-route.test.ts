import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DbAdapter } from '../../server/db/adapter';
import { transactionalRoute } from '../../server/db/transactionalRoute';

let db: DbAdapter;
let app: express.Express;
let base: string;
let server: any;

const count = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM t')!.n;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txr-'));
  db = DbAdapter.open(path.join(dir, 'x.sqlite'));
  db.exec('CREATE TABLE t (v TEXT NOT NULL)');
  app = express();
  app.use(express.json());
  const tx = (h: any) => transactionalRoute(() => db, h);
  app.post('/ok', tx((req: any, res: any) => { db.run("INSERT INTO t VALUES ('a')"); db.run("INSERT INTO t VALUES ('b')"); res.json({ ok: true }); }));
  app.post('/throws', tx((req: any, res: any) => { db.run("INSERT INTO t VALUES ('a')"); db.run('INSERT INTO t VALUES (NULL)'); res.json({ ok: true }); }));
  app.post('/caught500', tx((req: any, res: any) => {
    try { db.run("INSERT INTO t VALUES ('a')"); throw new Error('later step failed'); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  }));
  app.post('/denied', tx((req: any, res: any) => { db.run("INSERT INTO t VALUES ('audit')"); res.status(401).json({ error: 'no' }); }));
  app.post('/send', tx((req: any, res: any) => { db.run("INSERT INTO t VALUES ('s')"); res.setHeader('X-Test', '1'); res.send('plain'); }));
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${server.address().port}`;
  return async () => { server.close(); db.close(); };
});

const post = (p: string) => fetch(base + p, { method: 'POST' });

describe('transactionalRoute', () => {
  it('commits all writes and then sends the JSON response', async () => {
    const r = await post('/ok');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(count()).toBe(2);
  });

  it('rolls back every write when the handler throws (HTTP 500)', async () => {
    const r = await post('/throws');
    expect(r.status).toBe(500);
    expect(count()).toBe(0);
  });

  it('rolls back when the handler catches its own error and answers 500', async () => {
    const r = await post('/caught500');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'later step failed' });
    expect(count()).toBe(0);
  });

  it('keeps writes for 4xx responses (failed-login style audit rows)', async () => {
    const r = await post('/denied');
    expect(r.status).toBe(401);
    expect(count()).toBe(1);
  });

  it('works with res.send and headers', async () => {
    const r = await post('/send');
    expect(await r.text()).toBe('plain');
    expect(r.headers.get('x-test')).toBe('1');
    expect(count()).toBe(1);
  });

  it('does not send the success response if COMMIT fails', async () => {
    const realTx = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((fn: any) => {
      realTx(() => { fn(); throw new Error('simulated commit failure (disk full)'); });
      return undefined as any;
    });
    const r = await post('/ok');
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('"ok":true');
    expect(count()).toBe(0);
    spy.mockRestore();
  });

  it('refuses to wrap async handlers', () => {
    expect(() => transactionalRoute(() => db, async () => {})).toThrow(/async/);
  });
});
