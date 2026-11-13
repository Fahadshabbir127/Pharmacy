/**
 * 0010: apply customer advances that already exist (Phase 7, Batch 2c decision).
 *
 * Approved priority: a customer's unallocated advance (oldest payment first) settles 1. the opening balance,
 * 2. confirmed carried-over balances (oldest first), 3. the oldest unpaid invoices. From 2c on the application
 * does this whenever new debt appears; this one-time pass applies advances that existed before (e.g. an advance
 * next to a carried-over balance confirmed under Batch 2b). Every allocation is a permanent APPLY row (source
 * ADVANCE) and each customer gets one audit row. No payment, amount or stored balance is changed; unconfirmed
 * discrepancies are not touched (they are not debt items). This file is frozen once released.
 */
import type { Migration } from '../migrate';

const TOL = 0.005;
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export const applyExistingAdvances: Migration = {
  version: 10,
  name: 'apply_existing_advances',
  up(db) {
    const net = (where: string, params: any[]) => db.get<{ v: number }>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) v FROM payment_allocations WHERE ${where}`, params)!.v;
    const balances = db.all('SELECT id, current_balance FROM customers ORDER BY id');
    const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    for (const c of db.all<{ id: number; opening_balance: number; tenant_id: number | null }>('SELECT id, opening_balance, tenant_id FROM customers ORDER BY id')) {
      const credits = db.all<{ id: number; free: number }>(`SELECT p.id, p.amount - COALESCE((SELECT SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS free
          FROM payments p WHERE p.customer_id = ? AND p.direction = 'IN' AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)
          ORDER BY p.received_at, p.id`, [c.id]).map((x) => ({ id: x.id, free: r2(x.free) })).filter((x) => x.free > TOL);
      if (!credits.length) continue;
      const items: { target: string; saleId: number | null; inv: string | null; cob: number | null; due: number }[] = [];
      const openingDue = r2(Math.max(Number(c.opening_balance) || 0, 0) - net("target = 'OPENING_BALANCE' AND customer_id = ?", [c.id]));
      if (openingDue > TOL) items.push({ target: 'OPENING_BALANCE', saleId: null, inv: null, cob: null, due: openingDue });
      for (const b of db.all<any>('SELECT id, amount FROM customer_carried_over_balances WHERE customer_id = ? ORDER BY confirmed_at, id', [c.id])) {
        const due = r2(b.amount - net("target = 'CARRIED_OVER_BALANCE' AND carried_over_id = ?", [b.id]));
        if (due > TOL) items.push({ target: 'CARRIED_OVER_BALANCE', saleId: null, inv: null, cob: b.id, due });
      }
      for (const s of db.all<any>('SELECT id, invoice_number, balance_due FROM sales_headers WHERE customer_id = ? AND balance_due > ? ORDER BY sale_date, id', [c.id, TOL])) {
        items.push({ target: 'SALE', saleId: s.id, inv: s.invoice_number, cob: null, due: r2(s.balance_due) });
      }
      const applied: string[] = [];
      for (const it of items) {
        let due = it.due;
        for (const cr of credits) {
          if (due <= TOL) break;
          if (cr.free <= TOL) continue;
          const x = r2(Math.min(cr.free, due));
          db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, carried_over_id, kind, amount, source, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'APPLY', ?, 'ADVANCE', ?)`, [cr.id, c.id, it.target, it.saleId, it.inv, it.cob, x, at]);
          cr.free = r2(cr.free - x);
          due = r2(due - x);
          applied.push(`${it.target === 'SALE' ? `invoice ${it.inv}` : it.target === 'OPENING_BALANCE' ? 'opening balance' : `carried-over balance #${it.cob}`} Rs. ${x} (payment #${cr.id})`);
        }
      }
      if (applied.length) {
        db.run("INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, target_id, tenant_id) VALUES (NULL, 'Database upgrade', 'PAYMENT_ADVANCE_APPLIED', ?, 'CUSTOMER', ?, ?)",
          [`Existing advance of customer #${c.id} applied: ${applied.join(', ')}. Stored balance not changed.`, c.id, c.tenant_id]);
      }
    }
    if (JSON.stringify(db.all('SELECT id, current_balance FROM customers ORDER BY id')) !== JSON.stringify(balances)) throw new Error('customer balances changed');
  },
};
