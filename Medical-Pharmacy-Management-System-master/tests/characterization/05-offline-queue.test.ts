/**
 * Characterisation: the frontend offline sales queue (src/lib/api.ts + BillingScreen.tsx).
 * Runs the real api.ts module in Node with an in-memory localStorage and a mocked fetch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  vi.resetModules();
  (globalThis as any).localStorage = new MemoryStorage();
});

describe('offline sales queue (api.ts)', () => {
  // C3 (was: re-posted with no idempotency key, so a sale the server already had was recorded twice)
  it('[FIXED C3] queued sales from the previous version are submitted with a stable transaction id', async () => {
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url === '/api/sales' && init.method === 'POST') {
        posted.push(JSON.parse(init.body));
        return new Response('upstream gone', { status: 503 }); // outcome unknown: stays queued
      }
      return new Response('{}', { status: 404 });
    }));
    const api = await import('../../src/lib/api');
    api.savePendingOfflineSale({ items: [{ product: { id: 1 }, quantity: 1 }], grand_total: 220, payment_method: 'CASH', amount_paid: 220 });
    await api.syncPendingOfflineSales();
    await api.syncPendingOfflineSales();
    expect(posted).toHaveLength(2);
    expect(posted[0].client_txn_id).toMatch(/^OFFLINE-\d+-\d+$/);
    expect(posted[1].client_txn_id).toBe(posted[0].client_txn_id); // same id on every attempt -> recorded at most once
  });

  it('a queued sale that the server rejects (e.g. 400) stays queued forever and is retried on every sync', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Cart must contain at least one item' }), { status: 400 })));
    const api = await import('../../src/lib/api');
    api.savePendingOfflineSale({ items: [] });
    for (let i = 0; i < 3; i++) expect(await api.syncPendingOfflineSales()).toEqual({ synced: 0, remaining: 1 });
  });

  it('draft cart is saved and restored from localStorage', async () => {
    const api = await import('../../src/lib/api');
    api.saveDraftCart([{ product: { id: 1 }, quantity: 2 } as any], 3, 5);
    expect(api.loadDraftCart()).toMatchObject({ customerId: 3, discountPercent: 5, cart: [{ quantity: 2 }] });
    api.clearDraftCart();
    expect(api.loadDraftCart()).toBeNull();
  });
});

describe('BillingScreen checkout (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/components/BillingScreen.tsx'), 'utf8');
  const block = src.slice(src.indexOf('const pendingTxnRef'), src.indexOf('// Filtered Products'));

  // C3 (was: ANY error queued the sale offline and showed a receipt with an OFFLINE-<timestamp> number)
  it('[FIXED C3] never queues sales offline and never shows a receipt before the server confirmed the sale', () => {
    expect(src).not.toMatch(/savePendingOfflineSale\(/);
    expect(src).not.toMatch(/OFFLINE-\$\{Date\.now/);
    expect(block).not.toMatch(/navigator\.onLine/);
    // the receipt is only produced from the server's saved sale
    expect(block).toMatch(/finishConfirmedSale = async \(saleId: number\)[\s\S]*api\.getSaleDetail\(saleId\)[\s\S]*setCompletedSale\(saleDetail\)/);
  });

  it('[FIXED C3] one transaction id per checkout; an unknown outcome keeps the cart and the same id for a safe retry', () => {
    expect(block).toMatch(/pendingTxnRef\.current = \{ id: newTxnId\(\), payload: salePayload \}/);
    expect(block).toMatch(/client_txn_id: pending\.id/);
    expect(block).toMatch(/err\.outcome === 'UNKNOWN'[\s\S]*setUnconfirmed\(\{ txnId: pending\.id/);
    expect(block).toMatch(/api\.getSaleByTxn\(pending\.id\)/);
    expect(src).toMatch(/SALE NOT CONFIRMED/);
  });

  it('USB scanner detection: keystrokes < 80 ms apart, Enter terminates, min length 3', () => {
    expect(src).toMatch(/timeDiff > 80/);
    expect(src).toMatch(/barcodeBufferRef\.current\.length >= 3/);
  });

  it('camera scanner uses html5-qrcode with the rear camera (no camera selection)', () => {
    expect(src).toMatch(/facingMode: 'environment'/);
    expect(src).not.toMatch(/getCameras\(/);
  });
});

describe('API error classification (api.ts)', () => {
  it('network failure and 502/503/504 mean "outcome unknown"; other errors are definite failures', async () => {
    const api = await import('../../src/lib/api');
    const cases: [() => Promise<Response>, number, string][] = [
      [async () => { throw new TypeError('fetch failed'); }, 0, 'UNKNOWN'],
      [async () => new Response(JSON.stringify({ error: 'host down', code: 'HOST_UNREACHABLE', outcome: 'UNKNOWN' }), { status: 503 }), 503, 'UNKNOWN'],
      [async () => new Response('bad gateway', { status: 502 }), 502, 'UNKNOWN'],
      [async () => new Response(JSON.stringify({ error: 'Cart must contain at least one item' }), { status: 400 }), 400, 'FAILED'],
      [async () => new Response(JSON.stringify({ error: 'FOREIGN KEY constraint failed' }), { status: 500 }), 500, 'FAILED'],
    ];
    for (const [impl, status, outcome] of cases) {
      vi.stubGlobal('fetch', vi.fn(impl));
      const err: any = await api.api.getSettings().catch((e) => e);
      expect(err).toBeInstanceOf(api.ApiError);
      expect([err.status, err.outcome]).toEqual([status, outcome]);
    }
  });
});
