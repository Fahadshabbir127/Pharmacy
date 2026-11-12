/**
 * FEFO (First Expiry, First Out) allocation - pure planning, no database access.
 *
 * Order: earliest expiry first, batches without expiry last (D5), then the oldest batch (lowest id).
 * Expired batches (D3) and empty batches are never used. Several cart lines for the same product
 * share one pool, so a cart can never take more than the product's sellable stock.
 * The plan is computed BEFORE any write; the caller applies it with guarded updates.
 */
import { isExpired } from './expiry';

export interface BatchRow {
  id: number;
  product_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  qty_on_hand: number;
  purchase_price: number;
}

export interface LineRequest {
  /** index of the cart line */
  line: number;
  productId: number;
  quantity: number;
}

export interface Allocation {
  batchId: number;
  quantity: number;
  unitCost: number;
  batchNumber: string | null;
  expiryDate: string | null;
}

export interface StockShortage {
  code: 'INSUFFICIENT_STOCK' | 'EXPIRED_STOCK';
  productId: number;
  requested: number;
  sellable: number;
  expired: number;
}

export type AllocationPlan =
  | { ok: true; lines: Map<number, Allocation[]> }
  | { ok: false; shortage: StockShortage };

export function fefoOrder(a: BatchRow, b: BatchRow): number {
  if (a.expiry_date && b.expiry_date && a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1;
  if (!a.expiry_date !== !b.expiry_date) return a.expiry_date ? -1 : 1; // dated before undated
  return a.id - b.id;
}

export function planFefo(lines: LineRequest[], batchesByProduct: Map<number, BatchRow[]>, on: string): AllocationPlan {
  // remaining sellable quantity per batch, shared across lines of the same product
  const pools = new Map<number, { batch: BatchRow; left: number }[]>();
  const expiredQty = new Map<number, number>();
  const requested = new Map<number, number>();
  for (const l of lines) requested.set(l.productId, (requested.get(l.productId) ?? 0) + l.quantity);

  for (const productId of requested.keys()) {
    const all = batchesByProduct.get(productId) ?? [];
    const usable = all.filter((b) => b.qty_on_hand > 0 && !isExpired(b.expiry_date, on)).sort(fefoOrder);
    pools.set(productId, usable.map((batch) => ({ batch, left: batch.qty_on_hand })));
    expiredQty.set(productId, all.filter((b) => b.qty_on_hand > 0 && isExpired(b.expiry_date, on)).reduce((s, b) => s + b.qty_on_hand, 0));
  }

  for (const [productId, want] of requested) {
    const sellable = pools.get(productId)!.reduce((s, p) => s + p.left, 0);
    if (sellable < want) {
      const expired = expiredQty.get(productId) ?? 0;
      return { ok: false, shortage: { code: sellable === 0 && expired > 0 ? 'EXPIRED_STOCK' : 'INSUFFICIENT_STOCK', productId, requested: want, sellable, expired } };
    }
  }

  const out = new Map<number, Allocation[]>();
  for (const l of lines) {
    let need = l.quantity;
    const allocs: Allocation[] = [];
    for (const p of pools.get(l.productId)!) {
      if (need === 0) break;
      if (p.left === 0) continue;
      const take = Math.min(need, p.left);
      p.left -= take;
      need -= take;
      allocs.push({ batchId: p.batch.id, quantity: take, unitCost: p.batch.purchase_price, batchNumber: p.batch.batch_number, expiryDate: p.batch.expiry_date });
    }
    out.set(l.line, allocs);
  }
  return { ok: true, lines: out };
}

/** Weighted average cost of a line's allocations (recorded as sale_items.cost_price, D6). */
export function weightedCost(allocs: Allocation[]): number {
  const qty = allocs.reduce((s, a) => s + a.quantity, 0);
  if (!qty) return 0;
  return Math.round((allocs.reduce((s, a) => s + a.quantity * a.unitCost, 0) / qty) * 10000) / 10000;
}
