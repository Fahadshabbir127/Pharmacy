/**
 * Durability (Phase 3): hard-kill the backend and check what survived.
 * Rule under test: a sale that got an HTTP 200 must exist after a crash;
 * a sale that did not get a response may or may not exist, but never partially.
 */
import { describe, it, expect } from 'vitest';
import { startServer, Api, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, one, all, integrityCheck } from '../helpers/db';

describe('crash durability (SIGKILL, no graceful shutdown)', () => {
  /**
   * Each request carries a unique transaction id ("durability-req-NNNN"). The server stores it in
   * idempotency_keys in the SAME transaction as the sale, which makes every stored sale traceable to the
   * request that created it. (Until Phase 7 the marker was a client-supplied unit price; the server now
   * prices every sale itself, C9.)
   * Odd requests are UDHAR sales to customer #2, so one sale touches four tables:
   * sales_headers, sale_items, customers.current_balance and customer_ledger.
   */
  it('every acknowledged sale survives a hard kill; every interrupted sale is either fully committed or fully absent', async () => {
    let srv = await startServer();
    const workDir = srv.workDir;
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 3); // stock 80
    const startBalance = (await admin.get('/customers')).body.find((c: any) => c.id === 2).current_balance;

    const N = 55;
    const outcome: ('ack' | 'error' | 'interrupted')[] = [];
    const send = (i: number) =>
      admin.post('/sales', salePayload([cartItem(p, 1)], { client_txn_id: `durability-req-${String(i).padStart(4, '0')}`, ...(i % 2 ? { payment_method: 'UDHAR', customer_id: 2 } : {}) }));
    for (let i = 0; i < 15; i++) {
      const r = await send(i);
      expect(r.status).toBe(200);
      outcome[i] = 'ack';
    }
    // burst of 40 concurrent sales; hard-kill as soon as 25 sales in total are acknowledged
    let killed: Promise<void> | null = null;
    const inflight: Promise<void>[] = [];
    for (let i = 15; i < N; i++) {
      inflight.push(send(i).then(
        (r) => {
          outcome[i] = r.status === 200 ? 'ack' : 'error';
          if (outcome.filter((o) => o === 'ack').length >= 25 && !killed) killed = srv.kill();
        },
        () => { outcome[i] = 'interrupted'; }, // connection dropped by the kill: outcome unknown to the client
      ));
    }
    await Promise.all(inflight);
    await (killed ?? srv.kill());
    const interrupted = outcome.map((o, i) => (o === 'interrupted' ? i : -1)).filter((i) => i >= 0);
    expect(outcome.filter((o) => o === 'error')).toEqual([]);
    expect(interrupted.length).toBeGreaterThan(0);

    srv = await startServer({ workDir });
    try {
      const db = await openReadOnly(srv.dbFile);
      expect(integrityCheck(db)).toEqual([]);
      const rows = all<{ id: number; marker: number; items: number; grand_total: number; amount_due: number; method: string; ledger: number }>(db, `
        SELECT h.id, CAST(substr(k.key, 16) AS INTEGER) AS marker, COUNT(i.id) AS items, h.grand_total, h.amount_due, h.payment_method AS method,
               (SELECT COUNT(*) FROM customer_ledger l WHERE l.sale_id = h.id) AS ledger
        FROM sales_headers h LEFT JOIN sale_items i ON i.sale_id = h.id
        LEFT JOIN idempotency_keys k ON k.route = 'POST /api/sales' AND json_extract(k.response, '$.sale_id') = h.id
        WHERE h.invoice_number LIKE 'INV-1-%' GROUP BY h.id`);
      // every stored sale is traceable to exactly one request (its transaction id was stored with it)
      for (const r of rows) expect(r.marker, `sale ${r.id} has no transaction id`).not.toBeNull();
      const byMarker = new Map<number, typeof rows>();
      for (const r of rows) byMarker.set(r.marker, [...(byMarker.get(r.marker) ?? []), r]);

      // no partial rows anywhere
      expect(one(db, 'SELECT COUNT(*) n FROM sale_items i WHERE NOT EXISTS (SELECT 1 FROM sales_headers h WHERE h.id = i.sale_id)')).toEqual({ n: 0 });
      for (const r of rows) {
        expect(r.items, `sale ${r.id} items`).toBe(1);
        expect(r.grand_total, `sale ${r.id} total`).toBe(175); // Brufen, priced by the server
        expect(r.ledger, `sale ${r.id} ledger rows`).toBe(r.method === 'UDHAR' ? 1 : 0);
      }
      // no duplicates: every request produced at most one sale
      for (const [m, list] of byMarker) expect(list.length, `request ${m} stored ${list.length} times`).toBe(1);

      // acknowledged requests are all present; interrupted ones are present-and-complete or absent
      const committedInterrupted: number[] = [];
      const rolledBack: number[] = [];
      for (let i = 0; i < N; i++) {
        const present = byMarker.has(i);
        if (outcome[i] === 'ack') expect(present, `acknowledged request ${i} lost`).toBe(true);
        else if (outcome[i] === 'interrupted') (present ? committedInterrupted : rolledBack).push(i);
      }
      expect(committedInterrupted.length + rolledBack.length).toBe(interrupted.length);

      // money and stock agree exactly with what was stored
      const udharDue = rows.filter((r) => r.method === 'UDHAR').reduce((s, r) => s + r.amount_due, 0);
      expect(one<{ b: number }>(db, 'SELECT current_balance b FROM customers WHERE id = 2')!.b).toBe(startBalance + udharDue);
      expect(one<{ stock: number }>(db, 'SELECT stock FROM products WHERE id = 3')!.stock).toBe(80 - rows.length);
      console.log(`durability: ${outcome.filter((o) => o === 'ack').length} acknowledged (all present); ${interrupted.length} interrupted -> ${committedInterrupted.length} fully committed, ${rolledBack.length} fully rolled back; 0 partial, 0 duplicates`);
      db.close();
    } finally {
      await srv.stop();
    }
  });

  // Deterministic crash points (PHARMACY_TEST_CRASH): the process is SIGKILLed at an exact moment of one sale.
  for (const point of ['before-commit', 'after-commit'] as const) {
    it(`crash ${point === 'before-commit' ? 'INSIDE the transaction (before COMMIT): the sale is fully absent' : 'AFTER COMMIT, before the reply: the sale is fully present although the client got no answer'}`, async () => {
      const seedSrv = await startServer();
      const workDir = seedSrv.workDir;
      await seedSrv.stop();
      const srv = await startServer({ workDir, env: { PHARMACY_TEST_CRASH: `${point}:POST /api/sales` } });
      const admin = new Api();
      await admin.login('admin', 'admin123');
      const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 3);
      const before = (await admin.get('/customers')).body.find((c: any) => c.id === 2).current_balance;
      let answered = false;
      await admin.post('/sales', salePayload([cartItem(p, 4)], { payment_method: 'UDHAR', customer_id: 2, client_txn_id: 'crash-point-sale-0001' }))
        .then(() => { answered = true; }, () => { /* connection dropped */ });
      await srv.kill();
      expect(answered).toBe(false);

      const again = await startServer({ workDir });
      try {
        const db = await openReadOnly(again.dbFile);
        const sales = all<{ id: number }>(db, "SELECT h.id FROM sales_headers h JOIN idempotency_keys k ON json_extract(k.response, '$.sale_id') = h.id WHERE k.key = 'crash-point-sale-0001'");
        const ledger = one<{ n: number }>(db, 'SELECT COUNT(*) n FROM customer_ledger WHERE debit = 700')!.n; // 4 x Rs. 175
        const balance = one<{ b: number }>(db, 'SELECT current_balance b FROM customers WHERE id = 2')!.b;
        const stock = one<{ s: number }>(db, 'SELECT stock s FROM products WHERE id = 3')!.s;
        const audit = one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'CREATE_SALE'")!.n;
        if (point === 'before-commit') {
          expect({ sales: sales.length, ledger, balance, stock, audit }).toEqual({ sales: 0, ledger: 0, balance: before, stock: 80, audit: 0 });
        } else {
          expect({ sales: sales.length, ledger, balance, stock, audit }).toEqual({ sales: 1, ledger: 1, balance: before + 700, stock: 76, audit: 1 });
        }
        expect(one(db, 'SELECT COUNT(*) n FROM sale_items i WHERE NOT EXISTS (SELECT 1 FROM sales_headers h WHERE h.id = i.sale_id)')).toEqual({ n: 0 });
        expect(integrityCheck(db)).toEqual([]);
        db.close();
      } finally {
        await again.stop();
      }
    });
  }

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
