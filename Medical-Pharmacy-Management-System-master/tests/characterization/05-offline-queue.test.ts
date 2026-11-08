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
  it('[CHANGE C3] sync re-posts queued sales with no idempotency key: a sale the server already committed is recorded twice', async () => {
    const committed: any[] = [];
    // Server that commits every POST /api/sales
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url === '/api/sales' && init.method === 'POST') {
        committed.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ sale_id: committed.length, invoice_number: `INV-1-${1000 + committed.length}` }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    const api = await import('../../src/lib/api');

    const sale = { items: [{ product: { id: 1 }, quantity: 1 }], grand_total: 220, payment_method: 'CASH', amount_paid: 220 };
    // 1st attempt reached the server and committed, but the response was lost (timeout) ...
    await api.api.createSale(sale as any);
    // ... so BillingScreen queued the same sale offline:
    api.savePendingOfflineSale(sale);
    expect(api.getPendingOfflineSales()).toHaveLength(1);

    const res = await api.syncPendingOfflineSales();
    expect(res).toEqual({ synced: 1, remaining: 0 });
    expect(committed).toHaveLength(2); // duplicate sale on the server
    expect(committed[0]).toEqual(committed[1]);
    expect(JSON.stringify(committed[1])).not.toMatch(/txn|idempot/i);
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

describe('BillingScreen fallback (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/components/BillingScreen.tsx'), 'utf8');

  it('[CHANGE C3/R1] ANY createSale error (not only network errors) queues the sale offline and shows a receipt', () => {
    const block = src.slice(src.indexOf('const handleProcessSale'), src.indexOf('const createLocalOfflineSaleDetail'));
    expect(block).toMatch(/catch \(apiErr: any\) \{[\s\S]*savePendingOfflineSale\(salePayload\);[\s\S]*createLocalOfflineSaleDetail/);
    expect(block).toMatch(/downloadSaleInvoiceFile\(saleDetail\)/);
    expect(block).toMatch(/setCompletedSale\(saleDetail\)/);
  });

  it('offline receipts use an OFFLINE-<timestamp> invoice number', () => {
    expect(src).toMatch(/invoice_number: `OFFLINE-\$\{Date\.now\(\)\.toString\(\)\.slice\(-6\)\}`/);
  });

  it('server reachability is judged by navigator.onLine (network adapter state)', () => {
    expect(src).toMatch(/if \(navigator\.onLine\)/);
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
