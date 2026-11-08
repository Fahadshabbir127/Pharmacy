/**
 * Durability (Phase 3): hard-kill the backend and check what survived.
 * Rule under test: a sale that got an HTTP 200 must exist after a crash;
 * a sale that did not get a response may or may not exist, but never partially.
 */
import { describe, it, expect } from 'vitest';
import { startServer, Api, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, one, all, integrityCheck } from '../helpers/db';

describe('crash durability (SIGKILL, no graceful shutdown)', () => {
  it('every acknowledged sale survives a hard kill; no partial sales; DB intact', async () => {
    let srv = await startServer();
    const workDir = srv.workDir;
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 3); // stock 80

    const acknowledged: string[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await admin.post('/sales', salePayload([cartItem(p, 1)]));
      expect(r.status).toBe(200);
      acknowledged.push(r.body.invoice_number);
    }
    // burst of 40 concurrent sales; hard-kill as soon as 25 sales in total are acknowledged
    let killed: Promise<void> | null = null;
    let unknownOutcome = 0;
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) {
      inflight.push(
        admin.post('/sales', salePayload([cartItem(p, 1)])).then(
          (r) => {
            if (r.status === 200) acknowledged.push(r.body.invoice_number);
            if (acknowledged.length >= 25 && !killed) killed = srv.kill();
          },
          () => { unknownOutcome++; }, // connection dropped by the kill
        ),
      );
    }
    await Promise.all(inflight);
    await (killed ?? srv.kill());
    expect(acknowledged.length).toBeGreaterThanOrEqual(25);
    expect(unknownOutcome).toBeGreaterThan(0); // the kill really interrupted in-flight sales
    console.log(`durability: ${acknowledged.length} acknowledged, ${unknownOutcome} interrupted by the kill`);

    srv = await startServer({ workDir });
    try {
      const db = await openReadOnly(srv.dbFile);
      expect(integrityCheck(db)).toEqual([]);
      const stored = all<{ invoice_number: string }>(db, "SELECT invoice_number FROM sales_headers WHERE invoice_number LIKE 'INV-1-%'").map((r) => r.invoice_number);
      for (const inv of acknowledged) expect(stored, `acknowledged ${inv} lost`).toContain(inv);
      // no partial sales: every header has its item, and stock matches the number of stored sales
      expect(one(db, 'SELECT COUNT(*) n FROM sales_headers h WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = h.id)')).toEqual({ n: 0 });
      expect(one<{ stock: number }>(db, 'SELECT stock FROM products WHERE id = 3')!.stock).toBe(80 - stored.length);
      db.close();
    } finally {
      await srv.stop();
    }
  });

  it('data written just before a hard kill is present after restart (no in-memory-only state)', async () => {
    let srv = await startServer();
    const workDir = srv.workDir;
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const add = await admin.post('/customers', { name: 'Crash Test Customer', phone: '03110000001' });
    expect(add.status).toBe(200);
    await srv.kill();
    srv = await startServer({ workDir });
    try {
      const a = new Api();
      await a.login('admin', 'admin123');
      expect((await a.get('/customers')).body.map((c: any) => c.name)).toContain('Crash Test Customer');
    } finally {
      await srv.stop();
    }
  });
});
