/**
 * 0009: administrator-confirmed carried-over balances (Q1) and payment allocation to them; catch-up of
 * payments recorded by a Batch 2a build (Phase 7, Batch 2b).
 *
 *  - customer_carried_over_balances: a positive balance difference that an ADMIN confirmed (reason required)
 *    becomes a debt item that customer payments settle right after the opening balance. Append-only; one
 *    confirmation per discrepancy (discrepancy_key UNIQUE) and per transaction id.
 *  - payment_allocations is rebuilt (SQLite cannot change a CHECK in place) to allow the target
 *    CARRIED_OVER_BALANCE; every existing row is copied unchanged, and all 0008 guard triggers are recreated
 *    with the new target included.
 *  - customer_ledger.payment_id links new ledger rows to their payment record.
 *  - Catch-up: invoices or ledger payments written by a 2a build (no payment record) are carried over exactly
 *    as 0008 did, and reported in payment_migration_issues. On a database that never ran a 2a build this
 *    finds nothing.
 * No existing amount or balance is changed. This file is frozen once released.
 */
import type { Migration } from '../migrate';
import type { DbAdapter } from '../adapter';

const PG = 'PAYMENT_GUARD';
const TOL = 0.005;
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const ts = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 19) : '0000-00-00 00:00:00');

const appliedToSale = (s: string) =>
  `(SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a WHERE a.target = 'SALE' AND a.sale_id = ${s})`;
const balanceExpr = (s: string, total: string) => `ROUND(${total} - ${appliedToSale(s)}, 2)`;
const statusExpr = (s: string, total: string) =>
  `CASE WHEN ${balanceExpr(s, total)} <= ${TOL} THEN 'PAID' WHEN ${appliedToSale(s)} <= ${TOL} THEN 'UNPAID' ELSE 'PARTIAL' END`;
const netAlloc = (where: string) => `(SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a WHERE ${where})`;

function mapLegacyMode(reference: string | null): { method: string; detail: string | null } {
  const m = /\(([^)]*)\)\s*$/.exec(reference || '');
  const mode = (m ? m[1] : '').trim();
  const k = mode.toLowerCase();
  if (k === 'cash') return { method: 'CASH', detail: null };
  if (k === 'card') return { method: 'CARD', detail: null };
  if (k === 'easypaisa') return { method: 'MOBILE_WALLET', detail: 'EasyPaisa' };
  if (k === 'jazzcash') return { method: 'MOBILE_WALLET', detail: 'JazzCash' };
  if (k === 'bank transfer') return { method: 'BANK_TRANSFER', detail: null };
  return { method: 'UNSPECIFIED', detail: mode || null };
}

function schema(db: DbAdapter) {
  // 0008 triggers that read payment_allocations are dropped and recreated below (the table is rebuilt)
  for (const t of ['trg_alloc_no_delete', 'trg_alloc_no_update', 'trg_alloc_apply_guard', 'trg_alloc_release_guard', 'trg_alloc_sync_sale', 'trg_sales_balance_guard', 'trg_sales_balance_init']) {
    db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  }
  db.exec(`
    CREATE TABLE customer_carried_over_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount REAL NOT NULL CHECK (amount > 0),
      stored_balance REAL NOT NULL,
      explained_balance REAL NOT NULL,
      difference REAL NOT NULL,
      discrepancy_key TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK (trim(reason) <> ''),
      confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
      confirmed_at TEXT NOT NULL,
      client_txn_id TEXT NOT NULL UNIQUE,
      migration_issue_id INTEGER REFERENCES payment_migration_issues(id),
      CHECK (ABS(difference - amount) < ${TOL}),
      CHECK (ABS((stored_balance - explained_balance) - difference) < ${TOL})
    );
    CREATE INDEX ix_cob_customer ON customer_carried_over_balances(customer_id);

    CREATE TABLE payment_allocations_v9 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      customer_id INTEGER REFERENCES customers(id),
      target TEXT NOT NULL CHECK (target IN ('SALE', 'OPENING_BALANCE', 'CARRIED_OVER_BALANCE')),
      sale_id INTEGER REFERENCES sales_headers(id) ON DELETE SET NULL,
      invoice_number TEXT,
      carried_over_id INTEGER REFERENCES customer_carried_over_balances(id),
      kind TEXT NOT NULL CHECK (kind IN ('APPLY', 'RELEASE')),
      amount REAL NOT NULL CHECK (amount > 0),
      releases_allocation_id INTEGER REFERENCES payment_allocations(id),
      reason TEXT,
      source TEXT NOT NULL CHECK (source IN ('POS', 'CUSTOMER_SCREEN', 'SALES_REGISTER', 'MIGRATION', 'SYSTEM', 'ADVANCE')),
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((kind = 'RELEASE') = (releases_allocation_id IS NOT NULL)),
      CHECK (kind = 'APPLY' OR (reason IS NOT NULL AND trim(reason) <> '')),
      CHECK ((target = 'SALE' AND invoice_number IS NOT NULL AND carried_over_id IS NULL)
          OR (target = 'OPENING_BALANCE' AND sale_id IS NULL AND carried_over_id IS NULL AND customer_id IS NOT NULL)
          OR (target = 'CARRIED_OVER_BALANCE' AND sale_id IS NULL AND carried_over_id IS NOT NULL AND customer_id IS NOT NULL))
    );
    INSERT INTO payment_allocations_v9 (id, payment_id, customer_id, target, sale_id, invoice_number, carried_over_id, kind, amount, releases_allocation_id, reason, source, created_by_user_id, created_at)
      SELECT id, payment_id, customer_id, target, sale_id, invoice_number, NULL, kind, amount, releases_allocation_id, reason, source, created_by_user_id, created_at FROM payment_allocations;
    DROP TABLE payment_allocations;
    ALTER TABLE payment_allocations_v9 RENAME TO payment_allocations;
    CREATE INDEX ix_alloc_payment ON payment_allocations(payment_id);
    CREATE INDEX ix_alloc_sale ON payment_allocations(sale_id);
    CREATE INDEX ix_alloc_customer ON payment_allocations(customer_id, target);
    CREATE INDEX ix_alloc_carried ON payment_allocations(carried_over_id);

    ALTER TABLE customer_ledger ADD COLUMN payment_id INTEGER REFERENCES payments(id);
  `);
}

function triggers(db: DbAdapter) {
  const G = (msg: string) => `SELECT RAISE(ABORT, '${PG}: ${msg}')`;
  const allocCols = ['id', 'payment_id', 'customer_id', 'target', 'invoice_number', 'carried_over_id', 'kind', 'amount', 'releases_allocation_id', 'reason', 'source', 'created_by_user_id', 'created_at'];
  const cobCols = ['id', 'tenant_id', 'customer_id', 'amount', 'stored_balance', 'explained_balance', 'difference', 'discrepancy_key', 'reason', 'confirmed_by_user_id', 'confirmed_at', 'client_txn_id', 'migration_issue_id'];
  const changed = (cols: string[]) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ');
  db.exec(`
    CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON payment_allocations BEGIN ${G('allocations are never deleted; record a release')}; END;
    CREATE TRIGGER trg_alloc_no_update BEFORE UPDATE ON payment_allocations
    WHEN ${changed(allocCols)} OR (NEW.sale_id IS NOT OLD.sale_id AND NEW.sale_id IS NOT NULL)
    BEGIN ${G('allocations are never edited; record a release')}; END;
    CREATE TRIGGER trg_cob_no_delete BEFORE DELETE ON customer_carried_over_balances BEGIN ${G('confirmed carried-over balances are never deleted')}; END;
    CREATE TRIGGER trg_cob_no_update BEFORE UPDATE ON customer_carried_over_balances WHEN ${changed(cobCols)}
    BEGIN ${G('confirmed carried-over balances are never edited')}; END;

    CREATE TRIGGER trg_alloc_apply_guard BEFORE INSERT ON payment_allocations WHEN NEW.kind = 'APPLY'
    BEGIN
      SELECT RAISE(ABORT, '${PG}: allocation must use an IN payment that is not reversed, for the same customer')
      WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.direction = 'IN' AND p.customer_id IS NEW.customer_id)
         OR EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = NEW.payment_id);
      SELECT RAISE(ABORT, '${PG}: allocation exceeds the unallocated amount of the payment')
      WHERE (SELECT p.amount FROM payments p WHERE p.id = NEW.payment_id) + ${TOL} < NEW.amount + ${netAlloc('a.payment_id = NEW.payment_id')};
      SELECT RAISE(ABORT, '${PG}: OVERPAYMENT - allocation exceeds the invoice balance')
      WHERE NEW.target = 'SALE' AND (NEW.sale_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM sales_headers s WHERE s.id = NEW.sale_id AND s.customer_id IS NEW.customer_id
                AND ${appliedToSale('NEW.sale_id')} + NEW.amount <= s.grand_total + ${TOL}));
      SELECT RAISE(ABORT, '${PG}: OVERPAYMENT - allocation exceeds the opening balance')
      WHERE NEW.target = 'OPENING_BALANCE' AND NOT EXISTS (
              SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND
                ${netAlloc("a.target = 'OPENING_BALANCE' AND a.customer_id = NEW.customer_id")} + NEW.amount <= MAX(c.opening_balance, 0) + ${TOL});
      SELECT RAISE(ABORT, '${PG}: OVERPAYMENT - allocation exceeds the carried-over balance')
      WHERE NEW.target = 'CARRIED_OVER_BALANCE' AND NOT EXISTS (
              SELECT 1 FROM customer_carried_over_balances b WHERE b.id = NEW.carried_over_id AND b.customer_id = NEW.customer_id AND
                ${netAlloc("a.target = 'CARRIED_OVER_BALANCE' AND a.carried_over_id = NEW.carried_over_id")} + NEW.amount <= b.amount + ${TOL});
    END;
    CREATE TRIGGER trg_alloc_release_guard BEFORE INSERT ON payment_allocations WHEN NEW.kind = 'RELEASE'
    BEGIN
      SELECT RAISE(ABORT, '${PG}: a release must undo part of an APPLY of the same payment and target, and not more than it applied')
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_allocations o WHERE o.id = NEW.releases_allocation_id AND o.kind = 'APPLY' AND o.payment_id = NEW.payment_id
          AND o.target = NEW.target AND o.sale_id IS NEW.sale_id AND o.customer_id IS NEW.customer_id AND o.carried_over_id IS NEW.carried_over_id
          AND (SELECT COALESCE(SUM(x.amount), 0) FROM payment_allocations x WHERE x.releases_allocation_id = o.id) + NEW.amount <= o.amount + ${TOL});
    END;

    CREATE TRIGGER trg_alloc_sync_sale AFTER INSERT ON payment_allocations WHEN NEW.target = 'SALE' AND NEW.sale_id IS NOT NULL
    BEGIN
      UPDATE sales_headers SET balance_due = ${balanceExpr('NEW.sale_id', 'sales_headers.grand_total')},
                               settlement_status = ${statusExpr('NEW.sale_id', 'sales_headers.grand_total')}
      WHERE id = NEW.sale_id;
    END;
    CREATE TRIGGER trg_sales_balance_guard BEFORE UPDATE OF balance_due, settlement_status ON sales_headers
    WHEN NEW.balance_due IS NOT ${balanceExpr('NEW.id', 'NEW.grand_total')} OR NEW.settlement_status IS NOT ${statusExpr('NEW.id', 'NEW.grand_total')}
    BEGIN ${G('balance_due and settlement_status are derived from payment allocations and cannot be set directly')}; END;
    CREATE TRIGGER trg_sales_balance_init AFTER INSERT ON sales_headers
    BEGIN
      UPDATE sales_headers SET balance_due = ${balanceExpr('NEW.id', 'NEW.grand_total')}, settlement_status = ${statusExpr('NEW.id', 'NEW.grand_total')} WHERE id = NEW.id;
    END;
  `);
}

/** Payments recorded by a Batch 2a build (which did not write payment records) are carried over as 0008 did. */
function catchUp(db: DbAdapter) {
  const issue = (customer: number | null, sale: number | null, ledger: number | null, kind: string, amount: number, detail: string) =>
    db.run('INSERT INTO payment_migration_issues (customer_id, sale_id, ledger_id, issue, stored_value, detail) VALUES (?, ?, ?, ?, ?, ?)', [customer, sale, ledger, kind, amount, detail]);
  const userOk = (id: unknown) => id !== null && id !== undefined && !!db.get('SELECT 1 AS x FROM users WHERE id = ?', [Number(id)]);
  const alloc = (pid: number, customer: number | null, target: string, saleId: number | null, inv: string | null, amount: number, at: string) =>
    db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source, created_at) VALUES (?, ?, ?, ?, ?, 'APPLY', ?, 'MIGRATION', ?)`,
      [pid, customer, target, saleId, inv, r2(amount), at]);

  const sales = db.all<any>(`SELECT * FROM sales_headers s WHERE s.amount_paid > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id OR p.legacy_sale_id = s.id) ORDER BY s.id`);
  for (const s of sales) {
    const paid = r2(Number(s.amount_paid));
    const pid = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, amount, legacy_sale_id, received_by_user_id, received_at, source, notes)
      VALUES (?, ?, ?, ?, 'IN', 'CARRIED_OVER_SALE', 'CASH', ?, ?, ?, ?, 'MIGRATION', 'Carried over (catch-up): amount paid at a sale made before payment recording was active')`,
      [s.tenant_id, s.customer_id, s.id, s.invoice_number, paid, s.id, userOk(s.created_by_user_id) ? s.created_by_user_id : null, ts(s.sale_date)]).lastInsertRowid);
    const x = r2(Math.min(paid, Number(s.balance_due ?? s.grand_total)));
    if (x > 0) alloc(pid, s.customer_id ?? null, 'SALE', s.id, s.invoice_number, x, ts(s.sale_date));
    issue(s.customer_id ?? null, s.id, null, 'CAUGHT_UP_SALE_PAYMENT', paid, `Invoice ${s.invoice_number}: Rs. ${paid} paid at the sale had no payment record; carried over.`);
  }

  const ledger = db.all<any>(`SELECT l.* FROM customer_ledger l WHERE l.type = 'PAYMENT' AND l.credit > 0
      AND EXISTS (SELECT 1 FROM customers c WHERE c.id = l.customer_id)
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.legacy_ledger_id = l.id) ORDER BY l.id`);
  for (const l of ledger) {
    const amount = r2(Number(l.credit));
    const mode = mapLegacyMode(l.reference);
    const c = db.get<any>('SELECT id, tenant_id, opening_balance FROM customers WHERE id = ?', [l.customer_id]);
    const pid = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, direction, kind, method, method_detail, amount, notes, legacy_ledger_id, received_at, source)
      VALUES (?, ?, 'IN', 'CARRIED_OVER_CUSTOMER', ?, ?, ?, ?, ?, ?, 'MIGRATION')`,
      [c.tenant_id, c.id, mode.method, mode.detail, amount, `Carried over (catch-up) from the customer ledger: ${l.reference || ''}`, l.id, ts(l.transaction_date)]).lastInsertRowid);
    let left = amount;
    const openingDue = r2(Math.max(Number(c.opening_balance) || 0, 0) - db.get<any>(`SELECT ${netAlloc("a.target = 'OPENING_BALANCE' AND a.customer_id = ?")} v`, [c.id]).v);
    if (openingDue > TOL && left > TOL) { const x = r2(Math.min(left, openingDue)); alloc(pid, c.id, 'OPENING_BALANCE', null, null, x, ts(l.transaction_date)); left = r2(left - x); }
    for (const inv of db.all<any>("SELECT id, invoice_number, balance_due FROM sales_headers WHERE customer_id = ? AND balance_due > ? ORDER BY sale_date, id", [c.id, TOL])) {
      if (left <= TOL) break;
      const x = r2(Math.min(left, inv.balance_due));
      alloc(pid, c.id, 'SALE', inv.id, inv.invoice_number, x, ts(l.transaction_date));
      left = r2(left - x);
    }
    issue(c.id, null, l.id, 'CAUGHT_UP_CUSTOMER_PAYMENT', amount, `Ledger payment #${l.id} (Rs. ${amount}) had no payment record; carried over${left > TOL ? `, Rs. ${left} kept as advance` : ''}.`);
  }
}

export const carriedOverBalances: Migration = {
  version: 9,
  name: 'carried_over_balances',
  up(db) {
    const before = {
      allocations: db.all('SELECT id, payment_id, customer_id, target, sale_id, invoice_number, kind, amount, releases_allocation_id, reason, source, created_by_user_id, created_at FROM payment_allocations ORDER BY id'),
      sales: db.all('SELECT id, grand_total, amount_paid, amount_due, payment_status, balance_due, settlement_status FROM sales_headers ORDER BY id'),
      balances: db.all('SELECT id, current_balance FROM customers ORDER BY id'),
    };
    schema(db);
    triggers(db);
    // the rebuilt table holds exactly the same rows
    const copied = db.all('SELECT id, payment_id, customer_id, target, sale_id, invoice_number, kind, amount, releases_allocation_id, reason, source, created_by_user_id, created_at FROM payment_allocations ORDER BY id');
    if (JSON.stringify(copied) !== JSON.stringify(before.allocations)) throw new Error('payment_allocations rebuild changed rows');
    catchUp(db);
    // nothing historical changed (catch-up only adds payment records and allocations)
    const afterSales = db.all<any>('SELECT id, grand_total, amount_paid, amount_due, payment_status FROM sales_headers ORDER BY id');
    if (JSON.stringify(afterSales) !== JSON.stringify((before.sales as any[]).map(({ balance_due, settlement_status, ...r }) => r))) throw new Error('sale snapshot changed');
    if (JSON.stringify(db.all('SELECT id, current_balance FROM customers ORDER BY id')) !== JSON.stringify(before.balances)) throw new Error('customer balances changed');
    const bad = db.get<any>(`SELECT COUNT(*) n FROM sales_headers s WHERE s.balance_due IS NOT ${balanceExpr('s.id', 's.grand_total')}`)!.n;
    if (bad) throw new Error(`${bad} invoice balance(s) do not match their allocations after 0009`);
  },
};
