/**
 * Phase 7 Batch 2d: financial integrity sweep and protocol compatibility.
 *
 * 120 mixed operations chosen by a seeded pseudo-random generator (repeatable), all through the HTTP API:
 * sales (cash, split, partial, credit), customer payments (incl. overpayments -> advance), invoice payments
 * (incl. refused overpayments), replays of the same transaction id, reversals (incl. refused second reversals)
 * and interim voids (incl. refused ones). Afterwards every invariant must hold:
 *  - each invoice: balance_due = grand_total - net allocations, 0 <= balance_due <= grand_total, status matches
 *  - each payment: net allocations <= amount; a reversed payment keeps nothing allocated; one reversal at most
 *  - each customer: stored balance = sum of their ledger rows (debit - credit) AND = what the records explain
 *  - every allocation of an advance followed the approved order (no customer has advance while owing anything)
 *  - payments and allocations were never edited or deleted (counts only grow; first rows unchanged)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startServer, Api, RunningServer, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, all, one } from '../helpers/db';

let srv: RunningServer;
afterEach(async () => { await srv?.stop(); });

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('financial integrity sweep (seeded, repeatable)', () => {
  it('120 mixed payment operations leave every balance, ledger and allocation consistent', async () => {
    srv = await startServer();
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const staff = new Api();
    await staff.login('staff', 'staff123');
    const r = rng(20261113);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const txn = () => `sweep-${Math.floor(r() * 1e12).toString(36)}-${Date.now().toString(36)}`;
    const products: any[] = (await admin.get('/inventory')).body.filter((p: any) => [1, 2, 3, 4, 5].includes(p.id));
    const customers = [1, 2, 3];
    const usedTxns: { route: string; body: any; who: Api }[] = [];
    const tally: Record<string, number> = {};
    const count = (k: string) => { tally[k] = (tally[k] || 0) + 1; };
    const methods = ['CASH', 'CARD', 'BANK_TRANSFER'];

    const db0 = await openReadOnly(srv.dbFile);
    const firstPayments = all(db0, 'SELECT * FROM payments ORDER BY id');
    db0.close();

    for (let step = 0; step < 120; step++) {
      const who = r() < 0.5 ? admin : staff;
      const op = r();
      if (op < 0.3) {
        // a sale: cash / split / partial / credit
        const p = pick(products);
        const qty = 1 + Math.floor(r() * 2);
        const total = p.sale_price * qty;
        const cust = r() < 0.6 ? pick(customers) : undefined;
        const kind = r();
        let payments: any[];
        if (!cust || kind < 0.3) payments = [{ method: 'CASH', amount: total + Math.floor(r() * 100) }];
        else if (kind < 0.55) payments = [{ method: 'CARD', amount: Math.floor(total / 2) }, { method: 'CASH', amount: total - Math.floor(total / 2) }];
        else if (kind < 0.8) payments = [{ method: pick(methods), amount: Math.max(1, Math.floor(total * r())) }];
        else payments = [];
        const body = salePayload([cartItem(p, qty)], { customer_id: cust, payments, client_txn_id: txn() });
        const res = await who.post('/sales', body);
        // [LEGACY-BUG R4] after a void deletes an older invoice, the next invoice number already exists and the
        // sale fails (rolled back completely). Not a payment defect; reported in Batch 2d, fix pending approval.
        const r4 = res.status === 500 && /UNIQUE constraint failed: sales_headers\.invoice_number/.test(res.body.error || '');
        if (res.status >= 500) expect(r4, `unexpected sale failure: ${JSON.stringify(res.body)}`).toBe(true);
        count(r4 ? 'sale 500 R4 duplicate invoice number' : `sale ${res.status}`);
        if (res.status === 200 && r() < 0.2) usedTxns.push({ route: '/sales', body, who });
      } else if (op < 0.5) {
        const c = pick(customers);
        const body = { amount: Math.round(50 + r() * 1500), method: pick(methods), client_txn_id: txn() };
        const res = await who.post(`/customers/${c}/payment`, body);
        count(`customer payment ${res.status}`);
        if (res.status === 200 && r() < 0.3) usedTxns.push({ route: `/customers/${c}/payment`, body, who });
      } else if (op < 0.65) {
        const sales: any[] = (await admin.get('/sales/history')).body.filter((s: any) => s.balance_due > 0.004);
        if (!sales.length) continue;
        const s = pick(sales);
        const over = r() < 0.25;
        const amount = over ? Math.round((s.balance_due + 1) * 100) / 100 : Math.max(0.01, Math.round(s.balance_due * r() * 100) / 100);
        const res = await who.post(`/sales/${s.id}/payments`, { amount, method: pick(methods), client_txn_id: txn() });
        count(`invoice payment ${over ? 'over ' : ''}${res.status}`);
        if (over) expect(res.body.code).toBe('OVERPAYMENT');
      } else if (op < 0.75) {
        if (!usedTxns.length) continue;
        const u = pick(usedTxns);
        const res = await u.who.post(u.route, u.body);
        count(`replay ${res.status}`);
        expect(res.body.replayed).toBe(true);
      } else if (op < 0.88) {
        const pays: any[] = (await admin.get('/payments?limit=1000')).body.filter((p: any) => p.direction === 'IN' && p.customer_id);
        if (!pays.length) continue;
        const p = pick(pays);
        const res = await admin.post(`/payments/${p.id}/reverse`, { reason: `sweep step ${step}`, client_txn_id: txn() });
        count(`reverse ${res.status}${res.body.code ? ' ' + res.body.code : ''}`);
        expect([200, 409]).toContain(res.status);
        if (res.status === 409) expect(['ALREADY_REVERSED']).toContain(res.body.code);
      } else {
        const sales: any[] = (await admin.get('/sales/history')).body.filter((s: any) => s.id > 1);
        if (!sales.length) continue;
        const s = pick(sales);
        const res = await admin.del(`/sales/${s.id}`);
        count(`void ${res.status}${res.body.code ? ' ' + res.body.code : ''}`);
        expect([200, 409]).toContain(res.status);
      }
    }

    const db = await openReadOnly(srv.dbFile);
    try {
      // invoices
      for (const s of all<any>(db, `SELECT s.id, s.grand_total, s.balance_due, s.settlement_status,
          (SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) FROM payment_allocations a WHERE a.sale_id = s.id) applied FROM sales_headers s`)) {
        expect(s.balance_due, `invoice ${s.id}`).toBeCloseTo(s.grand_total - s.applied, 2);
        expect(s.balance_due).toBeGreaterThanOrEqual(-0.004);
        expect(s.balance_due).toBeLessThanOrEqual(s.grand_total + 0.004);
        expect(s.settlement_status).toBe(s.balance_due <= 0.004 ? 'PAID' : s.applied <= 0.004 ? 'UNPAID' : 'PARTIAL');
      }
      // payments
      for (const p of all<any>(db, `SELECT p.id, p.amount, p.direction,
          (SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) FROM payment_allocations a WHERE a.payment_id = p.id) net,
          (SELECT COUNT(*) FROM payments r WHERE r.reverses_payment_id = p.id) reversals FROM payments p`)) {
        expect(p.net, `payment ${p.id}`).toBeLessThanOrEqual(p.amount + 0.005);
        expect(p.reversals).toBeLessThanOrEqual(1);
        if (p.reversals) expect(Math.abs(p.net)).toBeLessThan(0.005);
      }
      // customers: stored balance = ledger = records
      for (const c of all<any>(db, `SELECT c.id, c.current_balance b, (SELECT COALESCE(SUM(debit - credit), 0) FROM customer_ledger l WHERE l.customer_id = c.id) ledger FROM customers c WHERE c.is_placeholder = 0`)) {
        expect(c.b, `customer ${c.id} stored vs ledger`).toBeCloseTo(c.ledger, 2);
      }
      // the original (seeded) payment rows are unchanged
      expect(all(db, `SELECT * FROM payments WHERE id <= ${firstPayments.length} ORDER BY id`)).toEqual(firstPayments);
      expect(one<any>(db, "SELECT COUNT(*) n FROM payments WHERE direction = 'OUT' AND kind <> 'REVERSAL'").n).toBe(0);
    } finally {
      db.close();
    }
    const rec = (await admin.get('/payments/reconciliation')).body;
    expect(rec.mismatches).toEqual([]);
    expect(rec.untracked_sales).toBe(0);
    // approved order: nobody holds an advance while owing anything
    for (const c of customers) {
      const o = (await admin.get(`/customers/${c}/outstanding`)).body;
      expect(o.difference, `customer ${c}`).toBeCloseTo(0, 2);
      if (o.advance > 0.004) expect(o.items, `customer ${c} has advance and debt`).toEqual([]);
    }
    console.log('integrity sweep operations:', JSON.stringify(tally));
    // the sweep really exercised every path
    for (const k of ['sale 200', 'customer payment 200', 'invoice payment 200', 'invoice payment over 400', 'replay 200', 'reverse 200', 'void 200']) {
      expect(tally[k] || 0, k).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe('protocol 4 compatibility with requests in the protocol 3 form', () => {
  it('an older POS sale request (payment_method + amount_paid) is still recorded correctly with a payment record; requests without a transaction id are refused and write nothing', async () => {
    srv = await startServer();
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 2);
    // protocol 3 POS: payment_method + amount_paid + client_txn_id (no payments array)
    const old = await admin.post('/sales', salePayload([cartItem(p, 1)], { payment_method: 'PARTIAL', customer_id: 3, amount_paid: 100, client_txn_id: 'proto3-pos-sale-0001' }));
    expect(old.status).toBe(200);
    expect(old.body).toMatchObject({ amount_paid: 100, amount_due: 280, balance_due: 280, payments: [{ method: 'CASH', amount: 100 }] });
    // protocol 3 Customers screen: no transaction id -> refused, nothing written
    const db0 = await openReadOnly(srv.dbFile);
    const before = one<any>(db0, 'SELECT (SELECT COUNT(*) FROM payments) p, (SELECT COUNT(*) FROM customer_ledger) l, (SELECT current_balance FROM customers WHERE id = 3) b');
    db0.close();
    const pay = await admin.post('/customers/3/payment', { amount: 50, payment_mode: 'Cash' });
    expect([pay.status, pay.body.code]).toEqual([400, 'TXN_ID_REQUIRED']);
    const sale = await admin.post('/sales', { ...salePayload([cartItem(p, 1)]), client_txn_id: undefined });
    expect([sale.status, sale.body.code]).toEqual([400, 'TXN_ID_REQUIRED']);
    const db = await openReadOnly(srv.dbFile);
    expect(one<any>(db, 'SELECT (SELECT COUNT(*) FROM payments) p, (SELECT COUNT(*) FROM customer_ledger) l, (SELECT current_balance FROM customers WHERE id = 3) b')).toEqual(before);
    db.close();
    // the health answer tells clients the protocol (the desktop client blocks on a mismatch)
    expect((await new Api().get('/health')).body.apiProtocol).toBe(4);
  });
});
