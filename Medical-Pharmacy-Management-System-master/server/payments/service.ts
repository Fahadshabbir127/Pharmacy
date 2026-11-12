/**
 * Payment service (Phase 7, Batch 2b). Every function here runs INSIDE the caller's database transaction
 * (tx() wrapper), so a payment, its allocations, the customer balance, the ledger row and the audit row are
 * written together or not at all. Validation happens before the first write; the database triggers of
 * migrations 0008/0009 are the last line of defence (append-only history, no overpayment).
 *
 * Decisions: P2 (opening balance first, then confirmed carried-over balances (Q1), then oldest invoices),
 * P3 (advance applied to the next credit invoice), P5 (interim void), P6 (methods), P7 (ADMIN reversal with
 * reason, never edit/delete), condition 1 (transaction id on every new payment write).
 */
import type { DbAdapter } from '../db/adapter';

export const TOL = 0.005;
export const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
export const PAY_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_WALLET'] as const;
export type PayMethod = typeof PAY_METHODS[number];
export const WALLETS = ['EasyPaisa', 'JazzCash'];
export const MAX_AMOUNT = 10_000_000;

export class PaymentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentError';
  }
}

export type Actor = { id: number; name: string };
export type AuditFn = (action: string, description: string, targetType: string, targetId: number | null) => void;
export type Source = 'POS' | 'CUSTOMER_SCREEN' | 'SALES_REGISTER' | 'SYSTEM' | 'ADVANCE';

// ---------------------------------------------------------------- validation (no writes)

export function parseAmount(raw: unknown, what = 'Amount'): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new PaymentError(400, 'INVALID_AMOUNT', `${what} must be a number greater than zero.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new PaymentError(400, 'INVALID_AMOUNT', `${what} can have at most 2 decimal places.`);
  if (n > MAX_AMOUNT) throw new PaymentError(400, 'INVALID_AMOUNT', `${what} is too large.`);
  return r2(n);
}

/** Accepts the method codes (CASH, CARD, BANK_TRANSFER, MOBILE_WALLET) and the old screen's mode names. */
export function parseMethod(method: unknown, detail?: unknown): { method: PayMethod; detail: string | null } {
  const raw = String(method ?? '').trim();
  const k = raw.toLowerCase();
  const legacy: Record<string, { method: PayMethod; detail: string | null }> = {
    cash: { method: 'CASH', detail: null }, card: { method: 'CARD', detail: null }, 'bank transfer': { method: 'BANK_TRANSFER', detail: null },
    easypaisa: { method: 'MOBILE_WALLET', detail: 'EasyPaisa' }, jazzcash: { method: 'MOBILE_WALLET', detail: 'JazzCash' },
  };
  let m: PayMethod | null = (PAY_METHODS as readonly string[]).includes(raw.toUpperCase()) ? (raw.toUpperCase() as PayMethod) : null;
  let d: string | null = null;
  if (!m && legacy[k]) ({ method: m, detail: d } = legacy[k]);
  if (!m) throw new PaymentError(400, 'INVALID_PAYMENT_METHOD', 'Payment method must be Cash, Card, Bank Transfer or Mobile Wallet (EasyPaisa / JazzCash).');
  if (m === 'MOBILE_WALLET') {
    const given = detail === undefined || detail === null || detail === '' ? d : WALLETS.find((w) => w.toLowerCase() === String(detail).trim().toLowerCase()) ?? null;
    if (!given) throw new PaymentError(400, 'INVALID_PAYMENT_METHOD', 'For Mobile Wallet choose EasyPaisa or JazzCash.');
    return { method: m, detail: given };
  }
  return { method: m, detail: null };
}

export function parseTxnId(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') throw new PaymentError(400, 'TXN_ID_REQUIRED', 'A transaction id (client_txn_id) is required for every payment.');
  const s = String(raw);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) throw new PaymentError(400, 'INVALID_TXN_ID', 'Invalid client_txn_id.');
  return s;
}

export function parseText(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).replace(/<[^>]*>/g, '').trim().slice(0, max);
  return s || null;
}

export const methodLabel = (m: string, detail?: string | null) =>
  m === 'MOBILE_WALLET' ? detail || 'Mobile Wallet' : m === 'BANK_TRANSFER' ? 'Bank Transfer' : m === 'CARD' ? 'Card' : m === 'CASH' ? 'Cash' : detail || 'Unspecified';

// ---------------------------------------------------------------- reads

const net = (db: DbAdapter, where: string, params: any[]) =>
  db.get<{ v: number }>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) v FROM payment_allocations WHERE ${where}`, params)!.v;

export function unallocated(db: DbAdapter, paymentId: number): number {
  const p = db.get<{ amount: number }>('SELECT amount FROM payments WHERE id = ?', [paymentId])!;
  return r2(p.amount - net(db, 'payment_id = ?', [paymentId]));
}
export const isReversed = (db: DbAdapter, paymentId: number) => !!db.get('SELECT 1 AS x FROM payments WHERE reverses_payment_id = ?', [paymentId]);

export interface OutstandingItem { target: 'OPENING_BALANCE' | 'CARRIED_OVER_BALANCE' | 'SALE'; saleId: number | null; invoiceNumber: string | null; carriedOverId: number | null; date: string; total: number; due: number }

/** What the customer owes, in the order payments settle it (P2 + Q1): opening, carried-over, oldest invoices. */
export function outstandingItems(db: DbAdapter, customerId: number): OutstandingItem[] {
  const items: OutstandingItem[] = [];
  const c = db.get<any>('SELECT opening_balance, created_at FROM customers WHERE id = ?', [customerId]);
  if (!c) return items;
  const opening = Math.max(Number(c.opening_balance) || 0, 0);
  const openingDue = r2(opening - net(db, "target = 'OPENING_BALANCE' AND customer_id = ?", [customerId]));
  if (openingDue > TOL) items.push({ target: 'OPENING_BALANCE', saleId: null, invoiceNumber: null, carriedOverId: null, date: String(c.created_at ?? ''), total: opening, due: openingDue });
  for (const b of db.all<any>('SELECT id, amount, confirmed_at FROM customer_carried_over_balances WHERE customer_id = ? ORDER BY confirmed_at, id', [customerId])) {
    const due = r2(b.amount - net(db, "target = 'CARRIED_OVER_BALANCE' AND carried_over_id = ?", [b.id]));
    if (due > TOL) items.push({ target: 'CARRIED_OVER_BALANCE', saleId: null, invoiceNumber: null, carriedOverId: b.id, date: b.confirmed_at, total: b.amount, due });
  }
  for (const s of db.all<any>(`SELECT id, invoice_number, sale_date, grand_total, balance_due FROM sales_headers WHERE customer_id = ? AND balance_due > ? ORDER BY sale_date, id`, [customerId, TOL])) {
    items.push({ target: 'SALE', saleId: s.id, invoiceNumber: s.invoice_number, carriedOverId: null, date: s.sale_date, total: s.grand_total, due: r2(s.balance_due) });
  }
  return items;
}

/** Customer payments (not reversed) that still have money not allocated to anything: the advance. Oldest first. */
export function advancePayments(db: DbAdapter, customerId: number): { id: number; free: number }[] {
  return db.all<any>(`SELECT p.id, p.amount - COALESCE((SELECT SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS free
      FROM payments p WHERE p.customer_id = ? AND p.direction = 'IN' AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id)
      ORDER BY p.received_at, p.id`, [customerId])
    .map((r) => ({ id: r.id, free: r2(r.free) })).filter((r) => r.free > TOL);
}

export function customerSummary(db: DbAdapter, customerId: number) {
  const items = outstandingItems(db, customerId);
  const advance = r2(advancePayments(db, customerId).reduce((s, p) => s + p.free, 0));
  const opening = Number(db.get<any>('SELECT opening_balance o FROM customers WHERE id = ?', [customerId])?.o) || 0;
  const owed = r2(items.reduce((s, i) => s + i.due, 0));
  const explained = r2(owed - advance + (opening < -TOL ? opening : 0));
  const stored = r2(Number(db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [customerId])?.b) || 0);
  return { items, advance, owed, explained, stored, difference: r2(stored - explained) };
}

// ---------------------------------------------------------------- writes

export interface NewPayment {
  tenantId: number | null; customerId: number | null; saleId?: number | null; invoiceNumber?: string | null;
  kind: 'SALE_TENDER' | 'CUSTOMER_PAYMENT' | 'INVOICE_PAYMENT'; method: PayMethod; detail: string | null; amount: number;
  cashTendered?: number | null; changeGiven?: number | null; reference?: string | null; notes?: string | null;
  clientTxnId: string; actor: Actor; source: Source;
}

export function insertPayment(db: DbAdapter, p: NewPayment): number {
  if (db.get('SELECT 1 AS x FROM payments WHERE client_txn_id = ?', [p.clientTxnId])) {
    throw new PaymentError(409, 'DUPLICATE_PAYMENT', 'A payment with this transaction id has already been recorded.');
  }
  return Number(db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, method_detail, amount, cash_tendered, change_given,
      reference, notes, client_txn_id, received_by_user_id, received_at, source) VALUES (?, ?, ?, ?, 'IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.tenantId, p.customerId, p.saleId ?? null, p.invoiceNumber ?? null, p.kind, p.method, p.detail, p.amount, p.cashTendered ?? null, p.changeGiven ?? null,
      p.reference ?? null, p.notes ?? null, p.clientTxnId, p.actor.id, nowTs(), p.source === 'ADVANCE' ? 'SYSTEM' : p.source]).lastInsertRowid);
}

export const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export interface Allocation { allocationId: number; paymentId: number; target: string; saleId: number | null; invoiceNumber: string | null; carriedOverId: number | null; amount: number }

export function applyAllocation(db: DbAdapter, a: { paymentId: number; customerId: number | null; item: Pick<OutstandingItem, 'target' | 'saleId' | 'invoiceNumber' | 'carriedOverId'>; amount: number; source: Source; actor: Actor }): Allocation {
  const id = Number(db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, carried_over_id, kind, amount, source, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'APPLY', ?, ?, ?, ?)`,
    [a.paymentId, a.customerId, a.item.target, a.item.saleId, a.item.invoiceNumber, a.item.carriedOverId, r2(a.amount), a.source, a.actor.id, nowTs()]).lastInsertRowid);
  return { allocationId: id, paymentId: a.paymentId, target: a.item.target, saleId: a.item.saleId, invoiceNumber: a.item.invoiceNumber, carriedOverId: a.item.carriedOverId, amount: r2(a.amount) };
}

/** P2 + Q1: settle the customer's items in order with this payment; what is left stays as advance. */
export function allocateFifo(db: DbAdapter, paymentId: number, customerId: number, source: Source, actor: Actor): { allocations: Allocation[]; advance: number } {
  let left = unallocated(db, paymentId);
  const allocations: Allocation[] = [];
  for (const item of outstandingItems(db, customerId)) {
    if (left <= TOL) break;
    const x = r2(Math.min(left, item.due));
    if (x <= 0) continue;
    allocations.push(applyAllocation(db, { paymentId, customerId, item, amount: x, source, actor }));
    left = r2(left - x);
  }
  return { allocations, advance: left };
}

/** P3: the customer's available advance settles this (credit) invoice, oldest advance first, never more than it owes. */
export function applyAdvanceToSale(db: DbAdapter, customerId: number, saleId: number, actor: Actor): Allocation[] {
  const sale = db.get<any>('SELECT id, invoice_number, balance_due FROM sales_headers WHERE id = ?', [saleId]);
  let due = r2(Number(sale?.balance_due) || 0);
  const out: Allocation[] = [];
  if (due <= TOL) return out;
  for (const p of advancePayments(db, customerId)) {
    if (due <= TOL) break;
    const x = r2(Math.min(p.free, due));
    out.push(applyAllocation(db, { paymentId: p.id, customerId, item: { target: 'SALE', saleId, invoiceNumber: sale.invoice_number, carriedOverId: null }, amount: x, source: 'ADVANCE', actor }));
    due = r2(due - x);
  }
  return out;
}

/** Release everything a payment still has applied (append-only RELEASE rows with the reason). */
export function releaseAll(db: DbAdapter, paymentId: number, reason: string, actor: Actor): Allocation[] {
  const out: Allocation[] = [];
  for (const a of db.all<any>(`SELECT a.*, a.amount - COALESCE((SELECT SUM(x.amount) FROM payment_allocations x WHERE x.releases_allocation_id = a.id), 0) AS remaining
      FROM payment_allocations a WHERE a.payment_id = ? AND a.kind = 'APPLY' ORDER BY a.id`, [paymentId])) {
    const rem = r2(a.remaining);
    if (rem <= TOL) continue;
    const id = Number(db.run(`INSERT INTO payment_allocations (payment_id, customer_id, target, sale_id, invoice_number, carried_over_id, kind, amount, releases_allocation_id, reason, source, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'RELEASE', ?, ?, ?, 'SYSTEM', ?, ?)`,
      [paymentId, a.customer_id, a.target, a.sale_id, a.invoice_number, a.carried_over_id, rem, a.id, reason, actor.id, nowTs()]).lastInsertRowid);
    out.push({ allocationId: id, paymentId, target: a.target, saleId: a.sale_id, invoiceNumber: a.invoice_number, carriedOverId: a.carried_over_id, amount: -rem });
  }
  return out;
}

/**
 * P7: reverse a payment (never edited or deleted). Releases its allocations, records an OUT reversal for the
 * full amount with the reason. If it reduced a customer's balance, the balance goes back up and the ledger
 * gets an ADJUSTMENT row. Refused if already reversed (also enforced by a unique index).
 */
export function reversePayment(db: DbAdapter, o: { paymentId: number; reason: string; clientTxnId: string; actor: Actor; audit: AuditFn; affectsCustomerBalance: boolean; allowWalkInSaleTender?: boolean; source: Source }) {
  const p = db.get<any>('SELECT * FROM payments WHERE id = ?', [o.paymentId]);
  if (!p) throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  if (p.direction !== 'IN') throw new PaymentError(409, 'NOT_REVERSIBLE', 'A reversal cannot itself be reversed.');
  if (isReversed(db, p.id)) throw new PaymentError(409, 'ALREADY_REVERSED', 'This payment has already been reversed.');
  if (!p.customer_id && !o.allowWalkInSaleTender) {
    throw new PaymentError(409, 'WALKIN_PAYMENT_REVERSAL', 'A walk-in sale payment can only be reversed by voiding that sale.');
  }
  if (db.get('SELECT 1 AS x FROM payments WHERE client_txn_id = ?', [o.clientTxnId])) throw new PaymentError(409, 'DUPLICATE_PAYMENT', 'This transaction id has already been used.');
  const released = releaseAll(db, p.id, `Payment #${p.id} reversed: ${o.reason}`, o.actor);
  const reversalId = Number(db.run(`INSERT INTO payments (tenant_id, customer_id, sale_id, invoice_number, direction, kind, method, method_detail, amount, reason, reverses_payment_id,
      client_txn_id, received_by_user_id, received_at, source) VALUES (?, ?, ?, ?, 'OUT', 'REVERSAL', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.tenant_id, p.customer_id, p.sale_id, p.invoice_number, p.method, p.method_detail, p.amount, o.reason, p.id, o.clientTxnId, o.actor.id, nowTs(),
      o.source === 'ADVANCE' ? 'SYSTEM' : o.source]).lastInsertRowid);
  let newBalance: number | null = null;
  if (p.customer_id && o.affectsCustomerBalance) {
    db.run('UPDATE customers SET current_balance = current_balance + ? WHERE id = ?', [p.amount, p.customer_id]);
    newBalance = db.get<any>('SELECT current_balance b FROM customers WHERE id = ?', [p.customer_id]).b;
    db.run(`INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes, sale_id, payment_id) VALUES (?, 'ADJUSTMENT', ?, ?, 0, ?, ?, ?, ?)`,
      [p.customer_id, `Payment Reversed (${methodLabel(p.method, p.method_detail)})`, p.amount, newBalance, `Reversal of payment #${p.id}: ${o.reason}`, p.sale_id, reversalId]);
  }
  o.audit('PAYMENT_REVERSED', `Reversed payment #${p.id} (Rs. ${p.amount}, ${methodLabel(p.method, p.method_detail)}${p.invoice_number ? `, invoice ${p.invoice_number}` : ''}${p.customer_id ? `, customer #${p.customer_id}` : ''}); released ${released.length} allocation(s) totalling Rs. ${r2(-released.reduce((s, a) => s + a.amount, 0))}. Reason: ${o.reason}`, 'PAYMENT', p.id);
  return { reversalId, released, newBalance, original: p };
}

export const describeAllocations = (list: Allocation[]) =>
  list.map((a) => `${a.target === 'SALE' ? `invoice ${a.invoiceNumber}` : a.target === 'OPENING_BALANCE' ? 'opening balance' : `carried-over balance #${a.carriedOverId}`} Rs. ${a.amount}`).join(', ') || 'nothing (kept as advance)';
