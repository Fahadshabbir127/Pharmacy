/**
 * Phase 7 Batch 2b: payment module and APIs (P1-P8, Q1, conditions 1-10).
 * Legacy demo seed: customer 1 owes 2450 on INV-1001 (paid 200 at the sale), customer 2 has an opening
 * balance of 1200, customer 3 owes nothing. Panadol #1 Rs. 220, Augmentin #2 Rs. 380, Brufen #3 Rs. 175.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, Api, RunningServer, cartItem, salePayload, PROJECT_ROOT, makeTempDir } from '../helpers/server';
import { openReadOnly, one, all } from '../helpers/db';
import { ensureFixtures } from '../legacy/generate-fixtures';

let srv: RunningServer;
let admin: Api;
let staff: Api;
const txn = () => crypto.randomUUID();
const product = async (id: number) => (await admin.get('/inventory')).body.find((p: any) => p.id === id);
const q = async <T = any>(sql: string, params: any[] = []) => { const db = await openReadOnly(srv.dbFile); try { return all<T>(db, sql, params); } finally { db.close(); } };
const q1 = async <T = any>(sql: string, params: any[] = []) => (await q<T>(sql, params))[0];
const balance = async (id: number) => (await q1<any>('SELECT current_balance b FROM customers WHERE id = ?', [id])).b as number;
const sale = (id: number) => q1<any>('SELECT balance_due, settlement_status, amount_paid, amount_due, payment_status, payment_method FROM sales_headers WHERE id = ?', [id]);
const snapshot = async () => ({
  payments: (await q1<any>('SELECT COUNT(*) n FROM payments')).n, allocations: (await q1<any>('SELECT COUNT(*) n FROM payment_allocations')).n,
  ledger: (await q1<any>('SELECT COUNT(*) n FROM customer_ledger')).n, keys: (await q1<any>('SELECT COUNT(*) n FROM idempotency_keys')).n,
  balances: await q('SELECT id, current_balance FROM customers ORDER BY id'), sales: (await q1<any>('SELECT COUNT(*) n FROM sales_headers')).n,
  due: await q('SELECT id, balance_due FROM sales_headers ORDER BY id'),
});
const reconciled = async () => (await admin.get('/payments/reconciliation')).body.mismatches;

async function boot(opts: Parameters<typeof startServer>[0] = {}) {
  srv = await startServer(opts);
  admin = new Api();
  await admin.login('admin', 'admin123');
  staff = new Api();
  if (!opts.seedDb) await staff.login('staff', 'staff123');
}
afterEach(async () => { await srv?.stop(); });

describe('payments at the sale (P6 split payments)', () => {
  beforeEach(async () => { await boot(); });

  it('cash + card pay the bill; one record per method; change only from cash; header label stays CASH', async () => {
    const r = await admin.post('/sales', salePayload([cartItem(await product(2), 1)], { payments: [{ method: 'CARD', amount: 100, reference: 'POS-7781' }, { method: 'CASH', amount: 500 }] }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ grand_total: 380, amount_paid: 380, amount_due: 0, change_due: 220, balance_due: 0 });
    expect(r.body.payments.map((p: any) => [p.method, p.amount, p.cash_tendered, p.change_given, p.reference])).toEqual([['CARD', 100, null, null, 'POS-7781'], ['CASH', 280, 500, 220, null]]);
    expect(await sale(r.body.sale_id)).toMatchObject({ payment_method: 'CASH', payment_status: 'PAID', balance_due: 0, settlement_status: 'PAID' });
    const d = (await admin.get(`/sales/${r.body.sale_id}`)).body;
    expect(d.payments.map((p: any) => [p.kind, p.method, p.amount, p.applied_to_this_invoice])).toEqual([['SALE_TENDER', 'CARD', 100, 100], ['SALE_TENDER', 'CASH', 280, 280]]);
    expect(await q('SELECT client_txn_id FROM payments WHERE sale_id = ? ORDER BY id', [r.body.sale_id])).toEqual([{ client_txn_id: expect.stringMatching(/-t1$/) }, { client_txn_id: expect.stringMatching(/-t2$/) }]);
  });

  it('wallet + Udhar for a customer: the rest is owed on the invoice and the customer balance', async () => {
    const r = await admin.post('/sales', salePayload([cartItem(await product(2), 1)], { customer_id: 3, payments: [{ method: 'MOBILE_WALLET', method_detail: 'JazzCash', amount: 100, reference: 'JC-55' }] }));
    expect(r.body).toMatchObject({ amount_paid: 100, amount_due: 280, balance_due: 280, new_balance: 280 });
    expect(await sale(r.body.sale_id)).toMatchObject({ payment_method: 'PARTIAL', payment_status: 'PARTIAL', settlement_status: 'PARTIAL' });
    const u = await admin.post('/sales', salePayload([cartItem(await product(3), 1)], { customer_id: 3, payments: [] }));
    expect(await sale(u.body.sale_id)).toMatchObject({ payment_method: 'UDHAR', settlement_status: 'UNPAID', balance_due: 175 });
  });

  it('refused before anything is written: walk-in not paying in full, card over the bill, unknown or incomplete methods, bad amounts, no transaction id', async () => {
    const before = await snapshot();
    const p = await product(2);
    const cases: [any, number, string][] = [
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CARD', amount: 100 }] }), 400, 'INSUFFICIENT_PAYMENT'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CARD', amount: 400 }] }), 400, 'OVERPAYMENT'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CHEQUE', amount: 380 }] }), 400, 'INVALID_PAYMENT_METHOD'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'MOBILE_WALLET', amount: 380 }] }), 400, 'INVALID_PAYMENT_METHOD'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CASH', amount: 380.001 }] }), 400, 'INVALID_AMOUNT'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CASH', amount: -1 }] }), 400, 'INVALID_AMOUNT'],
      [salePayload([cartItem(p, 1)], { payments: [{ method: 'CASH', amount: 'abc' }] }), 400, 'INVALID_AMOUNT'],
      [{ ...salePayload([cartItem(p, 1)]), client_txn_id: undefined }, 400, 'TXN_ID_REQUIRED'],
    ];
    for (const [body, status, code] of cases) {
      const r = await admin.post('/sales', body);
      expect([r.status, r.body.code], JSON.stringify(body.payments)).toEqual([status, code]);
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('payments after the sale', () => {
  beforeEach(async () => { await boot(); });

  it('several payments against one invoice; never more than it owes (P1); ledger, balance and audit', async () => {
    const pay = (amount: number, extra: any = {}) => staff.post('/sales/1/payments', { amount, method: 'BANK_TRANSFER', reference: 'HBL-1', client_txn_id: txn(), ...extra });
    const a = await pay(1000);
    expect(a.body).toMatchObject({ amount: 1000, balance_due: 1450, settlement_status: 'PARTIAL', new_balance: 1450 });
    const before = await snapshot();
    const over = await pay(1450.01);
    expect([over.status, over.body.code, over.body.balance_due]).toEqual([400, 'OVERPAYMENT', 1450]);
    expect(await snapshot()).toEqual(before);
    const b = await pay(1450, { method: 'CASH' });
    expect(b.body).toMatchObject({ balance_due: 0, settlement_status: 'PAID', new_balance: 0 });
    expect(await sale(1)).toMatchObject({ amount_paid: 200, amount_due: 2450, payment_status: 'PARTIAL', balance_due: 0, settlement_status: 'PAID' }); // at-sale snapshot kept
    expect(await q("SELECT type, credit, sale_id, payment_id IS NOT NULL linked FROM customer_ledger WHERE customer_id = 1 AND type = 'PAYMENT' ORDER BY id")).toEqual([
      { type: 'PAYMENT', credit: 1000, sale_id: 1, linked: 1 }, { type: 'PAYMENT', credit: 1450, sale_id: 1, linked: 1 },
    ]);
    expect((await q("SELECT description FROM audit_logs WHERE action_type = 'PAYMENT_RECORDED' ORDER BY id")).map((r: any) => r.description)).toEqual([
      expect.stringMatching(/INV-1001: Rs\. 1000 by Bank Transfer \(ref HBL-1\)\. Invoice balance Rs\. 2450 -> Rs\. 1450 \(PARTIAL\)/),
      expect.stringMatching(/INV-1001: Rs\. 1450 by Cash.*-> Rs\. 0 \(PAID\)/),
    ]);
    expect(await reconciled()).toEqual([]);
  });

  it('customer payments settle the opening balance, then the oldest invoices; the rest is advance (E5, P2); the advance settles the next credit sale (P3)', async () => {
    const u1 = await admin.post('/sales', salePayload([cartItem(await product(2), 1)], { payment_method: 'UDHAR', customer_id: 2 })); // 380
    expect(await balance(2)).toBe(1580);
    const p1 = await staff.post('/customers/2/payment', { amount: 1000, payment_mode: 'Cash', client_txn_id: txn() });
    expect(p1.body).toMatchObject({ newBalance: 580, advance_remaining: 0, allocations: [{ target: 'OPENING_BALANCE', amount: 1000 }] });
    const p2 = await staff.post('/customers/2/payment', { amount: 1000, method: 'MOBILE_WALLET', method_detail: 'EasyPaisa', reference: 'EP-9', client_txn_id: txn() });
    expect(p2.body).toMatchObject({ newBalance: -420, advance_remaining: 420, allocations: [{ target: 'OPENING_BALANCE', amount: 200 }, { target: 'SALE', sale_id: u1.body.sale_id, amount: 380 }] });
    expect(await sale(u1.body.sale_id)).toMatchObject({ balance_due: 0, settlement_status: 'PAID' });
    // P3: the advance settles the next credit invoice automatically, in the same transaction as the sale
    const u2 = await admin.post('/sales', salePayload([cartItem(await product(3), 1)], { payment_method: 'UDHAR', customer_id: 2 })); // 175
    expect(u2.body).toMatchObject({ amount_due: 175, balance_due: 0, new_balance: -245, advance_applied: [{ payment_id: p2.body.payment_id, amount: 175 }] });
    expect(await sale(u2.body.sale_id)).toMatchObject({ payment_status: 'UNPAID', settlement_status: 'PAID' });
    const o = (await admin.get('/customers/2/outstanding')).body;
    expect(o).toMatchObject({ stored_balance: -245, explained_balance: -245, difference: 0, owed: 0, advance: 245, items: [] });
    const hist = (await admin.get('/customers/2/payments')).body;
    expect(hist.map((p: any) => [p.kind, p.amount, p.allocations.map((a: any) => [a.target, a.amount, a.source])])).toEqual([
      ['CUSTOMER_PAYMENT', 1000, [['OPENING_BALANCE', 200, 'CUSTOMER_SCREEN'], ['SALE', 380, 'CUSTOMER_SCREEN'], ['SALE', 175, 'ADVANCE']]],
      ['CUSTOMER_PAYMENT', 1000, [['OPENING_BALANCE', 1000, 'CUSTOMER_SCREEN']]],
    ]);
    expect((await q1<any>("SELECT description FROM audit_logs WHERE action_type = 'ADVANCE_APPLIED'")).description).toMatch(/advance applied to invoice/);
    expect(await reconciled()).toEqual([]);
  });
});

describe('duplicate requests and concurrent payments (conditions 1, 3)', () => {
  beforeEach(async () => { await boot(); });

  it('the same transaction id records one payment (replay); a transaction id cannot be reused for another operation', async () => {
    const id = txn();
    const a = await staff.post('/customers/1/payment', { amount: 100, payment_mode: 'Cash', client_txn_id: id });
    const b = await staff.post('/customers/1/payment', { amount: 100, payment_mode: 'Cash', client_txn_id: id });
    expect(b.body).toMatchObject({ replayed: true, payment_id: a.body.payment_id });
    expect(await balance(1)).toBe(2350);
    const other = await staff.post('/sales/1/payments', { amount: 50, method: 'CASH', client_txn_id: id });
    expect([other.status, other.body.code]).toEqual([409, 'TXN_ID_REUSED']);
    const asSale = await staff.post('/sales', salePayload([cartItem(await product(1), 1)], { client_txn_id: id }));
    expect([asSale.status, asSale.body.code]).toEqual([409, 'TXN_ID_REUSED']);
    expect((await q1<any>("SELECT COUNT(*) n FROM payments WHERE client_txn_id = ?", [id])).n).toBe(1);
  });

  it('20 simultaneous Rs. 150 payments on an invoice owing 2450: exactly 16 accepted, the rest refused, never overpaid', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? admin : staff).post('/sales/1/payments', { amount: 150, method: 'CASH', client_txn_id: txn() })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(16);
    expect(results.filter((r) => r.status === 400).every((r) => r.body.code === 'OVERPAYMENT')).toBe(true);
    expect(results.filter((r) => r.status !== 200 && r.status !== 400)).toEqual([]);
    expect(await sale(1)).toMatchObject({ balance_due: 50, settlement_status: 'PARTIAL' });
    expect(await balance(1)).toBe(50);
    expect(await reconciled()).toEqual([]);
  });

  it('10 simultaneous retries of the same customer payment record it once', async () => {
    const id = txn();
    const results = await Promise.all(Array.from({ length: 10 }, () => staff.post('/customers/3/payment', { amount: 75, payment_mode: 'Cash', client_txn_id: id })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.payment_id)).size).toBe(1);
    expect(await balance(3)).toBe(-75);
    expect((await q1<any>('SELECT COUNT(*) n FROM payments WHERE customer_id = 3')).n).toBe(1);
  });
});

describe('reversals (P7) and the interim void (P5)', () => {
  beforeEach(async () => { await boot(); });

  it('ADMIN only, reason required; releases allocations, restores balances, never edits or deletes; only once', async () => {
    const p = await staff.post('/customers/1/payment', { amount: 1000, payment_mode: 'Cash', client_txn_id: txn() });
    expect(await sale(1)).toMatchObject({ balance_due: 1450 });
    expect((await staff.post(`/payments/${p.body.payment_id}/reverse`, { reason: 'x', client_txn_id: txn() })).status).toBe(403);
    expect((await admin.post(`/payments/${p.body.payment_id}/reverse`, { client_txn_id: txn() })).body.code).toBe('REASON_REQUIRED');
    expect((await admin.post(`/payments/${p.body.payment_id}/reverse`, { reason: 'x' })).body.code).toBe('TXN_ID_REQUIRED');
    const r = await admin.post(`/payments/${p.body.payment_id}/reverse`, { reason: 'entered on the wrong customer', client_txn_id: txn() });
    expect(r.body).toMatchObject({ amount: 1000, new_balance: 2450, released: [{ target: 'SALE', invoice_number: 'INV-1001', amount: -1000 }] });
    expect(await sale(1)).toMatchObject({ balance_due: 2450, settlement_status: 'PARTIAL' });
    expect(await q('SELECT direction, kind, amount, reverses_payment_id, reason FROM payments WHERE id IN (?, ?) ORDER BY id', [p.body.payment_id, r.body.reversal_id])).toEqual([
      { direction: 'IN', kind: 'CUSTOMER_PAYMENT', amount: 1000, reverses_payment_id: null, reason: null },
      { direction: 'OUT', kind: 'REVERSAL', amount: 1000, reverses_payment_id: p.body.payment_id, reason: 'entered on the wrong customer' },
    ]);
    expect(await q1("SELECT type, debit FROM customer_ledger WHERE customer_id = 1 ORDER BY id DESC LIMIT 1")).toEqual({ type: 'ADJUSTMENT', debit: 1000 });
    expect((await q1<any>("SELECT description FROM audit_logs WHERE action_type = 'PAYMENT_REVERSED'")).description).toMatch(/Reversed payment #\d+ \(Rs\. 1000, Cash.*released 1 allocation\(s\) totalling Rs\. 1000\. Reason: entered on the wrong customer/);
    const again = await admin.post(`/payments/${p.body.payment_id}/reverse`, { reason: 'again', client_txn_id: txn() });
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_REVERSED']);
    const ofReversal = await admin.post(`/payments/${r.body.reversal_id}/reverse`, { reason: 'x', client_txn_id: txn() });
    expect(ofReversal.body.code).toBe('NOT_REVERSIBLE');
    // 5 simultaneous reversal attempts of another payment: exactly one succeeds
    const p2 = await staff.post('/customers/1/payment', { amount: 10, payment_mode: 'Cash', client_txn_id: txn() });
    const rs = await Promise.all(Array.from({ length: 5 }, () => admin.post(`/payments/${p2.body.payment_id}/reverse`, { reason: 'dup test', client_txn_id: txn() })));
    expect(rs.filter((x) => x.status === 200)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 409).every((x) => x.body.code === 'ALREADY_REVERSED')).toBe(true);
    expect(await reconciled()).toEqual([]);
  });

  it('a reversal re-opens what the payment settled; another advance of the customer settles it again (approved priority)', async () => {
    // customer 3: credit invoice 380, pays 380 (settles it), then pays 500 more (advance 500)
    const s = await admin.post('/sales', salePayload([cartItem(await product(2), 1)], { payment_method: 'UDHAR', customer_id: 3 }));
    const p1 = await staff.post('/customers/3/payment', { amount: 380, payment_mode: 'Cash', client_txn_id: txn() });
    await staff.post('/customers/3/payment', { amount: 500, payment_mode: 'Card', client_txn_id: txn() });
    const r = await admin.post(`/payments/${p1.body.payment_id}/reverse`, { reason: 'cheque bounced', client_txn_id: txn() });
    expect(r.body).toMatchObject({ released: [{ invoice_number: s.body.invoice_number, amount: -380 }], advance_applied: [{ target: 'SALE', invoice_number: s.body.invoice_number, amount: 380 }], new_balance: -120 });
    expect(await sale(s.body.sale_id)).toMatchObject({ balance_due: 0, settlement_status: 'PAID' });
    expect((await admin.get('/customers/3/outstanding')).body).toMatchObject({ advance: 120, difference: 0 });
    expect(await reconciled()).toEqual([]);
  });

  it('a walk-in sale payment can only be reversed by voiding the sale', async () => {
    const s = await admin.post('/sales', salePayload([cartItem(await product(1), 1)]));
    const r = await admin.post(`/payments/${s.body.payments[0].payment_id}/reverse`, { reason: 'x', client_txn_id: txn() });
    expect([r.status, r.body.code]).toEqual([409, 'WALKIN_PAYMENT_REVERSAL']);
  });

  it('void: refused when the invoice has later payments; a checkout-only void keeps the payment history with a reversal; never a second reversal', async () => {
    // later payment -> refused
    const before = await snapshot();
    await staff.post('/sales/1/payments', { amount: 50, method: 'CASH', client_txn_id: txn() });
    const refused = await admin.del('/sales/1');
    expect([refused.status, refused.body.code]).toEqual([409, 'VOID_HAS_PAYMENTS']);
    expect((await snapshot()).sales).toBe(before.sales);
    // checkout-only walk-in sale (cash + card)
    const s = await admin.post('/sales', salePayload([cartItem(await product(2), 1)], { payments: [{ method: 'CARD', amount: 80 }, { method: 'CASH', amount: 300 }] }));
    const v = await admin.del(`/sales/${s.body.sale_id}`);
    expect(v.status).toBe(200);
    expect(v.body.payment_reversals).toHaveLength(2);
    const rows = await q(`SELECT direction, kind, method, amount, sale_id, invoice_number FROM payments WHERE invoice_number = ? ORDER BY id`, [s.body.invoice_number]);
    expect(rows).toEqual([
      { direction: 'IN', kind: 'SALE_TENDER', method: 'CARD', amount: 80, sale_id: null, invoice_number: s.body.invoice_number },
      { direction: 'IN', kind: 'SALE_TENDER', method: 'CASH', amount: 300, sale_id: null, invoice_number: s.body.invoice_number },
      { direction: 'OUT', kind: 'REVERSAL', method: 'CARD', amount: 80, sale_id: null, invoice_number: s.body.invoice_number },
      { direction: 'OUT', kind: 'REVERSAL', method: 'CASH', amount: 300, sale_id: null, invoice_number: s.body.invoice_number },
    ]);
    // a customer partial sale whose at-sale payment was ALREADY reversed: the void does not reverse it twice
    const c = await admin.post('/sales', salePayload([cartItem(await product(3), 1)], { customer_id: 3, payments: [{ method: 'CASH', amount: 100 }] }));
    const pid = c.body.payments[0].payment_id;
    await admin.post(`/payments/${pid}/reverse`, { reason: 'wrong amount typed', client_txn_id: txn() });
    expect(await balance(3)).toBe(175);
    const v2 = await admin.del(`/sales/${c.body.sale_id}`);
    expect(v2.body.payment_reversals).toEqual([]);
    expect((await q1<any>('SELECT COUNT(*) n FROM payments WHERE reverses_payment_id = ?', [pid])).n).toBe(1);
    expect(await balance(3)).toBe(0); // exactly what the invoice owed - no clamping
    expect(await reconciled()).toEqual([]);
  });
});

describe('failure and rollback (database transaction)', () => {
  for (const [hook, call] of [
    ['payment-after-allocation', (a: Api) => a.post('/customers/1/payment', { amount: 300, payment_mode: 'Cash', client_txn_id: txn() })],
    ['payment-after-allocation', (a: Api) => a.post('/sales/1/payments', { amount: 300, method: 'CARD', client_txn_id: txn() })],
    ['sale-after-payments', async (a: Api) => a.post('/sales', salePayload([cartItem((await a.get('/inventory')).body.find((p: any) => p.id === 2), 1)], { customer_id: 2, payments: [{ method: 'CARD', amount: 100 }] }))],
  ] as const) {
    it(`a failure after the allocation is written (${hook}) rolls back payment, allocations, balance, ledger and idempotency key`, async () => {
      await boot({ env: { PHARMACY_TEST_THROW: hook } });
      const before = await snapshot();
      const r = await call(admin);
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/injected failure/);
      expect(await snapshot()).toEqual(before);
    });
  }
});

describe('Q1: administrator-confirmed carried-over balances (database from the original app)', () => {
  it('positive differences are listed for review and confirmed once with a reason; negative ones stay report-only; payments settle the item after the opening balance', async () => {
    const fx = await ensureFixtures(path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy'));
    expect(fx['payments-edge-cases']).toBeTruthy();
    // a copy of the original-app database; one extra NEGATIVE difference is made on the copy (test only)
    const dir = makeTempDir();
    const copy = path.join(dir, 'seed.sqlite');
    fs.copyFileSync(path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy', 'payments-edge-cases.sqlite'), copy);
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(copy);
    raw.prepare("UPDATE customers SET current_balance = current_balance - 25 WHERE name = 'Dr. Rashid Ahmad'").run();
    raw.close();
    await boot({ seedDb: copy });
    const staffUser = await admin.post('/users', { username: 'counter9', password: 'Counter123', fullName: 'Counter Nine', role: 'STAFF' });
    expect(staffUser.status).toBe(200);
    await staff.login('counter9', 'Counter123');

    expect((await staff.get('/payments/reconciliation')).status).toBe(403);
    const rec = (await admin.get('/payments/reconciliation')).body;
    expect(rec.mismatches.map((m: any) => [m.name, m.difference, m.confirmable])).toEqual([
      ['Tariq Mahmood', 1200, true], ['Dr. Rashid Ahmad', -25, false], ['Fixture Voided', 300, true],
    ]);
    expect(rec.migration_issues.map((i: any) => i.issue)).toEqual(expect.arrayContaining(['BALANCE_MISMATCH', 'UNMAPPED_PAYMENT_METHOD', 'OVERPAID_AT_SALE', 'WALKIN_SALE_WITH_DUE', 'NEGATIVE_OPENING_BALANCE']));
    expect(rec.walk_in_sales_with_due).toEqual([expect.objectContaining({ invoice_number: 'INV-1-1005', balance_due: 120 })]);

    const confirm = (id: number, body: any, who = admin) => who.post(`/customers/${id}/carried-over-balance`, { client_txn_id: txn(), ...body });
    expect((await confirm(2, { expected_difference: 1200, reason: 'x' }, staff)).status).toBe(403);
    expect((await confirm(2, { expected_difference: 1200 })).body.code).toBe('REASON_REQUIRED');
    expect((await confirm(2, { expected_difference: 1000, reason: 'old notebook balance' })).body.code).toBe('DISCREPANCY_CHANGED');
    expect((await confirm(3, { expected_difference: -25, reason: 'x' })).body.code).toBe('NEGATIVE_DISCREPANCY');
    const before = await balance(2);
    const id = txn();
    const ok = await admin.post('/customers/2/carried-over-balance', { client_txn_id: id, expected_difference: 1200, reason: 'Balance from the paper notebook before the software' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ amount: 1200, stored_balance: 1150, explained_balance_before: -50, difference_after: 0,
      advance_applied: [{ target: 'CARRIED_OVER_BALANCE', amount: 50 }] }); // the existing Rs. 50 advance settles part of it (2c decision)
    expect(await balance(2)).toBe(before); // stored balance never changed
    expect((await admin.post('/customers/2/carried-over-balance', { client_txn_id: id, expected_difference: 1200, reason: 'x' })).body.replayed).toBe(true);
    expect((await confirm(2, { expected_difference: 1200, reason: 'twice' })).body.code).toBe('NO_DISCREPANCY');
    const row = await q1<any>("SELECT customer_id, amount, stored_balance, explained_balance, difference, reason, confirmed_by_user_id, confirmed_at, migration_issue_id FROM customer_carried_over_balances");
    expect(row).toMatchObject({ customer_id: 2, amount: 1200, stored_balance: 1150, explained_balance: -50, difference: 1200, reason: 'Balance from the paper notebook before the software', confirmed_by_user_id: expect.any(Number), migration_issue_id: expect.any(Number) });
    expect((await q1<any>("SELECT user_id, description FROM audit_logs WHERE action_type = 'CARRIED_OVER_BALANCE_CONFIRMED'"))).toMatchObject({
      user_id: row.confirmed_by_user_id, description: expect.stringMatching(/confirmed Rs\. 1200\.00 .*stored balance Rs\. 1150\.00, explained by records Rs\. -50\.00.*Stored balance not changed\. Reason: Balance from the paper notebook/),
    });
    // the reconciliation no longer lists Tariq; the negative difference is still there, untouched
    expect((await reconciled()).map((m: any) => m.name)).toEqual(['Dr. Rashid Ahmad', 'Fixture Voided']);
    expect((await q1<any>("SELECT description FROM audit_logs WHERE action_type = 'ADVANCE_APPLIED'")).description).toMatch(/after confirming carried-over balance/);
    // the preview shows what a payment would settle, without writing anything
    const pv = (await staff.get('/customers/2/payment-preview?amount=1000')).body;
    expect(pv).toMatchObject({ owed: 1150, advance: 0, allocations: [{ target: 'CARRIED_OVER_BALANCE', due: 1150, amount: 1000 }], advance_after: 0, balance_after: 150 });
    // payments settle the carried-over item (no opening balance here)
    const p = await staff.post('/customers/2/payment', { amount: 1000, payment_mode: 'Cash', client_txn_id: txn() });
    expect(p.body).toMatchObject({ newBalance: 150, allocations: [{ target: 'CARRIED_OVER_BALANCE', amount: 1000 }] });
    expect((await admin.get('/customers/2/outstanding')).body).toMatchObject({ stored_balance: 150, explained_balance: 150, difference: 0, advance: 0, items: [{ target: 'CARRIED_OVER_BALANCE', due: 150 }] });
    expect((await reconciled()).map((m: any) => m.name)).toEqual(['Dr. Rashid Ahmad', 'Fixture Voided']);
  }, 120_000);
});
