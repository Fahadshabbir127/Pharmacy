/**
 * Phase 7 Batch 2b: payment service functions and the database protections they rely on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureFixtures } from '../legacy/generate-fixtures';
import { PROJECT_ROOT } from '../helpers/server';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase } from '../../server/db/open';
import { migrate } from '../../server/db/migrate';
import { MIGRATIONS } from '../../server/db/migrations';
import * as Pay from '../../server/payments/service';
import { reconcilePayments } from '../../server/payments/reconcile';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const actor = { id: 1, name: 'test' };
const audits: string[] = [];
const audit: Pay.AuditFn = (a, d) => { audits.push(`${a}: ${d}`); };
async function fresh(name = 'payments-edge-cases') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  const file = path.join(dir, 'data', 'pharmacy.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, `${name}.sqlite`), file);
  return { db: (await openDatabase(file, { backupDir: path.join(dir, 'b') })).db, file, dir };
}
const tx = <T>(db: DbAdapter, fn: () => T) => db.transaction(fn);

beforeAll(async () => { await ensureFixtures(FIXTURE_DIR); }, 600_000);

describe('validation', () => {
  it('amounts: > 0, at most 2 decimals, finite, not absurd', () => {
    expect(Pay.parseAmount(10)).toBe(10);
    expect(Pay.parseAmount('99.95')).toBe(99.95);
    for (const bad of [0, -1, 1.005, NaN, Infinity, '', 'abc', null, undefined, 10_000_001]) expect(() => Pay.parseAmount(bad as any)).toThrow(Pay.PaymentError);
  });
  it('methods: the four approved methods (E4/P6), the old screen names, wallet needs EasyPaisa or JazzCash', () => {
    expect(Pay.parseMethod('card')).toEqual({ method: 'CARD', detail: null });
    expect(Pay.parseMethod('Bank Transfer')).toEqual({ method: 'BANK_TRANSFER', detail: null });
    expect(Pay.parseMethod('EasyPaisa')).toEqual({ method: 'MOBILE_WALLET', detail: 'EasyPaisa' });
    expect(Pay.parseMethod('MOBILE_WALLET', 'jazzcash')).toEqual({ method: 'MOBILE_WALLET', detail: 'JazzCash' });
    for (const [m, d] of [['MOBILE_WALLET', undefined], ['MOBILE_WALLET', 'Paypal'], ['CHEQUE', undefined], ['UDHAR', undefined], ['', undefined], ['UNSPECIFIED', undefined]]) {
      expect(() => Pay.parseMethod(m, d)).toThrow(/Payment method|EasyPaisa or JazzCash/);
    }
  });
  it('transaction ids are required and well-formed', () => {
    expect(Pay.parseTxnId('abcd-1234')).toBe('abcd-1234');
    for (const bad of [undefined, null, '', 'short', 'has space 123', 'x'.repeat(65)]) expect(() => Pay.parseTxnId(bad)).toThrow(Pay.PaymentError);
  });
});

describe('allocation order and advance', () => {
  it('opening balance, then confirmed carried-over balances, then the oldest invoices; the rest is advance', async () => {
    const { db } = await fresh();
    // customer 1 (seeded in the original app): owes 2450 on INV-1001. Give it a confirmed carried-over item of 100 (direct insert, test only).
    db.run(`INSERT INTO customer_carried_over_balances (tenant_id, customer_id, amount, stored_balance, explained_balance, difference, discrepancy_key, reason, confirmed_by_user_id, confirmed_at, client_txn_id)
            VALUES (1, 1, 100, 2550, 2450, 100, 'test-key', 'test', 1, '2020-01-01 00:00:00', ?)`, [crypto.randomUUID()]);
    expect(Pay.outstandingItems(db, 1).map((i) => [i.target, i.due])).toEqual([['CARRIED_OVER_BALANCE', 100], ['SALE', 2450]]);
    const res = tx(db, () => {
      const pid = Pay.insertPayment(db, { tenantId: 1, customerId: 1, kind: 'CUSTOMER_PAYMENT', method: 'CASH', detail: null, amount: 3000, clientTxnId: crypto.randomUUID(), actor, source: 'CUSTOMER_SCREEN' });
      return Pay.allocateFifo(db, pid, 1, 'CUSTOMER_SCREEN', actor);
    });
    expect(res.allocations.map((a) => [a.target, a.amount])).toEqual([['CARRIED_OVER_BALANCE', 100], ['SALE', 2450]]);
    expect(res.advance).toBe(450);
    expect(Pay.advancePayments(db, 1).reduce((s, p) => s + p.free, 0)).toBe(450);
    db.close();
  });

  it('P3: the advance settles a new credit invoice, oldest advance first, never more than the invoice owes', async () => {
    const { db } = await fresh();
    const a = 'Fixture Advance';
    const cid = db.get<any>('SELECT id FROM customers WHERE name = ?', [a]).id; // advance 100 from the history
    const sid = Number(db.run(`INSERT INTO sales_headers (invoice_number, customer_id, total_amount, net_amount, grand_total, payment_method, amount_paid, amount_due, payment_status, created_by_user_id, tenant_id)
      VALUES ('INV-T-9', ?, 60, 60, 60, 'UDHAR', 0, 60, 'UNPAID', 1, 1)`, [cid]).lastInsertRowid);
    const applied = tx(db, () => Pay.applyAdvanceToSale(db, cid, sid, actor));
    expect(applied.map((x) => x.amount)).toEqual([60]);
    expect(db.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = ?', [sid])).toEqual({ balance_due: 0, settlement_status: 'PAID' });
    expect(Pay.advancePayments(db, cid).reduce((s, p) => s + p.free, 0)).toBe(40);
    expect(tx(db, () => Pay.applyAdvanceToSale(db, cid, sid, actor))).toEqual([]); // nothing owed any more
    db.close();
  });
});

describe('reversal', () => {
  it('releases everything the payment applied, records the OUT reversal once, raises the balance; a second reversal is refused (service and database)', async () => {
    const { db } = await fresh();
    const pid = db.get<any>("SELECT id FROM payments WHERE legacy_ledger_id = 5").id; // Fixture Advance's Rs. 1000 (opening 300, two invoices)
    const cid = db.get<any>("SELECT customer_id c FROM payments WHERE id = ?", [pid]).c;
    const before = db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [cid]).b;
    const r = tx(db, () => Pay.reversePayment(db, { paymentId: pid, reason: 'test reversal', clientTxnId: crypto.randomUUID(), actor, audit, affectsCustomerBalance: true, source: 'SALES_REGISTER' }));
    expect(r.released.map((a) => [a.target, a.amount])).toEqual([['OPENING_BALANCE', -300], ['SALE', -220], ['SALE', -380]]);
    expect(db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [cid]).b).toBe(before + 1000);
    expect(db.all<any>("SELECT invoice_number, balance_due FROM sales_headers WHERE customer_id = ? ORDER BY id", [cid])).toEqual([{ invoice_number: 'INV-1-1002', balance_due: 220 }, { invoice_number: 'INV-1-1003', balance_due: 380 }]);
    expect(() => tx(db, () => Pay.reversePayment(db, { paymentId: pid, reason: 'again', clientTxnId: crypto.randomUUID(), actor, audit, affectsCustomerBalance: true, source: 'SALES_REGISTER' }))).toThrow(/already been reversed/);
    // the database refuses a second reversal even if the service check were bypassed
    expect(() => db.run(`INSERT INTO payments (customer_id, direction, kind, method, amount, reverses_payment_id, reason, client_txn_id, received_at, source) VALUES (?, 'OUT', 'REVERSAL', 'BANK_TRANSFER', 1000, ?, 'x', ?, '2026-01-01 00:00:00', 'SYSTEM')`, [cid, pid, crypto.randomUUID()])).toThrow(/UNIQUE/);
    expect(audits.some((a) => a.startsWith('PAYMENT_REVERSED') && a.includes('Reason: test reversal'))).toBe(true);
    db.close();
  });
});

describe('protections verified before Batch 2b (requested checks)', () => {
  it('0008 preserved all original payment and invoice history (re-checked after 0009 on every legacy database)', async () => {
    for (const name of ['busy-store', 'multi-tenant', 'payments-edge-cases', 'inventory-edge-cases']) {
      const original = DbAdapter.open(path.join(FIXTURE_DIR, `${name}.sqlite`), { readonly: true });
      const sales = original.all('SELECT id, grand_total, amount_paid, amount_due, payment_status, payment_method FROM sales_headers ORDER BY id');
      const ledger = original.all("SELECT id, type, debit, credit, balance_after FROM customer_ledger ORDER BY id");
      const balances = original.all('SELECT id, current_balance FROM customers ORDER BY id');
      original.close();
      const { db } = await fresh(name);
      expect(db.all('SELECT id, grand_total, amount_paid, amount_due, payment_status, payment_method FROM sales_headers WHERE is_placeholder = 0 ORDER BY id'), name).toEqual(sales);
      expect(db.all('SELECT id, type, debit, credit, balance_after FROM customer_ledger ORDER BY id'), name).toEqual(ledger);
      expect(db.all('SELECT id, current_balance FROM customers WHERE is_placeholder = 0 ORDER BY id'), name).toEqual(balances);
      db.close();
    }
  });

  it('the only allowed change to a payment or allocation is clearing the invoice link (interim void); nothing else, not together with it', async () => {
    const { db } = await fresh();
    const p = db.get<any>("SELECT id FROM payments WHERE sale_id IS NOT NULL LIMIT 1").id;
    expect(() => db.run('UPDATE payments SET sale_id = NULL, amount = amount + 1 WHERE id = ?', [p])).toThrow(/PAYMENT_GUARD/);
    expect(() => db.run("UPDATE payments SET sale_id = NULL, invoice_number = 'X' WHERE id = ?", [p])).toThrow(/PAYMENT_GUARD/);
    expect(() => db.run('UPDATE payments SET sale_id = sale_id + 1 WHERE id = ?', [p])).toThrow(/PAYMENT_GUARD/);
    const before = db.get<any>('SELECT amount, method, invoice_number, received_at, customer_id FROM payments WHERE id = ?', [p]);
    db.run('UPDATE payments SET sale_id = NULL WHERE id = ?', [p]); // what ON DELETE SET NULL does
    expect(db.get<any>('SELECT amount, method, invoice_number, received_at, customer_id FROM payments WHERE id = ?', [p])).toEqual(before);
    const a = db.get<any>("SELECT id FROM payment_allocations WHERE sale_id IS NOT NULL LIMIT 1").id;
    expect(() => db.run('UPDATE payment_allocations SET sale_id = NULL, amount = 1 WHERE id = ?', [a])).toThrow(/PAYMENT_GUARD/);
    db.close();
  });

  it('confirmed carried-over balances are append-only and unique per discrepancy; 0009 kept every allocation row', async () => {
    const { db, file } = await fresh();
    const ins = (key: string, txn: string) => db.run(`INSERT INTO customer_carried_over_balances (tenant_id, customer_id, amount, stored_balance, explained_balance, difference, discrepancy_key, reason, confirmed_by_user_id, confirmed_at, client_txn_id)
      VALUES (1, 2, 1200, 1150, -50, 1200, ?, 'r', 1, '2026-01-01 00:00:00', ?)`, [key, txn]);
    ins('k1', 't-0000001');
    expect(() => ins('k1', 't-0000002')).toThrow(/UNIQUE/);
    expect(() => ins('k2', 't-0000001')).toThrow(/UNIQUE/);
    expect(() => db.run('DELETE FROM customer_carried_over_balances')).toThrow(/PAYMENT_GUARD/);
    expect(() => db.run('UPDATE customer_carried_over_balances SET amount = 1')).toThrow(/PAYMENT_GUARD/);
    expect(() => db.run(`INSERT INTO customer_carried_over_balances (tenant_id, customer_id, amount, stored_balance, explained_balance, difference, discrepancy_key, reason, confirmed_by_user_id, confirmed_at, client_txn_id)
      VALUES (1, 2, 50, 1150, -50, 1200, 'k3', 'r', 1, '2026-01-01', 't-0000003')`)).toThrow(/CHECK/); // amount must equal the difference
    db.close();
    // 0009 rebuild: allocations identical to what 0008 produced
    const v8 = await fresh();
    v8.db.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps8-'));
    const f8 = path.join(dir, 'p.sqlite');
    fs.copyFileSync(path.join(FIXTURE_DIR, 'payments-edge-cases.sqlite'), f8);
    const d8 = DbAdapter.open(f8);
    await migrate(d8, MIGRATIONS.filter((m) => m.version <= 8), { backupDir: path.join(dir, 'b') });
    const allocs8 = d8.all('SELECT id, payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source, created_at FROM payment_allocations ORDER BY id');
    await migrate(d8, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    expect(d8.all('SELECT id, payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source, created_at FROM payment_allocations ORDER BY id')).toEqual(allocs8);
    expect(reconcilePayments(d8).mismatches.map((m) => m.customerId)).toEqual([2, 5]);
    d8.close();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('0009 catch-up: a sale and a ledger payment recorded by a Batch 2a build get payment records once; nothing else changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const f = path.join(dir, 'p.sqlite');
    fs.copyFileSync(path.join(FIXTURE_DIR, 'payments-edge-cases.sqlite'), f);
    const d = DbAdapter.open(f);
    await migrate(d, MIGRATIONS.filter((m) => m.version <= 8), { backupDir: path.join(dir, 'b') });
    // what a 2a build wrote: a PARTIAL sale with Rs. 50 paid (no payment record) and a ledger payment of 30
    d.run(`INSERT INTO sales_headers (invoice_number, customer_id, total_amount, net_amount, grand_total, payment_method, amount_paid, amount_due, payment_status, created_by_user_id, tenant_id)
      VALUES ('INV-2A-1', 3, 175, 175, 175, 'PARTIAL', 50, 125, 'PARTIAL', 1, 1)`);
    d.run("UPDATE customers SET current_balance = current_balance + 125 WHERE id = 3");
    d.run("INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after) VALUES (3, 'PAYMENT', 'Payment Received (Cash)', 0, 30, 95)");
    d.run("UPDATE customers SET current_balance = current_balance - 30 WHERE id = 3");
    expect(reconcilePayments(d).untrackedSales).toBe(1);
    await migrate(d, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    expect(d.all<any>("SELECT kind, amount FROM payments WHERE customer_id = 3 AND (legacy_sale_id = (SELECT id FROM sales_headers WHERE invoice_number = 'INV-2A-1') OR legacy_ledger_id = (SELECT MAX(id) FROM customer_ledger)) ORDER BY id"))
      .toEqual([{ kind: 'CARRIED_OVER_SALE', amount: 50 }, { kind: 'CARRIED_OVER_CUSTOMER', amount: 30 }]);
    expect(d.get<any>("SELECT balance_due FROM sales_headers WHERE invoice_number = 'INV-2A-1'").balance_due).toBe(95);
    const rep = reconcilePayments(d);
    expect(rep.untrackedSales).toBe(0);
    expect(rep.mismatches.map((m) => m.customerId)).toEqual([2, 5]); // customer 3 agrees
    expect(d.all<any>("SELECT issue FROM payment_migration_issues WHERE issue LIKE 'CAUGHT_UP%' ORDER BY id").map((r) => r.issue)).toEqual(['CAUGHT_UP_SALE_PAYMENT', 'CAUGHT_UP_CUSTOMER_PAYMENT']);
    d.close();
  });
});
