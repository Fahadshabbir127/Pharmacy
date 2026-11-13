/**
 * 0011: invoice number sequences (Phase 7, Batch 2e, fix of legacy defect R4).
 *
 * Creates `invoice_sequences` (one row per store: the next invoice number) and starts each store at 1 + the
 * highest invoice number found anywhere in the database (invoices, payment records, ledger and audit texts that
 * still mention deleted invoices), never lower than the old formula. A trigger refuses lowering a sequence or
 * deleting a row. No invoice or financial record is changed. This file is frozen once released.
 */
import type { Migration } from '../migrate';

export const invoiceSequences: Migration = {
  version: 11,
  name: 'invoice_sequences',
  up(db) {
    db.exec(`
      CREATE TABLE invoice_sequences (
        tenant_id INTEGER PRIMARY KEY,
        next_value INTEGER NOT NULL CHECK (next_value >= 1),
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER trg_invoice_seq_no_decrease BEFORE UPDATE ON invoice_sequences
      WHEN NEW.next_value < OLD.next_value OR NEW.tenant_id IS NOT OLD.tenant_id
      BEGIN SELECT RAISE(ABORT, 'INVOICE_SEQUENCE: invoice numbers are never reused (the sequence cannot go down)'); END;
      CREATE TRIGGER trg_invoice_seq_no_delete BEFORE DELETE ON invoice_sequences
      BEGIN SELECT RAISE(ABORT, 'INVOICE_SEQUENCE: invoice sequences are never deleted'); END;
    `);
    // frozen copy of the scan used by the application (server/sales/invoiceNumbers.ts at the time of 0011)
    const NUM = /INV-(\d+)-(\d+)/g;
    const LEGACY = /INV-(\d+)\b(?!-)/g;
    const tenants = new Set<number>();
    for (const r of db.all<{ id: number }>('SELECT id FROM tenants')) tenants.add(r.id);
    for (const r of db.all<{ t: number | null }>('SELECT DISTINCT tenant_id t FROM sales_headers')) tenants.add(r.t ?? 1);
    const texts: { text: string; tenant: number | null }[] = [];
    for (const r of db.all<any>('SELECT invoice_number, tenant_id FROM sales_headers')) texts.push({ text: r.invoice_number, tenant: r.tenant_id });
    for (const r of db.all<any>('SELECT invoice_number, tenant_id FROM payments WHERE invoice_number IS NOT NULL')) texts.push({ text: r.invoice_number, tenant: r.tenant_id });
    for (const r of db.all<any>('SELECT a.invoice_number, c.tenant_id FROM payment_allocations a LEFT JOIN customers c ON c.id = a.customer_id WHERE a.invoice_number IS NOT NULL')) texts.push({ text: r.invoice_number, tenant: r.tenant_id });
    for (const r of db.all<any>("SELECT l.reference, c.tenant_id FROM customer_ledger l LEFT JOIN customers c ON c.id = l.customer_id WHERE l.reference LIKE '%INV-%'")) texts.push({ text: r.reference, tenant: r.tenant_id });
    for (const r of db.all<any>("SELECT description, tenant_id FROM audit_logs WHERE description LIKE '%INV-%'")) texts.push({ text: r.description, tenant: r.tenant_id });
    const highest = new Map<number, number>();
    for (const { text, tenant } of texts) {
      const s = String(text ?? '');
      for (const m of s.matchAll(NUM)) { const t = Number(m[1]); tenants.add(t); highest.set(t, Math.max(highest.get(t) ?? 0, Number(m[2]))); }
      for (const m of s.matchAll(LEGACY)) if (Number(m[1]) >= 1000) { const t = tenant ?? 1; highest.set(t, Math.max(highest.get(t) ?? 0, Number(m[1]))); }
    }
    const at = new Date().toISOString();
    const summary: string[] = [];
    for (const t of [...tenants].sort((a, b) => a - b)) {
      const count = db.get<{ n: number }>('SELECT COUNT(*) n FROM sales_headers WHERE tenant_id = ?', [t])!.n;
      const next = Math.max((highest.get(t) ?? 0) + 1, 1001 + count);
      db.run('INSERT INTO invoice_sequences (tenant_id, next_value, updated_at) VALUES (?, ?, ?)', [t, next, at]);
      summary.push(`store ${t}: next INV-${t}-${next}`);
    }
    if (summary.length) {
      db.run("INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, tenant_id) VALUES (NULL, 'Database upgrade', 'INVOICE_SEQUENCE_INIT', ?, 'SETTINGS', NULL)",
        [`Invoice numbering now uses a sequence that never reuses numbers (fix R4). ${summary.join('; ')}. No existing invoice number was changed.`]);
    }
  },
};
