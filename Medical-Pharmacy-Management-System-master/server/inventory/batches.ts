/**
 * Batch operations used by the routes and the seeds. All quantity changes go through here;
 * products.stock follows automatically (database triggers, migration 0007).
 */
import type { DbAdapter } from '../db/adapter';
import type { BatchRow } from './fefo';

export type BatchSource = 'MIGRATION' | 'OPENING' | 'PURCHASE' | 'ADJUSTMENT' | 'VOID_RESTORE';

export interface NewBatch {
  productId: number;
  batchNumber?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  expiryRaw?: string | null;
  purchasePrice?: number;
  salePrice?: number;
  quantity: number;
  supplierId?: number | null;
  purchaseItemId?: number | null;
  source: BatchSource;
  tenantId?: number | null;
  createdBy?: number | null;
}

/** Thrown when a guarded stock update finds less stock than planned (always rolls the sale back). */
export class StockConflictError extends Error {
  constructor(readonly batchId: number, readonly wanted: number) {
    super(`Stock of batch #${batchId} changed while the sale was being saved; nothing was recorded.`);
    this.name = 'StockConflictError';
  }
}

export function assertWholeUnits(q: unknown, allowZero = false): number {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) throw new RangeError('Quantity must be a whole number greater than zero.');
  return n;
}

export function createBatch(db: DbAdapter, b: NewBatch): number {
  const qty = assertWholeUnits(b.quantity, true);
  return db.run(
    `INSERT INTO product_batches (product_id, batch_number, mfg_date, expiry_date, expiry_raw, purchase_price, sale_price, qty_received, qty_on_hand,
       supplier_id, purchase_item_id, source, tenant_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.productId, b.batchNumber || null, b.mfgDate || null, b.expiryDate || null, b.expiryRaw ?? b.expiryDate ?? null,
      Number(b.purchasePrice) || 0, Number(b.salePrice) || 0, qty, qty, b.supplierId ?? null, b.purchaseItemId ?? null, b.source, b.tenantId ?? null, b.createdBy ?? null],
  ).lastInsertRowid;
}

/** Remove units from one batch; refuses to go below zero (and the CHECK constraint would refuse too). */
export function takeFromBatch(db: DbAdapter, batchId: number, qty: number): void {
  const r = db.run('UPDATE product_batches SET qty_on_hand = qty_on_hand - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND qty_on_hand >= ?', [qty, batchId, qty]);
  if (r.changes !== 1) throw new StockConflictError(batchId, qty);
}

export function addToBatch(db: DbAdapter, batchId: number, qty: number): void {
  const r = db.run('UPDATE product_batches SET qty_on_hand = qty_on_hand + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [qty, batchId]);
  if (r.changes !== 1) throw new Error(`Batch #${batchId} not found`);
}

export function batchesFor(db: DbAdapter, productIds: number[]): Map<number, BatchRow[]> {
  const out = new Map<number, BatchRow[]>();
  for (const id of new Set(productIds)) {
    out.set(id, db.all<BatchRow>('SELECT id, product_id, batch_number, expiry_date, qty_on_hand, purchase_price FROM product_batches WHERE product_id = ? AND qty_on_hand > 0', [id]));
  }
  return out;
}

/** Problems with the stock bookkeeping ([] = consistent). Triggers make these impossible; this is a safety net. */
export function inventoryInvariantIssues(db: DbAdapter): string[] {
  const issues: string[] = [];
  for (const r of db.all<{ id: number; stock: number; s: number }>(
    'SELECT p.id, p.stock, COALESCE((SELECT SUM(qty_on_hand) FROM product_batches b WHERE b.product_id = p.id), 0) AS s FROM products p WHERE p.stock <> COALESCE((SELECT SUM(qty_on_hand) FROM product_batches b WHERE b.product_id = p.id), 0)',
  )) issues.push(`product #${r.id}: stock ${r.stock} but batches hold ${r.s}`);
  for (const r of db.all<{ id: number; q: number }>('SELECT id, qty_on_hand AS q FROM product_batches WHERE qty_on_hand < 0')) issues.push(`batch #${r.id} is negative (${r.q})`);
  for (const r of db.all<{ id: number; q: number; a: number }>(
    `SELECT si.id, si.quantity AS q, (SELECT SUM(quantity) FROM sale_item_batches x WHERE x.sale_item_id = si.id) AS a
     FROM sale_items si WHERE EXISTS (SELECT 1 FROM sale_item_batches x WHERE x.sale_item_id = si.id)
       AND si.quantity <> (SELECT SUM(quantity) FROM sale_item_batches x WHERE x.sale_item_id = si.id)`,
  )) issues.push(`sale line #${r.id}: quantity ${r.q} but batches record ${r.a}`);
  return issues;
}
