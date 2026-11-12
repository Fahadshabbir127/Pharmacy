/**
 * Migration 0008 (payments) on copies of databases made by the ORIGINAL application (Phase 7, Batch 2a).
 * Decisions P1-P8 and conditions 1-10: history carried over, nothing historical changed, discrepancies reported
 * (never corrected), append-only protection, rollback and crash recovery, verified backup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureFixtures } from '../legacy/generate-fixtures';
import { PROJECT_ROOT, startServer } from '../helpers/server';
import { DbAdapter } from '../../server/db/adapter';
import { openDatabase } from '../../server/db/open';
import { migrate, currentVersion, Migration } from '../../server/db/migrate';
import { MIGRATIONS } from '../../server/db/migrations';
import { payments as paymentsMigration, PAYMENT_GUARD } from '../../server/db/migrations/0008_payments';
import { reconcilePayments, customerPosition } from '../../server/payments/reconcile';

const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const ALL = ['fresh-first-boot', 'after-restart', 'busy-store', 'multi-tenant', 'orphans', 'pre-tenant-raw', 'pre-tenant-migrated-by-original', 'inventory-edge-cases', 'payments-edge-cases'];
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function copy(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const file = path.join(dir, 'data', 'pharmacy.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, `${name}.sqlite`), file);
  return { dir, file };
}
/** the financial history as the original app left it */
function legacyMoney(file: string) {
  const ro = DbAdapter.open(file, { readonly: true });
  try {
    return {
      sales: ro.all('SELECT id, invoice_number, customer_id, sale_date, total_amount, discount_amount, net_amount, total_gst, grand_total, payment_method, amount_paid, amount_due, payment_status FROM sales_headers ORDER BY id'),
      customers: ro.all('SELECT id, opening_balance, current_balance FROM customers ORDER BY id'),
      ledger: ro.all('SELECT * FROM customer_ledger ORDER BY id'),
    };
  } finally { ro.close(); }
}
const money = (db: DbAdapter) => ({
  sales: db.all('SELECT id, invoice_number, customer_id, sale_date, total_amount, discount_amount, net_amount, total_gst, grand_total, payment_method, amount_paid, amount_due, payment_status FROM sales_headers WHERE is_placeholder = 0 ORDER BY id'),
  customers: db.all('SELECT id, opening_balance, current_balance FROM customers WHERE is_placeholder = 0 ORDER BY id'),
  ledger: db.all('SELECT * FROM customer_ledger ORDER BY id'),
});
const guard = (fn: () => unknown) => expect(fn).toThrow(new RegExp(PAYMENT_GUARD));

beforeAll(async () => { await ensureFixtures(FIXTURE_DIR); }, 600_000);

describe('0008 on every legacy database (copies; originals untouched)', () => {
  for (const name of ALL) {
    it(`${name}: history carried over once, nothing historical changed, balances derived from allocations, reconciliation agrees`, async () => {
      const original = path.join(FIXTURE_DIR, `${name}.sqlite`);
      const originalSha = sha(original);
      const before = legacyMoney(original);
      const { dir, file } = copy(name);
      const { db } = await openDatabase(file, { backupDir: path.join(dir, 'b') });
      try {
        expect(currentVersion(db)).toBe(8);
        // condition 4: every existing financial record and balance is exactly as before
        // (compared on the original columns: the oldest schema had no customer_ledger.sale_id, which 0001 adds empty)
        const now = money(db);
        const keys = (rows: any[]) => (rows[0] ? Object.keys(rows[0]) : []);
        const project = (rows: any[], k: string[]) => rows.map((r) => Object.fromEntries(k.map((c) => [c, r[c]])));
        expect({ sales: now.sales, customers: now.customers, ledger: project(now.ledger as any[], keys(before.ledger as any[])) }).toEqual(before);
        // E9: one carried-over payment per paid sale and per ledger payment, for exactly the recorded amount
        const paidSales = (before.sales as any[]).filter((s) => s.amount_paid > 0);
        const carriedSales = db.all<any>("SELECT legacy_sale_id, amount, method, source, client_txn_id FROM payments WHERE kind = 'CARRIED_OVER_SALE' ORDER BY legacy_sale_id");
        expect(carriedSales.map((p) => [p.legacy_sale_id, p.amount])).toEqual(paidSales.map((s) => [s.id, s.amount_paid]));
        expect(carriedSales.every((p) => p.method === 'CASH' && p.source === 'MIGRATION' && p.client_txn_id === null)).toBe(true);
        const custIds = new Set((before.customers as any[]).map((c) => c.id));
        const ledgerPays = (before.ledger as any[]).filter((l) => l.type === 'PAYMENT' && l.credit > 0 && custIds.has(l.customer_id));
        const carriedCust = db.all<any>("SELECT legacy_ledger_id, amount, customer_id FROM payments WHERE kind = 'CARRIED_OVER_CUSTOMER' ORDER BY legacy_ledger_id");
        expect(carriedCust.map((p) => [p.legacy_ledger_id, p.customer_id, p.amount])).toEqual(ledgerPays.map((l) => [l.id, l.customer_id, l.credit]));
        // P1: every invoice's balance and status follow its allocations; never negative; never more than paid
        for (const s of db.all<any>('SELECT id, grand_total, balance_due, settlement_status FROM sales_headers')) {
          const applied = db.get<any>("SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) a FROM payment_allocations WHERE sale_id = ?", [s.id]).a;
          expect(s.balance_due, `sale ${s.id}`).toBeCloseTo(s.grand_total - applied, 2);
          expect(s.balance_due).toBeGreaterThanOrEqual(0);
          expect(s.settlement_status).toBe(s.balance_due <= 0.004 ? 'PAID' : applied <= 0.004 ? 'UNPAID' : 'PARTIAL');
        }
        // no payment is allocated beyond its amount
        expect(db.all("SELECT p.id FROM payments p WHERE (SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a WHERE a.payment_id = p.id) > p.amount + 0.005")).toEqual([]);
        // condition 5: the startup reconciliation reports exactly the mismatches the migration recorded
        const rep = reconcilePayments(db);
        const recorded = db.all<any>("SELECT customer_id, stored_value, expected_value FROM payment_migration_issues WHERE issue = 'BALANCE_MISMATCH' ORDER BY customer_id");
        expect(rep.mismatches.map((m) => [m.customerId, m.stored, m.expected])).toEqual(recorded.map((r) => [r.customer_id, r.stored_value, r.expected_value]));
        expect(rep.untrackedSales).toBe(0);
        expect(db.foreignKeyViolations()).toEqual([]);
        expect(db.integrityCheck()).toEqual([]);
      } finally {
        db.close();
      }
      expect(sha(original)).toBe(originalSha);
    });
  }
});

describe('payments-edge-cases: exact outcome of each scenario the original app allowed', () => {
  let db: DbAdapter;
  beforeAll(async () => {
    const { dir, file } = copy('payments-edge-cases');
    db = (await openDatabase(file, { backupDir: path.join(dir, 'b') })).db;
  });
  const cust = (name: string) => db.get<any>('SELECT id FROM customers WHERE name = ?', [name]).id as number;
  const allocs = (customerId: number) => db.all<any>(`SELECT p.legacy_ledger_id AS ledger, p.legacy_sale_id AS sale_pay, a.target, a.invoice_number AS inv, a.amount
      FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.customer_id = ? ORDER BY a.id`, [customerId]);

  it('A: opening balance paid first, then the oldest invoice; the overpayment became an advance that settled the next credit invoice (P2, P3)', () => {
    const a = cust('Fixture Advance');
    expect(allocs(a).map((x) => [x.ledger, x.target, x.inv, x.amount])).toEqual([
      [4, 'OPENING_BALANCE', null, 200], // Rs. 200 cash -> opening balance
      [5, 'OPENING_BALANCE', null, 300], // Rs. 1000 bank transfer -> rest of the opening balance,
      [5, 'SALE', 'INV-1-1002', 220], //    the oldest invoice,
      [5, 'SALE', 'INV-1-1003', 380], //    and (as advance) the next credit invoice
    ]);
    expect(db.all<any>("SELECT invoice_number, balance_due, settlement_status, amount_due, payment_status FROM sales_headers WHERE customer_id = ? ORDER BY id", [a])).toEqual([
      { invoice_number: 'INV-1-1002', balance_due: 0, settlement_status: 'PAID', amount_due: 220, payment_status: 'UNPAID' }, // at-sale snapshot kept
      { invoice_number: 'INV-1-1003', balance_due: 0, settlement_status: 'PAID', amount_due: 380, payment_status: 'UNPAID' },
    ]);
    expect(customerPosition(db, a)).toMatchObject({ openingDue: 0, invoicesDue: 0, advance: 100, expected: -100 });
    expect(db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [a]).b).toBe(-100); // agrees: no issue
    expect(db.get<any>("SELECT method FROM payments WHERE legacy_ledger_id = 5").method).toBe('BANK_TRANSFER');
  });

  it('B: a part-paid invoice deleted by the original void: payment kept as an advance; the clamped stored balance is reported, not corrected', () => {
    const b = cust('Fixture Voided');
    expect(db.get<any>('SELECT method, method_detail, amount FROM payments WHERE legacy_ledger_id = 8')).toEqual({ method: 'MOBILE_WALLET', method_detail: 'EasyPaisa', amount: 300 });
    expect(allocs(b)).toEqual([]);
    expect(db.get<any>("SELECT stored_value, expected_value, difference FROM payment_migration_issues WHERE issue = 'BALANCE_MISMATCH' AND customer_id = ?", [b])).toEqual({ stored_value: 0, expected_value: -300, difference: 300 });
    expect(db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [b]).b).toBe(0);
  });

  it('C: the demo customer\'s unexplained balance and an unknown payment mode are reported', () => {
    expect(db.get<any>('SELECT method, method_detail FROM payments WHERE legacy_ledger_id = 10')).toEqual({ method: 'UNSPECIFIED', method_detail: 'Cheque' });
    expect(db.get<any>("SELECT COUNT(*) n FROM payment_migration_issues WHERE issue = 'UNMAPPED_PAYMENT_METHOD' AND ledger_id = 10").n).toBe(1);
    expect(db.get<any>("SELECT stored_value, expected_value, difference FROM payment_migration_issues WHERE issue = 'BALANCE_MISMATCH' AND customer_id = 2")).toEqual({ stored_value: 1150, expected_value: -50, difference: 1200 });
    expect(db.get<any>("SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'PAYMENT_MIGRATION_ISSUE' AND target_id = 2").n).toBe(1);
  });

  it('D-F: negative opening balance, walk-in over- and under-payment, part payment settled later', () => {
    expect(db.get<any>("SELECT COUNT(*) n FROM payment_migration_issues WHERE issue = 'NEGATIVE_OPENING_BALANCE' AND customer_id = ?", [cust('Fixture Negative')]).n).toBe(1);
    expect(customerPosition(db, cust('Fixture Negative')).expected).toBe(-50);
    const walkIn = db.all<any>("SELECT invoice_number, grand_total, amount_paid, balance_due, settlement_status FROM sales_headers WHERE customer_id IS NULL ORDER BY id");
    expect(walkIn).toEqual([
      { invoice_number: 'INV-1-1004', grand_total: 220, amount_paid: 1000, balance_due: 0, settlement_status: 'PAID' },
      { invoice_number: 'INV-1-1005', grand_total: 220, amount_paid: 100, balance_due: 120, settlement_status: 'PARTIAL' },
    ]);
    expect(db.all<any>("SELECT issue FROM payment_migration_issues WHERE customer_id IS NULL ORDER BY id").map((r) => r.issue)).toEqual(['OVERPAID_AT_SALE', 'WALKIN_SALE_WITH_DUE']);
    expect(db.get<any>("SELECT balance_due, settlement_status FROM sales_headers WHERE invoice_number = 'INV-1-1006'")).toEqual({ balance_due: 0, settlement_status: 'PAID' });
    expect(db.get<any>("SELECT balance_due, settlement_status FROM sales_headers WHERE invoice_number = 'INV-1001'")).toEqual({ balance_due: 2450, settlement_status: 'PARTIAL' });
    // complete issue list and audit summary
    expect(db.all<any>('SELECT issue FROM payment_migration_issues ORDER BY issue').map((r) => r.issue)).toEqual(['BALANCE_MISMATCH', 'BALANCE_MISMATCH', 'NEGATIVE_OPENING_BALANCE', 'OVERPAID_AT_SALE', 'UNMAPPED_PAYMENT_METHOD', 'WALKIN_SALE_WITH_DUE']);
    expect(db.get<any>("SELECT description FROM audit_logs WHERE action_type = 'PAYMENT_MIGRATION'").description).toMatch(/4 at-sale payment\(s\), 5 customer payment\(s\), .*6 item\(s\) reported.*No existing amount or balance was changed/);
  });
});

describe('append-only protection and database-level guards (conditions 1, 3, 6)', () => {
  let db: DbAdapter;
  const fresh = async () => {
    const { dir, file } = copy('payments-edge-cases');
    return (await openDatabase(file, { backupDir: path.join(dir, 'b') })).db;
  };
  beforeAll(async () => { db = await fresh(); });
  const now = '2026-06-01 10:00:00';
  const newPayment = (extra: Record<string, unknown> = {}) => {
    const v = { customer_id: 1, kind: 'CUSTOMER_PAYMENT', method: 'CASH', amount: 100, client_txn_id: crypto.randomUUID(), source: 'CUSTOMER_SCREEN', ...extra };
    return Number(db.run(`INSERT INTO payments (customer_id, direction, kind, method, amount, client_txn_id, received_at, source, reverses_payment_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [v.customer_id, v.kind === 'REVERSAL' ? 'OUT' : 'IN', v.kind, v.method, v.amount, v.client_txn_id, now, v.source, (v as any).reverses_payment_id ?? null, (v as any).reason ?? null]).lastInsertRowid);
  };

  it('payments and allocations can never be deleted or edited; at-sale figures cannot be changed', () => {
    guard(() => db.run('DELETE FROM payments WHERE id = 1'));
    guard(() => db.run('UPDATE payments SET amount = amount + 1 WHERE id = 1'));
    guard(() => db.run("UPDATE payments SET method = 'CARD' WHERE id = 1"));
    guard(() => db.run('UPDATE payments SET sale_id = 2 WHERE id = 1'));
    guard(() => db.run('DELETE FROM payment_allocations WHERE id = 1'));
    guard(() => db.run('UPDATE payment_allocations SET amount = 1 WHERE id = 1'));
    for (const col of ['amount_paid', 'amount_due', 'grand_total']) guard(() => db.run(`UPDATE sales_headers SET ${col} = ${col} + 1 WHERE id = 1`));
    guard(() => db.run("UPDATE sales_headers SET payment_status = 'PAID' WHERE id = 1"));
    guard(() => db.run('UPDATE sales_headers SET balance_due = 0 WHERE id = 1')); // derived, never set directly
    guard(() => db.run("UPDATE sales_headers SET settlement_status = 'PAID' WHERE id = 1"));
  });

  it('every new payment needs a transaction id (only carried-over history has none); ids are unique', () => {
    expect(() => newPayment({ client_txn_id: null })).toThrow(/CHECK constraint failed/);
    expect(() => newPayment({ client_txn_id: null, source: 'MIGRATION' })).toThrow(/CHECK constraint failed/); // not a carried-over kind
    const id = crypto.randomUUID();
    newPayment({ client_txn_id: id });
    expect(() => newPayment({ client_txn_id: id })).toThrow(/UNIQUE constraint failed: payments.client_txn_id/);
    expect(() => newPayment({ amount: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => newPayment({ amount: -5 })).toThrow(/CHECK constraint failed/);
    expect(() => newPayment({ method: 'CHEQUE' })).toThrow(/CHECK constraint failed/);
  });

  it('allocations cannot exceed the payment, the invoice or the opening balance (no overpayment)', () => {
    const pid = newPayment({ amount: 3000 });
    const apply = (target: string, saleId: number | null, inv: string | null, amount: number, customer = 1) =>
      db.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source) VALUES (?, ?, ?, ?, ?, 'APPLY', ?, 'CUSTOMER_SCREEN')", [pid, customer, target, saleId, inv, amount]);
    guard(() => apply('SALE', 1, 'INV-1001', 2450.01)); // INV-1001 still owes 2450
    guard(() => apply('OPENING_BALANCE', null, null, 1)); // customer 1 has no opening balance
    guard(() => apply('SALE', 2, 'INV-1-1002', 10, 1)); // invoice of another customer
    apply('SALE', 1, 'INV-1001', 2450);
    expect(db.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = 1')).toEqual({ balance_due: 0, settlement_status: 'PAID' });
    guard(() => apply('SALE', 1, 'INV-1001', 0.01)); // already fully paid
    const p2 = newPayment({ amount: 10 });
    guard(() => db.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source) VALUES (?, 1, 'SALE', 7, 'INV-1-1006', 'APPLY', 10.01, 'CUSTOMER_SCREEN')", [p2])); // more than the payment (and the invoice)
  });

  it('a release undoes an allocation (with a reason) and the invoice balance follows; a reversal is OUT, full amount, once', async () => {
    const d = await fresh();
    const pid = Number(d.run(`INSERT INTO payments (customer_id, direction, kind, method, amount, client_txn_id, received_at, source) VALUES (1, 'IN', 'INVOICE_PAYMENT', 'CARD', 450, ?, ?, 'SALES_REGISTER')`, [crypto.randomUUID(), now]).lastInsertRowid);
    const aid = Number(d.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source) VALUES (?, 1, 'SALE', 1, 'INV-1001', 'APPLY', 450, 'SALES_REGISTER')", [pid]).lastInsertRowid);
    expect(d.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = 1')).toEqual({ balance_due: 2000, settlement_status: 'PARTIAL' });
    expect(() => d.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, releases_allocation_id, source) VALUES (?, 1, 'SALE', 1, 'INV-1001', 'RELEASE', 450, ?, 'SYSTEM')", [pid, aid])).toThrow(/CHECK constraint failed/); // reason required
    guard(() => d.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, releases_allocation_id, reason, source) VALUES (?, 1, 'SALE', 1, 'INV-1001', 'RELEASE', 451, ?, 'x', 'SYSTEM')", [pid, aid]));
    d.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, releases_allocation_id, reason, source) VALUES (?, 1, 'SALE', 1, 'INV-1001', 'RELEASE', 450, ?, 'card payment entered by mistake', 'SYSTEM')", [pid, aid]);
    expect(d.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = 1')).toEqual({ balance_due: 2450, settlement_status: 'PARTIAL' });
    const rev = (amount: number, reason: string | null) => d.run(`INSERT INTO payments (customer_id, direction, kind, method, amount, client_txn_id, received_at, source, reverses_payment_id, reason) VALUES (1, 'OUT', 'REVERSAL', 'CARD', ?, ?, ?, 'SALES_REGISTER', ?, ?)`, [amount, crypto.randomUUID(), now, pid, reason]);
    expect(() => rev(450, null)).toThrow(/CHECK constraint failed/); // reason mandatory
    guard(() => rev(400, 'partial reversal is not allowed'));
    rev(450, 'entered by mistake');
    expect(() => rev(450, 'again')).toThrow(/UNIQUE constraint failed/);
    // a reversed payment can no longer be allocated
    guard(() => d.run("INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source) VALUES (?, 1, 'SALE', 1, 'INV-1001', 'APPLY', 1, 'SYSTEM')", [pid]));
    expect(reconcilePayments(d).mismatches.map((m) => m.customerId)).toEqual([2, 5]); // the release and reversal changed nothing else
    d.close();
  });

  it('a new invoice starts with its full total due; the legacy hard void keeps payment history (invoice link cleared, number kept)', async () => {
    const d = await fresh();
    const ins = d.run(`INSERT INTO sales_headers (invoice_number, customer_id, total_amount, net_amount, grand_total, payment_method, amount_paid, amount_due, payment_status, created_by_user_id, tenant_id)
      VALUES ('INV-T-1', 3, 300, 300, 300, 'UDHAR', 0, 300, 'UNPAID', 1, 1)`);
    expect(d.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = ?', [ins.lastInsertRowid])).toEqual({ balance_due: 300, settlement_status: 'UNPAID' });
    // hard delete of INV-1-1006 (as DELETE /api/sales/:id still does until Batch 4)
    d.run('DELETE FROM sale_items WHERE sale_id = 7');
    d.run('DELETE FROM sales_headers WHERE id = 7');
    expect(d.all<any>("SELECT sale_id, invoice_number, amount FROM payments WHERE invoice_number = 'INV-1-1006'")).toEqual([{ sale_id: null, invoice_number: 'INV-1-1006', amount: 100 }]);
    expect(d.all<any>("SELECT sale_id, invoice_number, amount FROM payment_allocations WHERE invoice_number = 'INV-1-1006' ORDER BY id")).toEqual([
      { sale_id: null, invoice_number: 'INV-1-1006', amount: 100 }, { sale_id: null, invoice_number: 'INV-1-1006', amount: 75 },
    ]);
    d.close();
  });
});

describe('rollback, crash recovery and verified backup', () => {
  it('a failure at the end of 0008 rolls everything back; the real migration then succeeds', async () => {
    const { dir, file } = copy('payments-edge-cases');
    const db = DbAdapter.open(file);
    await migrate(db, MIGRATIONS.filter((m) => m.version < 8), { backupDir: path.join(dir, 'b') });
    const before = money(db);
    const triggersBefore = db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    const broken: Migration = { ...paymentsMigration, up: (d) => { paymentsMigration.up(d); throw new Error('injected failure after carrying over all payments'); } };
    await expect(migrate(db, [...MIGRATIONS.filter((m) => m.version < 8), broken], { backupDir: path.join(dir, 'b') })).rejects.toThrow(/injected failure/);
    expect(currentVersion(db)).toBe(7);
    expect(db.tableNames()).not.toContain('payments');
    expect(db.tableNames()).not.toContain('payment_allocations');
    expect(db.all<{ name: string }>('PRAGMA table_info(sales_headers)').map((c) => c.name)).not.toContain('balance_due');
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).toEqual(triggersBefore);
    expect(money(db)).toEqual(before);
    await migrate(db, MIGRATIONS, { backupDir: path.join(dir, 'b') });
    expect(currentVersion(db)).toBe(8);
    expect(money(db)).toEqual(before);
    db.close();
  });

  it('the server is killed inside the 0008 transaction; the next start migrates cleanly; a verified backup of v7 exists', async () => {
    // a v7 database (as Phase 6 / Batch 1 left it) is the realistic starting point
    const { dir, file } = copy('payments-edge-cases');
    const v7 = DbAdapter.open(file);
    await migrate(v7, MIGRATIONS.filter((m) => m.version < 8), { backupDir: path.join(dir, 'b0') });
    const before = money(v7);
    v7.close();
    const dataDir = path.join(dir, 'data');
    fs.renameSync(file, path.join(dataDir, 'khushi_pharmacy.sqlite'));
    await expect(startServer({ workDir: dir, env: { PHARMACY_TEST_CRASH_MIGRATION: '8' } })).rejects.toThrow(/exited early/);
    const mid = DbAdapter.open(path.join(dataDir, 'khushi_pharmacy.sqlite'), { readonly: true });
    expect(currentVersion(mid)).toBe(7);
    expect(mid.tableNames()).not.toContain('payments');
    expect(money(mid)).toEqual(before);
    mid.close();
    // the pre-migration backup was written and verified before 0008 started
    const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.startsWith('pre-migration-v7-to-v8') && f.endsWith('.sqlite'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const bk = DbAdapter.open(path.join(dataDir, 'backups', backups[0]), { readonly: true });
    expect(bk.integrityCheck()).toEqual([]);
    expect(currentVersion(bk)).toBe(7);
    expect(money(bk)).toEqual(before);
    bk.close();
    const srv = await startServer({ workDir: dir });
    try {
      const db = DbAdapter.open(srv.dbFile, { readonly: true });
      expect(currentVersion(db)).toBe(8);
      expect(money(db)).toEqual(before);
      expect(db.get<any>('SELECT COUNT(*) n FROM payments').n).toBe(9);
      db.close();
      // the startup check is logged (reported, not repaired)
      expect(srv.logs()).toMatch(/\[PAYMENTS\] 2 customer balance\(s\) differ/);
    } finally {
      await srv.stop();
    }
  }, 120_000);
});

describe('startup report on a running server', () => {
  it('a new installation with demo data reconciles cleanly; a sale made before Batch 2b records payments is reported as untracked', async () => {
    const srv = await startServer();
    let workDir = srv.workDir;
    try {
      expect(srv.logs()).not.toMatch(/\[PAYMENTS\]/);
      const db = DbAdapter.open(srv.dbFile, { readonly: true });
      expect(reconcilePayments(db)).toMatchObject({ mismatches: [], untrackedSales: 0, walkInSalesWithDue: 0, migrationIssues: 0 });
      expect(db.get<any>('SELECT balance_due, settlement_status FROM sales_headers WHERE id = 1')).toEqual({ balance_due: 2450, settlement_status: 'PARTIAL' });
      db.close();
      // Batch 2a gap (closed in 2b): the current sale route does not write payment records yet
      const { Api, cartItem, salePayload } = await import('../helpers/server');
      const admin = new Api();
      await admin.login('admin', 'admin123');
      const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
      expect((await admin.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(200);
    } finally {
      await srv.stop();
    }
    const again = await startServer({ workDir });
    try {
      expect(again.logs()).toMatch(/\[PAYMENTS\] 1 invoice\(s\) have money recorded at the sale but no payment record/);
    } finally {
      await again.stop();
    }
  });
});
