/**
 * 0008: payment records and their allocation to invoices (Phase 7, Batch 2a; decisions P1-P8, E5, E9).
 *
 * New, append-only tables:
 *   payments             one row per amount of money received (IN) or a reversal of it (OUT)
 *   payment_allocations  which payment settled which invoice or opening balance (APPLY), and releases (RELEASE)
 *   payment_migration_issues  what did not add up while carrying over the history (reported, never corrected)
 * New columns on sales_headers: balance_due, settlement_status - kept equal to the allocations by triggers (P1).
 * The original amount_paid / amount_due / payment_status / payment_method and totals stay the at-sale
 * snapshot: a trigger refuses any change to them.
 *
 * History (E9, P4): every sale with amount_paid > 0 gets one CARRIED_OVER_SALE payment applied to that sale;
 * every ledger PAYMENT row gets one CARRIED_OVER_CUSTOMER payment, applied in date order to the opening balance
 * first, then the oldest open invoices (P2); what is left is the customer's advance, applied to that customer's
 * next credit invoice (P3). No existing row, amount or balance is changed. Each customer's stored balance is
 * compared with the reconstructed one; differences are written to payment_migration_issues and the audit log.
 *
 * This file is frozen once released: later fixes go into a new migration.
 */
import type { Migration } from '../migrate';
import type { DbAdapter } from '../adapter';

export const PAYMENT_GUARD = 'PAYMENT_GUARD';
const TOL = 0.005;
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
/** timestamps in this database are 'YYYY-MM-DD HH:MM:SS' (or ISO with T); make them comparable */
const ts = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 19) : '0000-00-00 00:00:00');

function mapLegacyMode(reference: string | null): { method: string; detail: string | null } {
  const m = /\(([^)]*)\)\s*$/.exec(reference || '');
  const mode = (m ? m[1] : '').trim();
  const k = mode.toLowerCase();
  if (k === 'cash') return { method: 'CASH', detail: null };
  if (k === 'easypaisa') return { method: 'MOBILE_WALLET', detail: 'EasyPaisa' };
  if (k === 'jazzcash') return { method: 'MOBILE_WALLET', detail: 'JazzCash' };
  if (k === 'bank transfer') return { method: 'BANK_TRANSFER', detail: null };
  return { method: 'UNSPECIFIED', detail: mode || null };
}

function createSchema(db: DbAdapter) {
  db.exec(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      customer_id INTEGER REFERENCES customers(id),
      sale_id INTEGER REFERENCES sales_headers(id) ON DELETE SET NULL,
      invoice_number TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
      kind TEXT NOT NULL CHECK (kind IN ('SALE_TENDER', 'CUSTOMER_PAYMENT', 'INVOICE_PAYMENT', 'CARRIED_OVER_SALE', 'CARRIED_OVER_CUSTOMER', 'REVERSAL')),
      method TEXT NOT NULL CHECK (method IN ('CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_WALLET', 'UNSPECIFIED')),
      method_detail TEXT,
      amount REAL NOT NULL CHECK (amount > 0),
      cash_tendered REAL CHECK (cash_tendered IS NULL OR cash_tendered >= 0),
      change_given REAL CHECK (change_given IS NULL OR change_given >= 0),
      reference TEXT,
      notes TEXT,
      reason TEXT,
      reverses_payment_id INTEGER REFERENCES payments(id),
      client_txn_id TEXT UNIQUE,
      legacy_sale_id INTEGER UNIQUE,
      legacy_ledger_id INTEGER UNIQUE,
      received_by_user_id INTEGER REFERENCES users(id),
      received_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('POS', 'CUSTOMER_SCREEN', 'SALES_REGISTER', 'MIGRATION', 'SYSTEM')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- a reversal is the only money going OUT, and it names the payment it reverses
      CHECK ((kind = 'REVERSAL' AND direction = 'OUT' AND reverses_payment_id IS NOT NULL AND reason IS NOT NULL AND trim(reason) <> '')
          OR (kind <> 'REVERSAL' AND direction = 'IN' AND reverses_payment_id IS NULL)),
      -- condition 1: every new payment write carries a transaction id; only carried-over history has none
      CHECK (client_txn_id IS NOT NULL OR (source = 'MIGRATION' AND kind IN ('CARRIED_OVER_SALE', 'CARRIED_OVER_CUSTOMER'))),
      CHECK (change_given IS NULL OR method = 'CASH')
    );
    CREATE UNIQUE INDEX ux_payments_one_reversal ON payments(reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;
    CREATE INDEX ix_payments_customer ON payments(customer_id, received_at);
    CREATE INDEX ix_payments_sale ON payments(sale_id);
    CREATE INDEX ix_payments_received ON payments(received_at);

    CREATE TABLE payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      customer_id INTEGER REFERENCES customers(id),
      target TEXT NOT NULL CHECK (target IN ('SALE', 'OPENING_BALANCE')),
      sale_id INTEGER REFERENCES sales_headers(id) ON DELETE SET NULL,
      invoice_number TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('APPLY', 'RELEASE')),
      amount REAL NOT NULL CHECK (amount > 0),
      releases_allocation_id INTEGER REFERENCES payment_allocations(id),
      reason TEXT,
      source TEXT NOT NULL CHECK (source IN ('POS', 'CUSTOMER_SCREEN', 'SALES_REGISTER', 'MIGRATION', 'SYSTEM', 'ADVANCE')),
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((kind = 'RELEASE') = (releases_allocation_id IS NOT NULL)),
      CHECK (kind = 'APPLY' OR (reason IS NOT NULL AND trim(reason) <> '')),
      CHECK (target = 'OPENING_BALANCE' OR invoice_number IS NOT NULL),
      CHECK (target = 'SALE' OR (sale_id IS NULL AND customer_id IS NOT NULL))
    );
    CREATE INDEX ix_alloc_payment ON payment_allocations(payment_id);
    CREATE INDEX ix_alloc_sale ON payment_allocations(sale_id);
    CREATE INDEX ix_alloc_customer ON payment_allocations(customer_id, target);

    CREATE TABLE payment_migration_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      sale_id INTEGER,
      ledger_id INTEGER,
      issue TEXT NOT NULL,
      stored_value REAL,
      expected_value REAL,
      difference REAL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE sales_headers ADD COLUMN balance_due REAL;
    ALTER TABLE sales_headers ADD COLUMN settlement_status TEXT CHECK (settlement_status IS NULL OR settlement_status IN ('PAID', 'PARTIAL', 'UNPAID'));
  `);
}

/** SQL for "net amount applied to sale X" and the derived balance/status. */
const appliedToSale = (saleExpr: string) =>
  `(SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a WHERE a.target = 'SALE' AND a.sale_id = ${saleExpr})`;
const balanceExpr = (saleExpr: string, totalExpr: string) => `ROUND(${totalExpr} - ${appliedToSale(saleExpr)}, 2)`;
const statusExpr = (saleExpr: string, totalExpr: string) =>
  `CASE WHEN ${balanceExpr(saleExpr, totalExpr)} <= ${TOL} THEN 'PAID' WHEN ${appliedToSale(saleExpr)} <= ${TOL} THEN 'UNPAID' ELSE 'PARTIAL' END`;

function createTriggers(db: DbAdapter) {
  const G = (msg: string) => `SELECT RAISE(ABORT, '${PAYMENT_GUARD}: ${msg}')`;
  const paymentCols = ['id', 'tenant_id', 'customer_id', 'invoice_number', 'direction', 'kind', 'method', 'method_detail', 'amount', 'cash_tendered', 'change_given',
    'reference', 'notes', 'reason', 'reverses_payment_id', 'client_txn_id', 'legacy_sale_id', 'legacy_ledger_id', 'received_by_user_id', 'received_at', 'source', 'created_at'];
  const allocCols = ['id', 'payment_id', 'customer_id', 'target', 'invoice_number', 'kind', 'amount', 'releases_allocation_id', 'reason', 'source', 'created_by_user_id', 'created_at'];
  const changed = (cols: string[]) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ');
  const snapshotCols = ['invoice_number', 'customer_id', 'sale_date', 'total_amount', 'discount_percent', 'discount_amount', 'net_amount', 'total_gst', 'grand_total',
    'payment_method', 'amount_paid', 'amount_due', 'payment_status', 'created_by_user_id'];

  db.exec(`
    -- append-only payment history: never deleted, never edited (only the invoice link may be cleared when a
    -- legacy hard void deletes the invoice; the invoice_number copy stays)
    CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments BEGIN ${G('payments are never deleted; record a reversal')}; END;
    CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
    WHEN ${changed(paymentCols)} OR (NEW.sale_id IS NOT OLD.sale_id AND NEW.sale_id IS NOT NULL)
    BEGIN ${G('payments are never edited; record a reversal')}; END;
    CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON payment_allocations BEGIN ${G('allocations are never deleted; record a release')}; END;
    CREATE TRIGGER trg_alloc_no_update BEFORE UPDATE ON payment_allocations
    WHEN ${changed(allocCols)} OR (NEW.sale_id IS NOT OLD.sale_id AND NEW.sale_id IS NOT NULL)
    BEGIN ${G('allocations are never edited; record a release')}; END;

    -- a reversal reverses exactly one IN payment, for its full amount
    CREATE TRIGGER trg_payments_reversal BEFORE INSERT ON payments WHEN NEW.kind = 'REVERSAL'
    BEGIN
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: a reversal must name an IN payment of the same amount and customer')
      WHERE NOT EXISTS (SELECT 1 FROM payments o WHERE o.id = NEW.reverses_payment_id AND o.direction = 'IN'
                          AND ABS(o.amount - NEW.amount) <= ${TOL} AND o.customer_id IS NEW.customer_id);
    END;

    -- allocations: never more than the payment, the invoice total or the opening balance (no overpayment)
    CREATE TRIGGER trg_alloc_apply_guard BEFORE INSERT ON payment_allocations WHEN NEW.kind = 'APPLY'
    BEGIN
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: allocation must use an IN payment that is not reversed, for the same customer')
      WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.direction = 'IN' AND p.customer_id IS NEW.customer_id)
         OR EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = NEW.payment_id);
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: allocation exceeds the unallocated amount of the payment')
      WHERE (SELECT p.amount FROM payments p WHERE p.id = NEW.payment_id) + ${TOL} <
            NEW.amount + (SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a WHERE a.payment_id = NEW.payment_id);
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: OVERPAYMENT - allocation exceeds the invoice balance')
      WHERE NEW.target = 'SALE' AND (NEW.sale_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM sales_headers s WHERE s.id = NEW.sale_id AND s.customer_id IS NEW.customer_id
                AND ${appliedToSale('NEW.sale_id')} + NEW.amount <= s.grand_total + ${TOL}));
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: OVERPAYMENT - allocation exceeds the opening balance')
      WHERE NEW.target = 'OPENING_BALANCE' AND NOT EXISTS (
              SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND
                (SELECT COALESCE(SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END), 0) FROM payment_allocations a
                  WHERE a.target = 'OPENING_BALANCE' AND a.customer_id = NEW.customer_id) + NEW.amount <= MAX(c.opening_balance, 0) + ${TOL});
    END;
    CREATE TRIGGER trg_alloc_release_guard BEFORE INSERT ON payment_allocations WHEN NEW.kind = 'RELEASE'
    BEGIN
      SELECT RAISE(ABORT, '${PAYMENT_GUARD}: a release must undo part of an APPLY of the same payment and target, and not more than it applied')
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_allocations o WHERE o.id = NEW.releases_allocation_id AND o.kind = 'APPLY' AND o.payment_id = NEW.payment_id
          AND o.target = NEW.target AND o.sale_id IS NEW.sale_id AND o.customer_id IS NEW.customer_id
          AND (SELECT COALESCE(SUM(x.amount), 0) FROM payment_allocations x WHERE x.releases_allocation_id = o.id) + NEW.amount <= o.amount + ${TOL});
    END;

    -- invoice balance and status always follow the allocations (P1)
    CREATE TRIGGER trg_alloc_sync_sale AFTER INSERT ON payment_allocations WHEN NEW.target = 'SALE' AND NEW.sale_id IS NOT NULL
    BEGIN
      UPDATE sales_headers SET balance_due = ${balanceExpr('NEW.sale_id', 'sales_headers.grand_total')},
                               settlement_status = ${statusExpr('NEW.sale_id', 'sales_headers.grand_total')}
      WHERE id = NEW.sale_id;
    END;
    CREATE TRIGGER trg_sales_balance_guard BEFORE UPDATE OF balance_due, settlement_status ON sales_headers
    WHEN NEW.balance_due IS NOT ${balanceExpr('NEW.id', 'NEW.grand_total')} OR NEW.settlement_status IS NOT ${statusExpr('NEW.id', 'NEW.grand_total')}
    BEGIN ${G('balance_due and settlement_status are derived from payment allocations and cannot be set directly')}; END;
    -- a new invoice starts with nothing allocated
    CREATE TRIGGER trg_sales_balance_init AFTER INSERT ON sales_headers
    BEGIN
      UPDATE sales_headers SET balance_due = ${balanceExpr('NEW.id', 'NEW.grand_total')}, settlement_status = ${statusExpr('NEW.id', 'NEW.grand_total')} WHERE id = NEW.id;
    END;
    -- the at-sale figures are an immutable snapshot (P1)
    CREATE TRIGGER trg_sales_snapshot_guard BEFORE UPDATE ON sales_headers
    WHEN ${changed(snapshotCols)}
    BEGIN ${G('the at-sale amounts of an invoice are a permanent record and cannot be changed')}; END;
  `);
}

type Debt = { kind: 'OPENING' | 'SALE'; saleId: number | null; invoice: string | null; remaining: number; at: string };
type Credit = { paymentId: number; remaining: number };

function carryOverHistory(db: DbAdapter) {
  const issue = (i: { customer?: number | null; sale?: number | null; ledger?: number | null; issue: string; stored?: number | null; expected?: number | null; detail: string }) => {
    const diff = i.stored !== undefined && i.stored !== null && i.expected !== undefined && i.expected !== null ? r2(i.stored - i.expected) : null;
    db.run('INSERT INTO payment_migration_issues (customer_id, sale_id, ledger_id, issue, stored_value, expected_value, difference, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [i.customer ?? null, i.sale ?? null, i.ledger ?? null, i.issue, i.stored ?? null, i.expected ?? null, diff, i.detail]);
  };
  const userExists = (id: unknown) => id !== null && id !== undefined && !!db.get('SELECT 1 AS x FROM users WHERE id = ?', [Number(id)]);
  const allocate = (paymentId: number, customerId: number | null, debt: Debt, amount: number, at: string) =>
    db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, kind, amount, source, created_at)
            VALUES (?, ?, ?, ?, ?, 'APPLY', ?, 'MIGRATION', ?)`,
      [paymentId, customerId, debt.kind === 'SALE' ? 'SALE' : 'OPENING_BALANCE', debt.saleId, debt.invoice, r2(amount), at]);

  const sales = db.all<any>('SELECT id, invoice_number, customer_id, sale_date, grand_total, amount_paid, amount_due, created_by_user_id, tenant_id FROM sales_headers ORDER BY id');

  // 1. walk-in sales (no customer): the money taken at the sale settles that sale; nothing else can
  for (const s of sales.filter((x) => x.customer_id === null || x.customer_id === undefined)) {
    const total = Number(s.grand_total) || 0;
    const paid = r2(Number(s.amount_paid) || 0);
    if (paid > 0) {
      const pid = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, amount, legacy_sale_id, received_by_user_id, received_at, source, notes)
        VALUES (?, NULL, ?, ?, 'IN', 'CARRIED_OVER_SALE', 'CASH', ?, ?, ?, ?, 'MIGRATION', 'Carried over: amount paid at the sale (recorded before payment tracking)')`,
        [s.tenant_id, s.id, s.invoice_number, paid, s.id, userExists(s.created_by_user_id) ? s.created_by_user_id : null, ts(s.sale_date)]).lastInsertRowid);
      const apply = Math.min(paid, Math.max(total, 0));
      if (apply > 0) allocate(pid, null, { kind: 'SALE', saleId: s.id, invoice: s.invoice_number, remaining: 0, at: '' }, apply, ts(s.sale_date));
      if (paid > total + TOL) issue({ sale: s.id, issue: 'OVERPAID_AT_SALE', stored: paid, expected: total, detail: `Invoice ${s.invoice_number}: Rs. ${paid} recorded as paid for a Rs. ${total} bill (no customer). The extra Rs. ${r2(paid - total)} is not applied to anything.` });
    }
    const due = r2(total - Math.min(paid, Math.max(total, 0)));
    if (due > TOL) issue({ sale: s.id, issue: 'WALKIN_SALE_WITH_DUE', stored: paid, expected: total, detail: `Invoice ${s.invoice_number}: walk-in sale (no customer) with Rs. ${due} unpaid. No customer balance holds this amount.` });
  }

  // 2. customers: replay sales and ledger payments in date order (P2 opening first, then oldest invoices; P3 advance)
  const customers = db.all<any>('SELECT id, name, opening_balance, current_balance, created_at, tenant_id FROM customers ORDER BY id');
  const ledgerPayments = db.all<any>("SELECT id, customer_id, transaction_date, reference, credit, notes FROM customer_ledger WHERE type = 'PAYMENT' ORDER BY id");
  const known = new Set(customers.map((c) => c.id));
  for (const lp of ledgerPayments.filter((l) => !known.has(l.customer_id))) {
    issue({ customer: lp.customer_id, ledger: lp.id, issue: 'PAYMENT_FOR_MISSING_CUSTOMER', stored: Number(lp.credit) || 0, detail: `Ledger payment #${lp.id} belongs to customer #${lp.customer_id}, who no longer exists. Not carried over.` });
  }

  let carriedSales = 0, carriedCustomer = 0;
  for (const c of customers) {
    type Ev = { at: string; order: number; id: number; run: () => void };
    const debts: Debt[] = [];
    const credits: Credit[] = [];
    const events: Ev[] = [];
    const opening = Number(c.opening_balance) || 0;

    const applyCredits = () => {
      // settle open debts oldest first (opening balance first) with the oldest unallocated money
      const open = () => debts.filter((d) => d.remaining > TOL).sort((a, b) => (a.kind === b.kind ? (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.saleId ?? 0) - (b.saleId ?? 0)) : a.kind === 'OPENING' ? -1 : 1));
      for (const cr of credits) {
        for (const d of open()) {
          if (cr.remaining <= TOL) break;
          const x = r2(Math.min(cr.remaining, d.remaining));
          if (x <= 0) continue;
          allocate(cr.paymentId, c.id, d, x, currentAt);
          cr.remaining = r2(cr.remaining - x);
          d.remaining = r2(d.remaining - x);
        }
      }
    };
    let currentAt = ts(c.created_at);

    if (opening > TOL) events.push({ at: ts(c.created_at), order: 0, id: 0, run: () => { debts.push({ kind: 'OPENING', saleId: null, invoice: null, remaining: r2(opening), at: ts(c.created_at) }); } });
    if (opening < -TOL) issue({ customer: c.id, issue: 'NEGATIVE_OPENING_BALANCE', stored: opening, detail: `Customer "${c.name}" was created with a negative opening balance (Rs. ${opening}). It is not a recorded payment, so it is not carried over as one; it is included in the balance comparison.` });

    for (const s of sales.filter((x) => x.customer_id === c.id)) {
      events.push({ at: ts(s.sale_date), order: 1, id: s.id, run: () => {
        const total = Math.max(Number(s.grand_total) || 0, 0);
        const debt: Debt = { kind: 'SALE', saleId: s.id, invoice: s.invoice_number, remaining: r2(total), at: ts(s.sale_date) };
        debts.push(debt);
        const paid = r2(Number(s.amount_paid) || 0);
        if (paid > 0) {
          const pid = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, amount, legacy_sale_id, received_by_user_id, received_at, source, notes)
            VALUES (?, ?, ?, ?, 'IN', 'CARRIED_OVER_SALE', 'CASH', ?, ?, ?, ?, 'MIGRATION', 'Carried over: amount paid at the sale (recorded before payment tracking)')`,
            [s.tenant_id ?? c.tenant_id, c.id, s.id, s.invoice_number, paid, s.id, userExists(s.created_by_user_id) ? s.created_by_user_id : null, ts(s.sale_date)]).lastInsertRowid);
          carriedSales++;
          const x = r2(Math.min(paid, debt.remaining));
          if (x > 0) { allocate(pid, c.id, debt, x, ts(s.sale_date)); debt.remaining = r2(debt.remaining - x); }
          if (paid > total + TOL) {
            issue({ customer: c.id, sale: s.id, issue: 'OVERPAID_AT_SALE', stored: paid, expected: total, detail: `Invoice ${s.invoice_number}: Rs. ${paid} recorded as paid for a Rs. ${total} bill. The extra Rs. ${r2(paid - total)} becomes the customer's advance.` });
            credits.push({ paymentId: pid, remaining: r2(paid - x) });
          }
        }
        applyCredits(); // P3: an available advance settles the new invoice
      } });
    }

    for (const lp of ledgerPayments.filter((l) => l.customer_id === c.id)) {
      events.push({ at: ts(lp.transaction_date), order: 2, id: lp.id, run: () => {
        const amount = r2(Number(lp.credit) || 0);
        if (!(amount > 0)) {
          issue({ customer: c.id, ledger: lp.id, issue: 'NON_POSITIVE_LEDGER_PAYMENT', stored: amount, detail: `Ledger payment #${lp.id} has amount ${lp.credit}; not carried over as a payment.` });
          return;
        }
        const mode = mapLegacyMode(lp.reference);
        if (mode.method === 'UNSPECIFIED') issue({ customer: c.id, ledger: lp.id, issue: 'UNMAPPED_PAYMENT_METHOD', stored: amount, detail: `Ledger payment #${lp.id}: payment mode "${mode.detail ?? ''}" is not one of Cash, EasyPaisa, JazzCash, Bank Transfer; recorded as UNSPECIFIED with the original text kept.` });
        const pid = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, direction, kind, method, method_detail, amount, notes, legacy_ledger_id, received_at, source)
          VALUES (?, ?, 'IN', 'CARRIED_OVER_CUSTOMER', ?, ?, ?, ?, ?, ?, 'MIGRATION')`,
          [c.tenant_id, c.id, mode.method, mode.detail, amount, `Carried over from the customer ledger: ${lp.reference || ''}${lp.notes ? ` - ${lp.notes}` : ''}`, lp.id, ts(lp.transaction_date)]).lastInsertRowid);
        carriedCustomer++;
        credits.push({ paymentId: pid, remaining: amount });
        applyCredits();
      } });
    }

    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id));
    for (const e of events) { currentAt = e.at; e.run(); }

    // compare the stored balance with the reconstruction (never change it)
    const owed = r2(debts.reduce((s, d) => s + d.remaining, 0));
    const advance = r2(credits.reduce((s, cr) => s + cr.remaining, 0));
    const expected = r2(owed - advance + (opening < -TOL ? opening : 0));
    const stored = r2(Number(c.current_balance) || 0);
    if (Math.abs(stored - expected) > TOL) {
      issue({ customer: c.id, issue: 'BALANCE_MISMATCH', stored, expected, detail: `Customer "${c.name}": stored balance Rs. ${stored}, but invoices, opening balance and recorded payments explain Rs. ${expected} (owed Rs. ${owed}, advance Rs. ${advance}). The stored balance is kept unchanged.` });
      db.run("INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, target_id, tenant_id) VALUES (NULL, 'Database upgrade', 'PAYMENT_MIGRATION_ISSUE', ?, 'CUSTOMER', ?, ?)",
        [`BALANCE_MISMATCH: customer #${c.id} stored Rs. ${stored}, explained by records Rs. ${expected} (difference Rs. ${r2(stored - expected)}). Not changed.`, c.id, c.tenant_id]);
    }
  }
  return { carriedSales: carriedSales + sales.filter((s) => (s.customer_id === null || s.customer_id === undefined) && (Number(s.amount_paid) || 0) > 0).length, carriedCustomer };
}

export const payments: Migration = {
  version: 8,
  name: 'payments',
  up(db) {
    createSchema(db);
    // initial balance for existing invoices (nothing allocated yet), before the guard triggers exist
    db.exec(`UPDATE sales_headers SET balance_due = ROUND(grand_total, 2), settlement_status = CASE WHEN ROUND(grand_total, 2) <= ${TOL} THEN 'PAID' ELSE 'UNPAID' END`);
    createTriggers(db);
    const sums = { sales: db.get<any>('SELECT COUNT(*) n, COALESCE(SUM(amount_paid), 0) paid, COALESCE(SUM(amount_due), 0) due FROM sales_headers')!,
      balances: db.get<any>('SELECT COALESCE(SUM(current_balance), 0) b FROM customers')!,
      ledger: db.get<any>("SELECT COUNT(*) n, COALESCE(SUM(credit), 0) c FROM customer_ledger WHERE type = 'PAYMENT'")! };

    const carried = carryOverHistory(db);

    // ---- prove nothing historical changed ----
    const after = { sales: db.get<any>('SELECT COUNT(*) n, COALESCE(SUM(amount_paid), 0) paid, COALESCE(SUM(amount_due), 0) due FROM sales_headers')!,
      balances: db.get<any>('SELECT COALESCE(SUM(current_balance), 0) b FROM customers')!,
      ledger: db.get<any>("SELECT COUNT(*) n, COALESCE(SUM(credit), 0) c FROM customer_ledger WHERE type = 'PAYMENT'")! };
    if (JSON.stringify(sums) !== JSON.stringify(after)) throw new Error(`payment migration changed historical figures: ${JSON.stringify({ sums, after })}`);
    // every positive at-sale payment and every positive ledger payment was carried over exactly once
    const paidSales = db.get<any>('SELECT COUNT(*) n FROM sales_headers WHERE amount_paid > 0')!.n;
    const carriedSaleRows = db.get<any>("SELECT COUNT(*) n FROM payments WHERE kind = 'CARRIED_OVER_SALE'")!.n;
    if (paidSales !== carriedSaleRows || carried.carriedSales !== carriedSaleRows) throw new Error(`carried-over sale payments ${carriedSaleRows} != paid sales ${paidSales}`);
    const goodLedger = db.get<any>("SELECT COUNT(*) n FROM customer_ledger l WHERE l.type = 'PAYMENT' AND l.credit > 0 AND EXISTS (SELECT 1 FROM customers c WHERE c.id = l.customer_id)")!.n;
    const carriedLedgerRows = db.get<any>("SELECT COUNT(*) n FROM payments WHERE kind = 'CARRIED_OVER_CUSTOMER'")!.n;
    if (goodLedger !== carriedLedgerRows) throw new Error(`carried-over customer payments ${carriedLedgerRows} != ledger payments ${goodLedger}`);
    // amounts carried over equal the recorded amounts
    const pIn = db.get<any>("SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE kind = 'CARRIED_OVER_SALE'")!.s;
    const pSrc = db.get<any>('SELECT COALESCE(SUM(amount_paid), 0) s FROM sales_headers WHERE amount_paid > 0')!.s;
    if (Math.abs(pIn - pSrc) > 0.01) throw new Error(`carried-over sale amounts ${pIn} != amount_paid ${pSrc}`);
    // every invoice balance equals its total minus what was allocated to it, never negative
    const bad = db.get<any>(`SELECT COUNT(*) n FROM sales_headers s WHERE s.balance_due IS NOT ${balanceExpr('s.id', 's.grand_total')} OR s.balance_due < -${TOL}`)!.n;
    if (bad) throw new Error(`${bad} invoice balance(s) do not match their allocations`);

    db.run("INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, tenant_id) VALUES (NULL, 'Database upgrade', 'PAYMENT_MIGRATION', ?, 'PAYMENTS', NULL)",
      [`Payment records created from history: ${carriedSaleRows} at-sale payment(s), ${carriedLedgerRows} customer payment(s), ${db.get<any>('SELECT COUNT(*) n FROM payment_allocations')!.n} allocation(s); ${db.get<any>('SELECT COUNT(*) n FROM payment_migration_issues')!.n} item(s) reported in payment_migration_issues. No existing amount or balance was changed.`]);
  },
};
