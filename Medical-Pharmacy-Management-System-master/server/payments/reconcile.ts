/**
 * Payment consistency check (Phase 7, Batch 2a). Reports, never repairs.
 *
 * For every customer the stored balance (customers.current_balance) must equal what the records explain:
 *   opening balance still owed + sum(balance_due of the customer's invoices) - unallocated advance
 *   (+ a negative opening balance, which is a credit with no payment record)
 * where advance = net money received from the customer's payments - net amount allocated from them.
 * Also reported: invoices with money recorded at the sale but no payment record (created by a build without
 * payment recording), and walk-in invoices that still show money owed.
 */
import type { DbAdapter } from '../db/adapter';

const TOL = 0.005;
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export interface CustomerReconciliation { customerId: number; name: string; stored: number; expected: number; difference: number; openingDue: number; carriedOverDue: number; invoicesDue: number; advance: number }
export interface PaymentReconciliation {
  checkedAt: string;
  customersChecked: number;
  mismatches: CustomerReconciliation[];
  untrackedSales: number;
  walkInSalesWithDue: number;
  migrationIssues: number;
}

export function customerPosition(db: DbAdapter, customerId: number): Omit<CustomerReconciliation, 'name' | 'stored' | 'difference' | 'expected'> & { expected: number } {
  const c = db.get<{ opening_balance: number }>('SELECT opening_balance FROM customers WHERE id = ?', [customerId]);
  const opening = Number(c?.opening_balance) || 0;
  const openingApplied = db.get<{ s: number }>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) s FROM payment_allocations WHERE target = 'OPENING_BALANCE' AND customer_id = ?`, [customerId])!.s;
  const openingDue = r2(Math.max(opening, 0) - openingApplied);
  // Q1: administrator-confirmed carried-over balances (table exists from migration 0009)
  const hasCob = !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'customer_carried_over_balances'");
  const carriedOverDue = hasCob ? r2(db.get<{ s: number }>('SELECT COALESCE(SUM(amount), 0) s FROM customer_carried_over_balances WHERE customer_id = ?', [customerId])!.s
    - db.get<{ s: number }>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) s FROM payment_allocations WHERE target = 'CARRIED_OVER_BALANCE' AND customer_id = ?`, [customerId])!.s) : 0;
  const invoicesDue = r2(db.get<{ s: number }>('SELECT COALESCE(SUM(balance_due), 0) s FROM sales_headers WHERE customer_id = ? AND balance_due IS NOT NULL', [customerId])!.s);
  // advance = money of the customer's payments that are not reversed and not allocated (a reversal returns the
  // money AND releases its allocations, so reversed payments contribute nothing)
  const advance = r2(db.get<{ s: number }>(`SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0) s
      FROM payments p WHERE p.customer_id = ? AND p.direction = 'IN' AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)`, [customerId])!.s);
  const expected = r2(openingDue + carriedOverDue + invoicesDue - advance + (opening < -TOL ? opening : 0));
  return { customerId, openingDue, carriedOverDue, invoicesDue, advance, expected };
}

export function reconcilePayments(db: DbAdapter): PaymentReconciliation {
  const customers = db.all<{ id: number; name: string; current_balance: number }>('SELECT id, name, current_balance FROM customers ORDER BY id');
  const mismatches: CustomerReconciliation[] = [];
  for (const c of customers) {
    const pos = customerPosition(db, c.id);
    const stored = r2(Number(c.current_balance) || 0);
    if (Math.abs(stored - pos.expected) > TOL) mismatches.push({ ...pos, name: c.name, stored, difference: r2(stored - pos.expected) });
  }
  const untrackedSales = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sales_headers s WHERE s.amount_paid > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id OR p.legacy_sale_id = s.id)`)!.n;
  const walkInSalesWithDue = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sales_headers WHERE customer_id IS NULL AND balance_due > ${TOL}`)!.n;
  const migrationIssues = db.get<{ n: number }>('SELECT COUNT(*) n FROM payment_migration_issues')!.n;
  return { checkedAt: new Date().toISOString(), customersChecked: customers.length, mismatches, untrackedSales, walkInSalesWithDue, migrationIssues };
}
