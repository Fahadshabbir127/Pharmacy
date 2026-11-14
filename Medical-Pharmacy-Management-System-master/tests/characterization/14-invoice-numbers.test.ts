/**
 * Phase 7 Batch 2e: invoice numbers after voids (fix of legacy defect R4).
 * Legacy demo seed: the store already has INV-1001; new sales are INV-1-<n>.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startServer, Api, RunningServer, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, all, one } from '../helpers/db';

let srv: RunningServer;
let admin: Api;
afterEach(async () => { await srv?.stop(); });

async function boot(opts: Parameters<typeof startServer>[0] = {}) {
  srv = await startServer(opts);
  admin = new Api();
  await admin.login('admin', 'admin123');
}
const product = async () => (await admin.get('/inventory')).body.find((p: any) => p.id === 1);
const sell = async () => {
  const r = await admin.post('/sales', salePayload([cartItem(await product(), 1)]));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { sale_id: number; invoice_number: string };
};
const voidSale = async (id: number) => expect((await admin.del(`/sales/${id}`)).status).toBe(200);

describe('invoice numbers after voiding (R4 fixed)', () => {
  it('void the oldest, a middle and the latest invoice: every new sale gets a new number; no number is ever reused', async () => {
    await boot();
    const issued: string[] = ['INV-1001'];
    const a = await sell(); const b = await sell(); const c = await sell(); const d = await sell();
    issued.push(a.invoice_number, b.invoice_number, c.invoice_number, d.invoice_number);
    expect(issued).toEqual(['INV-1001', 'INV-1-1002', 'INV-1-1003', 'INV-1-1004', 'INV-1-1005']);

    // oldest (the seeded INV-1001, paid only at the sale -> voidable)
    await voidSale(1);
    for (let i = 0; i < 3; i++) issued.push((await sell()).invoice_number);
    // a middle one
    await voidSale(b.sale_id);
    for (let i = 0; i < 3; i++) issued.push((await sell()).invoice_number);
    // the latest one
    const latest = await sell();
    issued.push(latest.invoice_number);
    await voidSale(latest.sale_id);
    for (let i = 0; i < 2; i++) issued.push((await sell()).invoice_number);

    expect(issued).toEqual([
      'INV-1001', 'INV-1-1002', 'INV-1-1003', 'INV-1-1004', 'INV-1-1005',
      'INV-1-1006', 'INV-1-1007', 'INV-1-1008', // after voiding the oldest
      'INV-1-1009', 'INV-1-1010', 'INV-1-1011', // after voiding a middle one
      'INV-1-1012', // voided (latest)
      'INV-1-1013', 'INV-1-1014', // after voiding the latest: 1012 is NOT issued again
    ]);
    expect(new Set(issued).size).toBe(issued.length); // never reused
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT next_value FROM invoice_sequences WHERE tenant_id = 1')).toEqual({ next_value: 1015 });
    expect(all(db, "SELECT invoice_number FROM sales_headers WHERE invoice_number IN ('INV-1001', 'INV-1-1003', 'INV-1-1012')")).toEqual([]); // voided
    db.close();
  });

  it('30 simultaneous sales get 30 different consecutive numbers', async () => {
    await boot();
    const p = await product();
    const res = await Promise.all(Array.from({ length: 30 }, () => admin.post('/sales', salePayload([cartItem(p, 1)]))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const nums = res.map((r) => Number(r.body.invoice_number.split('-')[2])).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => 1002 + i));
  });

  it('a sale that fails and rolls back does not use up a number; numbering continues after a restart', async () => {
    await boot({ env: { PHARMACY_TEST_THROW: 'sale-after-payments' } });
    const r = await admin.post('/sales', salePayload([cartItem(await product(), 1)]));
    expect(r.status).toBe(500);
    const workDir = srv.workDir;
    await srv.stop();
    await boot({ workDir });
    expect((await sell()).invoice_number).toBe('INV-1-1002'); // the failed sale's number was rolled back with it
    const v = await sell();
    await voidSale(v.sale_id);
    await srv.stop();
    await boot({ workDir }); // restart
    expect((await sell()).invoice_number).toBe('INV-1-1004'); // 1003 was voided before the restart and is not reused
  });

  it('restoring an OLDER backup never re-issues numbers this computer already gave out', async () => {
    await boot();
    await sell(); // INV-1-1002
    const exp = await admin.post('/backup/export', { password: 'Backup123!' });
    expect(exp.status).toBe(200);
    const later = [await sell(), await sell()]; // INV-1-1003, INV-1-1004 (receipts already handed out)
    expect(later.map((s) => s.invoice_number)).toEqual(['INV-1-1003', 'INV-1-1004']);
    const imp = await admin.post('/backup/import', { backupPayload: exp.body, password: 'Backup123!' });
    expect(imp.status).toBe(200);
    // the restored data ends at INV-1-1002, but numbering continues after 1004
    const after = await sell();
    expect(after.invoice_number).toBe('INV-1-1005');
    const db = await openReadOnly(srv.dbFile);
    expect(all(db, "SELECT invoice_number FROM sales_headers WHERE invoice_number LIKE 'INV-1-%' ORDER BY id").map((r: any) => r.invoice_number)).toEqual(['INV-1-1002', 'INV-1-1005']);
    expect((one<any>(db, "SELECT description FROM audit_logs WHERE action_type = 'BACKUP_RESTORE' ORDER BY id DESC LIMIT 1")).description).toMatch(/invoice numbering continues after the numbers already issued \(store 1: next 1005\)/);
    db.close();
  });

  it('the sequence can never go down or be deleted (database guard)', async () => {
    await boot();
    await sell();
    await srv.stop();
    const Database = (await import('better-sqlite3')).default;
    const d = new Database(srv.dbFile);
    expect(() => d.prepare('UPDATE invoice_sequences SET next_value = 1002 WHERE tenant_id = 1').run()).toThrow(/INVOICE_SEQUENCE/);
    expect(() => d.prepare('DELETE FROM invoice_sequences').run()).toThrow(/INVOICE_SEQUENCE/);
    d.close();
  });
});
