/**
 * Invoice numbers (Phase 7, Batch 2e: fix of legacy defect R4).
 *
 * Before: INV-<store>-<1001 + number of the store's sales>. Deleting (voiding) an older invoice lowered that
 * count, so the next sale got a number that already existed and failed (UNIQUE), or re-issued a voided number.
 *
 * Now: one row per store in `invoice_sequences` holds the next number. It is read and advanced INSIDE the sale's
 * database transaction (SQLite allows one writer at a time, so two sales can never take the same number; a sale
 * that rolls back also rolls back its number). It only ever goes up (a trigger refuses lowering it), so a voided
 * number is never issued again. Existing numbers are never changed. Format unchanged: INV-<store>-<n>.
 *
 * Starting point for a store = 1 + the highest number ever seen for that store anywhere in the database
 * (invoices, payment records, ledger and audit texts that keep numbers of deleted invoices), and never lower than
 * the old formula would have given. As a last guard, a number that already exists is skipped.
 */
import type { DbAdapter } from '../db/adapter';

const NUM = /INV-(\d+)-(\d+)/g;
const LEGACY = /INV-(\d+)\b(?!-)/g;

/** Highest invoice number known for this store, from every place that keeps invoice numbers. */
export function highestKnownInvoiceNumber(db: DbAdapter, tenantId: number): number {
  let max = 0;
  const see = (text: unknown, rowTenant: number | null) => {
    if (!text) return;
    const s = String(text);
    for (const m of s.matchAll(NUM)) if (Number(m[1]) === tenantId) max = Math.max(max, Number(m[2]));
    // the original demo invoice "INV-1001" (no store part) belongs to the row's store (store 1 when unknown)
    for (const m of s.matchAll(LEGACY)) if ((rowTenant ?? 1) === tenantId && Number(m[1]) >= 1000) max = Math.max(max, Number(m[1]));
  };
  const has = (t: string) => !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [t]);
  for (const r of db.all<any>('SELECT invoice_number, tenant_id FROM sales_headers')) see(r.invoice_number, r.tenant_id);
  if (has('payments')) for (const r of db.all<any>('SELECT invoice_number, tenant_id FROM payments WHERE invoice_number IS NOT NULL')) see(r.invoice_number, r.tenant_id);
  if (has('payment_allocations')) for (const r of db.all<any>('SELECT a.invoice_number, c.tenant_id FROM payment_allocations a LEFT JOIN customers c ON c.id = a.customer_id WHERE a.invoice_number IS NOT NULL')) see(r.invoice_number, r.tenant_id);
  for (const r of db.all<any>("SELECT l.reference, c.tenant_id FROM customer_ledger l LEFT JOIN customers c ON c.id = l.customer_id WHERE l.reference LIKE '%INV-%'")) see(r.reference, r.tenant_id);
  for (const r of db.all<any>("SELECT description, tenant_id FROM audit_logs WHERE description LIKE '%INV-%'")) see(r.description, r.tenant_id);
  return max;
}

/** The next number the store would get if it had no sequence row yet. */
export function initialNextValue(db: DbAdapter, tenantId: number): number {
  const count = db.get<{ n: number }>('SELECT COUNT(*) n FROM sales_headers WHERE tenant_id = ?', [tenantId])!.n;
  return Math.max(highestKnownInvoiceNumber(db, tenantId) + 1, 1001 + count);
}

/** Take the next invoice number for a store. Must be called inside the sale's write transaction. */
export function takeInvoiceNumber(db: DbAdapter, tenantId: number): string {
  if (!db.get('SELECT 1 AS x FROM invoice_sequences WHERE tenant_id = ?', [tenantId])) {
    db.run('INSERT INTO invoice_sequences (tenant_id, next_value, updated_at) VALUES (?, ?, ?)', [tenantId, initialNextValue(db, tenantId), new Date().toISOString()]);
  }
  for (let guard = 0; guard < 10_000; guard++) {
    const row = db.get<{ v: number }>('UPDATE invoice_sequences SET next_value = next_value + 1, updated_at = ? WHERE tenant_id = ? RETURNING next_value - 1 AS v', [new Date().toISOString(), tenantId])!;
    const candidate = `INV-${tenantId}-${row.v}`;
    if (!db.get('SELECT 1 AS x FROM sales_headers WHERE invoice_number = ?', [candidate])) return candidate;
  }
  throw new Error('Could not find a free invoice number');
}

/** After a restore of an older backup: never go below what this computer had already issued. */
export function raiseSequences(db: DbAdapter, atLeast: { tenant_id: number; next_value: number }[]): void {
  for (const s of atLeast) {
    const cur = db.get<{ v: number }>('SELECT next_value v FROM invoice_sequences WHERE tenant_id = ?', [s.tenant_id]);
    if (!cur) db.run('INSERT INTO invoice_sequences (tenant_id, next_value, updated_at) VALUES (?, ?, ?)', [s.tenant_id, Math.max(s.next_value, initialNextValue(db, s.tenant_id)), new Date().toISOString()]);
    else if (cur.v < s.next_value) db.run('UPDATE invoice_sequences SET next_value = ?, updated_at = ? WHERE tenant_id = ?', [s.next_value, new Date().toISOString(), s.tenant_id]);
  }
}
