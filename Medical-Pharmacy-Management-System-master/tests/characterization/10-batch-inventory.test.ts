/**
 * Phase 6: batch inventory, FEFO allocation, expiry rules, no overselling.
 * The pharmacy date is fixed to 2026-06-01 by the test helper (PHARMACY_TEST_TODAY), so the
 * demo seed's batches are all sellable and expiry tests are repeatable.
 *
 * Seeded stock used here (one OPENING batch each):
 *   #1 Panadol  120  B-8910  2027-10-15  cost 180
 *   #2 Augmentin 45  AG-442  2026-11-20  cost 310
 *   #6 Calamox    8  CX-771  2026-08-15  cost 290
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, Api, RunningServer, cartItem, salePayload, makeTempDir, PORT } from '../helpers/server';
import { openReadOnly, one, all, integrityCheck } from '../helpers/db';
import { DbAdapter } from '../../server/db/adapter';
import { inventoryInvariantIssues } from '../../server/inventory/batches';
import { generateCertificate } from '../../server/lan/tls';
import { pinnedJson, pairWithHost } from '../../server/lan/pinnedClient';

let srv: RunningServer;
let admin: Api;

const product = async (id: number) => (await admin.get('/inventory')).body.find((p: any) => p.id === id);
const batches = async (id: number, includeEmpty = false) => (await admin.get(`/inventory/${id}/batches${includeEmpty ? '?include_empty=true' : ''}`)).body.batches as any[];
const invariants = (dbFile: string) => {
  const db = DbAdapter.open(dbFile, { readonly: true });
  try { return inventoryInvariantIssues(db); } finally { db.close(); }
};
/** Adds a batch through the ADD adjustment (the only way to record already-expired stock). */
const addBatch = (productId: number, quantity: number, batch_number: string, expiry_date: string | null, extra: Record<string, unknown> = {}) =>
  admin.post('/inventory/adjust', { product_id: productId, adjustment_type: 'ADD', quantity, reason: 'test stock', reason_code: 'COUNT_CORRECTION', batch_number, expiry_date, ...extra });

describe('API (legacy demo seed, today = 2026-06-01)', () => {
  beforeEach(async () => {
    srv = await startServer();
    admin = new Api();
    await admin.login('admin', 'admin123');
  });
  afterEach(async () => { await srv?.stop(); });

  it('the demo seed is stored as one batch per product and the inventory list carries the batch summary', async () => {
    const p = await product(1);
    expect(p).toMatchObject({ stock: 120, sellable_stock: 120, expired_stock: 0, batch_count: 1, batch_number: 'B-8910', expiry_date: '2027-10-15', next_expiry: '2027-10-15' });
    expect(await batches(1)).toEqual([expect.objectContaining({ batch_number: 'B-8910', qty_on_hand: 120, source: 'OPENING', status: 'OK', sellable: true })]);
    expect(invariants(srv.dbFile)).toEqual([]);
    // the test-only date override is announced loudly at startup
    expect(srv.logs()).toMatch(/WARNING: PHARMACY_TEST_TODAY=2026-06-01 is set/);
  });

  it('FEFO: a sale is taken from the earliest-expiring batch first and can span several batches', async () => {
    const pur = await admin.post('/purchases', { supplier_id: 1, items: [{ product_id: 1, quantity: 5, purchase_price: 150, sale_price: 220, batch_number: 'B-EARLY', expiry_date: '2026-12-31', mfg_date: '2026-01-10' }] });
    expect(pur.status).toBe(200);
    // the product now shows the batch that will be sold next
    expect(await product(1)).toMatchObject({ stock: 125, batch_number: 'B-EARLY', expiry_date: '2026-12-31', batch_count: 2 });

    const r = await admin.post('/sales', salePayload([cartItem(await product(1), 8)]));
    expect(r.status).toBe(200);
    expect(r.body.allocations[0].batches).toEqual([
      expect.objectContaining({ batch_number: 'B-EARLY', quantity: 5 }),
      expect.objectContaining({ batch_number: 'B-8910', quantity: 3 }),
    ]);
    const detail = (await admin.get(`/sales/${r.body.sale_id}`)).body.items[0];
    expect(detail).toMatchObject({ quantity: 8, batch_number: 'B-EARLY, B-8910', expiry_date: '2026-12-31', sale_price: 220 });
    expect(detail.cost_price).toBeCloseTo((5 * 150 + 3 * 180) / 8, 6); // D6: real batch cost, weighted
    expect(detail.batches.map((b: any) => [b.batch_number, b.quantity])).toEqual([['B-EARLY', 5], ['B-8910', 3]]);

    const after = await batches(1, true);
    expect(after.map((b: any) => [b.batch_number, b.qty_on_hand, b.status])).toEqual([['B-EARLY', 0, 'EMPTY'], ['B-8910', 117, 'OK']]);
    expect((await product(1)).stock).toBe(117);
    expect(invariants(srv.dbFile)).toEqual([]);
  });

  it('the same product on two cart lines draws from one shared pool (no double counting)', async () => {
    const p = await product(6); // 8 units
    expect((await admin.post('/sales', salePayload([cartItem(p, 5), cartItem(p, 4)]))).status).toBe(409);
    const ok = await admin.post('/sales', salePayload([cartItem(p, 5), cartItem(p, 3)]));
    expect(ok.status).toBe(200);
    expect((await product(6)).stock).toBe(0);
  });

  it('expiry rule D3: sellable up to and including the expiry date; a month-only expiry means the last day of that month', async () => {
    const { body: created } = await admin.post('/inventory', { name: 'Expiry Probe', unit: 'Pack', purchase_price: 10, sale_price: 20 });
    const id = created.id;
    expect((await addBatch(id, 3, 'EXP-YESTERDAY', '2026-05-31')).status).toBe(200);
    expect((await addBatch(id, 2, 'EXP-MAY', '2026-05')).status).toBe(200);   // = 2026-05-31: expired
    expect((await addBatch(id, 4, 'EXP-TODAY', '2026-06-01')).status).toBe(200);
    expect((await addBatch(id, 1, 'EXP-JUNE', '06/2026')).status).toBe(200); // = 2026-06-30: sellable

    const list = await batches(id);
    expect(list.map((b: any) => [b.batch_number, b.expiry_date, b.status])).toEqual([
      ['EXP-YESTERDAY', '2026-05-31', 'EXPIRED'], ['EXP-MAY', '2026-05-31', 'EXPIRED'],
      ['EXP-TODAY', '2026-06-01', 'EXPIRING_SOON'], ['EXP-JUNE', '2026-06-30', 'EXPIRING_SOON'],
    ]);
    expect(await product(id)).toMatchObject({ stock: 10, sellable_stock: 5, expired_stock: 5, batch_number: 'EXP-TODAY' });

    const tooMany = await admin.post('/sales', salePayload([cartItem(await product(id), 6)]));
    expect(tooMany.status).toBe(409);
    expect(tooMany.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', requested: 6, available: 5, expired: 5 });
    expect(tooMany.body.error).toMatch(/5 more unit\(s\) are expired/);

    const r = await admin.post('/sales', salePayload([cartItem(await product(id), 5)]));
    expect(r.status).toBe(200);
    expect(r.body.allocations[0].batches.map((b: any) => [b.batch_number, b.quantity])).toEqual([['EXP-TODAY', 4], ['EXP-JUNE', 1]]);

    // only expired stock left
    const expiredOnly = await admin.post('/sales', salePayload([cartItem(await product(id), 1)]));
    expect(expiredOnly.status).toBe(409);
    expect(expiredOnly.body).toMatchObject({ code: 'EXPIRED_STOCK', available: 0, expired: 5 });
    expect((await product(id)).stock).toBe(5);

    // write the expired units off, per batch
    const exp = (await batches(id)).find((b: any) => b.batch_number === 'EXP-MAY');
    expect((await admin.post('/inventory/adjust', { product_id: id, batch_id: exp.id, adjustment_type: 'REMOVE', quantity: 2, reason: 'expired', reason_code: 'EXPIRED' })).status).toBe(200);
    expect((await product(id)).stock).toBe(3);
    expect(invariants(srv.dbFile)).toEqual([]);
  });

  it('D5: a batch without expiry is sellable but sold after every dated batch', async () => {
    const { body: created } = await admin.post('/inventory', { name: 'Bandage', unit: 'Roll', purchase_price: 5, sale_price: 9 });
    await addBatch(created.id, 2, 'NO-EXP', null);
    await addBatch(created.id, 2, 'DATED', '2027-01-31');
    expect((await batches(created.id)).map((b: any) => [b.batch_number, b.status])).toEqual([['DATED', 'OK'], ['NO-EXP', 'NO_EXPIRY']]);
    const r = await admin.post('/sales', salePayload([cartItem(await product(created.id), 3)]));
    expect(r.body.allocations[0].batches.map((b: any) => [b.batch_number, b.quantity])).toEqual([['DATED', 2], ['NO-EXP', 1]]);
  });

  it('a refused sale writes nothing: no header, no line, no ledger, no stock change, no idempotency key', async () => {
    const db0 = await openReadOnly(srv.dbFile);
    const before = { h: one<any>(db0, 'SELECT COUNT(*) n FROM sales_headers').n, l: one<any>(db0, 'SELECT COUNT(*) n FROM customer_ledger').n };
    db0.close();
    const txn = crypto.randomUUID();
    const p6 = await product(6);
    const r = await admin.post('/sales', salePayload([cartItem(await product(1), 1), cartItem(p6, 9)], { payment_method: 'UDHAR', customer_id: 2, client_txn_id: txn }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', product_id: 6, product_name: p6.name });
    const db = await openReadOnly(srv.dbFile);
    expect(one<any>(db, 'SELECT COUNT(*) n FROM sales_headers').n).toBe(before.h);
    expect(one<any>(db, 'SELECT COUNT(*) n FROM customer_ledger').n).toBe(before.l);
    expect(one(db, 'SELECT COUNT(*) n FROM sale_item_batches')).toEqual({ n: 0 });
    expect(one(db, 'SELECT stock FROM products WHERE id = 1')).toEqual({ stock: 120 });
    db.close();
    expect((await admin.get(`/sales/by-txn/${txn}`)).status).toBe(404);
  });

  it('rejects fractional, zero and negative quantities and archived products (400)', async () => {
    const p = await product(1);
    for (const q of [0, -2, 1.5]) expect((await admin.post('/sales', salePayload([cartItem(p, q)]))).status).toBe(400);
    const { body: c } = await admin.post('/inventory', { name: 'To Archive', unit: 'Pack', sale_price: 5, stock: 3 });
    const tp = await product(c.id);
    expect((await admin.post('/sales', salePayload([cartItem(tp, 1)]))).status).toBe(200); // history -> archived on delete
    expect((await admin.del(`/inventory/${c.id}`)).body.archived).toBe(true);
    const r = await admin.post('/sales', salePayload([cartItem(tp, 1)]));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PRODUCT_ARCHIVED');
  });

  it('idempotent replay (same client_txn_id) returns the first sale and does not take stock twice', async () => {
    const txn = crypto.randomUUID();
    const payload = salePayload([cartItem(await product(1), 4)], { client_txn_id: txn });
    const a = await admin.post('/sales', payload);
    const b = await admin.post('/sales', payload);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.sale_id).toBe(a.body.sale_id);
    expect((await product(1)).stock).toBe(116);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n, SUM(quantity) q FROM sale_item_batches')).toEqual({ n: 1, q: 4 });
    db.close();
  });

  it('void returns the units to the exact batches they came from', async () => {
    await admin.post('/purchases', { supplier_id: 1, items: [{ product_id: 1, quantity: 5, purchase_price: 150, batch_number: 'B-EARLY', expiry_date: '2026-12-31' }] });
    const s = await admin.post('/sales', salePayload([cartItem(await product(1), 8)], { payment_method: 'UDHAR', customer_id: 3 }));
    expect((await batches(1)).map((b: any) => [b.batch_number, b.qty_on_hand])).toEqual([['B-8910', 117]]);
    expect((await admin.del(`/sales/${s.body.sale_id}`)).status).toBe(200);
    expect((await batches(1)).map((b: any) => [b.batch_number, b.qty_on_hand])).toEqual([['B-EARLY', 5], ['B-8910', 120]]);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM sale_item_batches')).toEqual({ n: 0 });
    db.close();
    expect(invariants(srv.dbFile)).toEqual([]);
  });

  it('voiding a sale recorded before batch tracking puts its units into a VOID_RESTORE batch built from the line', async () => {
    // seeded INV-1001: Panadol x2 (B-8910, 2027-10-15) and Augmentin x5 (AG-442, 2026-11-20), no batch allocation
    expect((await admin.del('/sales/1')).status).toBe(200);
    const p1 = await batches(1);
    expect(p1.map((b: any) => [b.batch_number, b.expiry_date, b.qty_on_hand, b.source])).toEqual([
      ['B-8910', '2027-10-15', 120, 'OPENING'], ['B-8910', '2027-10-15', 2, 'VOID_RESTORE'],
    ]);
    expect((await product(2)).stock).toBe(50);
    expect(invariants(srv.dbFile)).toEqual([]);
  });

  it('purchases: validation happens before anything is written', async () => {
    const bad = [
      [{ product_id: 1, quantity: 0, purchase_price: 1 }, /quantity/i],
      [{ product_id: 1, quantity: 2.5, purchase_price: 1 }, /quantity/i],
      [{ product_id: 1, quantity: 1, purchase_price: -1 }, /price/i],
      [{ product_id: 1, quantity: 1, purchase_price: 1, expiry_date: '2026-05-31' }, /expired/i],
      [{ product_id: 1, quantity: 1, purchase_price: 1, expiry_date: '31/31/2027' }, /not a valid date/i],
      [{ product_id: 1, quantity: 1, purchase_price: 1, mfg_date: '2026-07-01', expiry_date: '2028-01-01' }, /future/i],
      [{ product_id: 1, quantity: 1, purchase_price: 1, mfg_date: '2028-02-01', expiry_date: '2028-01-01' }, /future|before/i],
      [{ product_id: 99999, quantity: 1, purchase_price: 1 }, /not found|does not exist/i],
    ] as const;
    for (const [line, msg] of bad) {
      const r = await admin.post('/purchases', { supplier_id: 1, items: [{ product_id: 2, quantity: 1, purchase_price: 1 }, line] });
      expect(r.status, JSON.stringify(line)).toBe(400);
      expect(r.body.error, JSON.stringify(line)).toMatch(msg);
    }
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM purchase_headers')).toEqual({ n: 0 });
    expect(one(db, 'SELECT COUNT(*) n FROM purchase_items')).toEqual({ n: 0 });
    expect(one(db, 'SELECT COUNT(*) n FROM product_batches')).toEqual({ n: 12 });
    db.close();
  });

  it('a purchase stores batch, mfg date, expiry and prices per line and links the line to its batch', async () => {
    const r = await admin.post('/purchases', { supplier_id: 2, invoice_number: 'SUP-77', items: [
      { product_id: 3, quantity: 10, purchase_price: 130, sale_price: 170, batch_number: 'BF-200', mfg_date: '2026-03-01', expiry_date: '2028-02' },
      { product_id: 3, quantity: 6, purchase_price: 132, batch_number: 'BF-201', expiry_date: '2027-12-31' },
    ] });
    expect(r.status).toBe(200);
    const list = await batches(3);
    expect(list.map((b: any) => [b.batch_number, b.expiry_date, b.mfg_date, b.purchase_price, b.qty_on_hand, b.source, b.supplier_id])).toEqual([
      ['BF-109', '2027-04-10', null, 140, 80, 'OPENING', 2],
      ['BF-201', '2027-12-31', null, 132, 6, 'PURCHASE', 2],
      ['BF-200', '2028-02-29', '2026-03-01', 130, 10, 'PURCHASE', 2],
    ]);
    const db = await openReadOnly(srv.dbFile);
    expect(all(db, 'SELECT pi.batch_id = b.id AS linked, pi.mfg_date, pi.sale_price FROM purchase_items pi JOIN product_batches b ON b.purchase_item_id = pi.id ORDER BY pi.id')).toEqual([
      { linked: 1, mfg_date: '2026-03-01', sale_price: 170 }, { linked: 1, mfg_date: null, sale_price: 175 }, // no sale price given: the product's
    ]);
    db.close();
    const hist = (await admin.get(`/batches/${list[2].id}/history`)).body;
    expect(hist.events[0]).toMatchObject({ type: 'PURCHASE', quantity: 10, reference: { invoice_number: 'SUP-77' } });
  });

  it('D1: editing a product cannot change its stock; other fields still save', async () => {
    const p = await product(1);
    const r = await admin.put('/inventory/1', { ...p, stock: 500 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STOCK_NOT_EDITABLE');
    expect((await admin.put('/inventory/1', { ...p, sale_price: 230 })).status).toBe(200);
    expect(await product(1)).toMatchObject({ stock: 120, sale_price: 230 });
  });

  it('batch corrections: ADMIN only, a reason is required, quantity cannot be edited, the change is audited', async () => {
    const b = (await batches(1))[0];
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.put(`/batches/${b.id}`, { batch_number: 'X', reason: 'typo' })).status).toBe(403);
    expect((await admin.put(`/batches/${b.id}`, { batch_number: 'B-8911' })).status).toBe(400);
    expect((await admin.put(`/batches/${b.id}`, { qty_on_hand: 999, reason: 'x' })).status).toBe(400);
    expect((await admin.put(`/batches/${b.id}`, { expiry_date: 'soon', reason: 'x' })).status).toBe(400);
    const ok = await admin.put(`/batches/${b.id}`, { batch_number: 'B-8911', expiry_date: '2027-11-30', reason: 'typo on label' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ batch_number: 'B-8911', expiry_date: '2027-11-30', qty_on_hand: 120 });
    const db = await openReadOnly(srv.dbFile);
    expect(one<any>(db, "SELECT description FROM audit_logs WHERE action_type = 'BATCH_CORRECTION'").description).toMatch(/B-8910 -> B-8911.*typo on label/);
    db.close();
  });

  it('stock adjustments are per batch; ADD to an existing batch; history lists purchase, sale and adjustment', async () => {
    const b = (await batches(6))[0];
    expect((await admin.post('/inventory/adjust', { product_id: 6, batch_id: b.id, adjustment_type: 'ADD', quantity: 2, reason: 'found', reason_code: 'COUNT_CORRECTION' })).body).toMatchObject({ stock: 10, batch_id: b.id, batch_qty: 10 });
    expect((await admin.post('/inventory/adjust', { product_id: 6, batch_id: b.id, adjustment_type: 'REMOVE', quantity: 1, reason: 'x', reason_code: 'NOPE' })).status).toBe(400);
    await admin.post('/sales', salePayload([cartItem(await product(6), 3)]));
    const hist = (await admin.get(`/batches/${b.id}/history`)).body;
    // events are ordered by time (to the second; same-second events may appear in either order)
    expect(hist.events[0]).toMatchObject({ type: 'OPENING', quantity: 8 });
    expect(hist.events.map((e: any) => [e.type, e.quantity]).slice(1).sort()).toEqual([['ADJUSTMENT', 2], ['SALE', -3]]);
    expect(hist.events.reduce((s: number, e: any) => s + e.quantity, 0)).toBe(hist.batch.qty_on_hand);
  });

  it('expiry report and dashboard count batches, including expired ones', async () => {
    const { body: c } = await admin.post('/inventory', { name: 'Old Stock', unit: 'Pack', purchase_price: 7, sale_price: 10 });
    await addBatch(c.id, 4, 'OLD-1', '2026-03-31');
    const rep = (await admin.get('/inventory/expiry-report?days=90')).body;
    expect(rep.today).toBe('2026-06-01');
    expect(rep.expired.map((b: any) => [b.product_name, b.batch_number, b.qty_on_hand])).toEqual([['Old Stock', 'OLD-1', 4]]);
    expect(rep.totals).toEqual({ expiredUnits: 4, expiredValue: 28 });
    // demo batches expiring by 2026-08-30: Cac 1000 (2026-08-01), Calamox (2026-08-15)
    expect(rep.expiring.map((b: any) => b.batch_number)).toEqual(['CAC-33', 'CX-771']);
    const dash = (await admin.get('/reports/dashboard')).body;
    expect(dash).toMatchObject({ expiredBatchCount: 1, expiredUnits: 4 });
    expect(dash.expiringCount).toBeGreaterThanOrEqual(3);
  });

  it('deleting a product with stock but no history removes its batches with it', async () => {
    const { body: c } = await admin.post('/inventory', { name: 'Gone', unit: 'Pack', sale_price: 5, stock: 7, batch_number: 'G-1', expiry_date: '2028-01-01' });
    expect((await batches(c.id)).map((b: any) => [b.batch_number, b.qty_on_hand, b.source])).toEqual([['G-1', 7, 'OPENING']]);
    expect((await admin.del(`/inventory/${c.id}`)).status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, `SELECT COUNT(*) n FROM product_batches WHERE product_id = ${c.id}`)).toEqual({ n: 0 });
    db.close();
  });
});

describe('concurrency over HTTPS (host mode, several paired clients)', () => {
  let cert: ReturnType<typeof generateCertificate>;
  let certDir: string;
  const LOCAL = 'local-token-' + crypto.randomBytes(16).toString('hex');
  beforeAll(() => {
    cert = generateCertificate({ commonName: 'test-host', hostnames: [os.hostname()] });
    certDir = makeTempDir();
    fs.writeFileSync(path.join(certDir, 'cert.pem'), cert.certPem);
    fs.writeFileSync(path.join(certDir, 'key.pem'), cert.keyPem);
  });

  it('50 simultaneous sales racing for the last 12 units of two batches: never oversold, stock never below 0', async () => {
    const host = await startServer({ tlsPin: cert.fingerprint, env: { PHARMACY_TLS_CERT_FILE: path.join(certDir, 'cert.pem'), PHARMACY_TLS_KEY_FILE: path.join(certDir, 'key.pem'), PHARMACY_MODE: 'host', PHARMACY_LOCAL_TOKEN: LOCAL } });
    try {
      const url = (p: string) => `https://127.0.0.1:${PORT}/api${p}`;
      const call = (method: string, p: string, token: string, clientToken: string | null, body?: unknown) =>
        pinnedJson(url(p), cert.fingerprint, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(clientToken ? { 'x-braintech-client': clientToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

      // three paired counters
      const clientTokens: string[] = [];
      for (const name of ['Counter 1', 'Counter 2', 'Counter 3']) {
        const code = (await pinnedJson(url('/local/host-status'), cert.fingerprint, { headers: { 'x-local-token': LOCAL } })).body.pairing.code;
        clientTokens.push((await pairWithHost({ host: '127.0.0.1', port: PORT, code, clientName: name })).clientToken);
        await pinnedJson(url('/local/pairing/rotate'), cert.fingerprint, { method: 'POST', headers: { 'x-local-token': LOCAL } });
      }
      const login = async (u: string, pw: string) => (await pinnedJson(url('/auth/login'), cert.fingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) })).body.token as string;
      const tokens = [await login('admin', 'admin123'), await login('staff', 'staff123')];

      // product #6 Calamox: 8 units (CX-771, 2026-08-15) + 4 units bought now (CX-900, 2027-01-31) = 12
      expect((await call('POST', '/purchases', tokens[0], null, { supplier_id: 2, items: [{ product_id: 6, quantity: 4, purchase_price: 300, batch_number: 'CX-900', expiry_date: '2027-01-31' }] })).status).toBe(200);
      const p = (await call('GET', '/inventory', tokens[0], null)).body.find((x: any) => x.id === 6);
      expect(p.stock).toBe(12);
      // the startup inventory check is shown on the host status (nothing to report on a clean database)
      const hs = (await pinnedJson(url('/local/host-status'), cert.fingerprint, { headers: { 'x-local-token': LOCAL } })).body;
      expect(hs.apiProtocol).toBe(2);
      expect(hs.inventory).toMatchObject({ issues: [], migrationIssues: 0, testDateOverride: '2026-06-01' });

      const qty = (i: number) => 1 + (i % 3); // 1,2,3,1,2,3,... asks for ~100 units in total
      const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
        call('POST', '/sales', tokens[i % 2], i % 4 === 3 ? null : clientTokens[i % 3], salePayload([cartItem(p, qty(i))], { client_txn_id: crypto.randomUUID() }))
          .then((r) => ({ i, status: r.status, body: r.body }))));

      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 409);
      expect(ok.length + refused.length).toBe(50); // no 500s
      for (const r of refused) expect(r.body.code).toBe('INSUFFICIENT_STOCK');
      const sold = ok.reduce((s, r) => s + qty(r.i), 0);
      expect(sold).toBeLessThanOrEqual(12);
      expect(sold).toBeGreaterThanOrEqual(10); // once fewer than 3 units remain, only small requests can still fit
      expect(new Set(ok.map((r) => r.body.invoice_number)).size).toBe(ok.length);

      const db = await openReadOnly(host.dbFile);
      expect(one(db, 'SELECT stock FROM products WHERE id = 6')).toEqual({ stock: 12 - sold });
      expect(one(db, 'SELECT MIN(qty_on_hand) m FROM product_batches')).toEqual({ m: 0 });
      expect(one(db, 'SELECT COALESCE(SUM(x.quantity), 0) q FROM sale_item_batches x JOIN sale_items si ON si.id = x.sale_item_id WHERE si.product_id = 6')).toEqual({ q: sold });
      // FEFO across the race: the earlier batch is used up before the later one is touched
      const cx771 = one<any>(db, "SELECT qty_on_hand q FROM product_batches WHERE batch_number = 'CX-771'").q;
      const cx900 = one<any>(db, "SELECT qty_on_hand q FROM product_batches WHERE batch_number = 'CX-900'").q;
      expect(cx900 < 4 ? cx771 : 0).toBe(0);
      expect(integrityCheck(db)).toEqual([]);
      db.close();
      expect(invariants(host.dbFile)).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});

describe('crash during a multi-batch sale (SIGKILL)', () => {
  for (const point of ['before-commit', 'after-commit'] as const) {
    it(`${point}: batches, allocations, product stock and the customer ledger stay consistent`, async () => {
      const seed = await startServer();
      const workDir = seed.workDir;
      const a = new Api();
      await a.login('admin', 'admin123');
      expect((await a.post('/purchases', { supplier_id: 1, items: [{ product_id: 1, quantity: 5, purchase_price: 150, batch_number: 'B-EARLY', expiry_date: '2026-12-31' }] })).status).toBe(200);
      const p = (await a.get('/inventory')).body.find((x: any) => x.id === 1);
      await seed.stop();

      const srv2 = await startServer({ workDir, env: { PHARMACY_TEST_CRASH: `${point}:POST /api/sales` } });
      const b = new Api();
      await b.login('admin', 'admin123');
      let answered = false;
      await b.post('/sales', salePayload([cartItem(p, 8)], { payment_method: 'UDHAR', customer_id: 2 })).then(() => { answered = true; }, () => {});
      await srv2.kill();
      expect(answered).toBe(false);

      const again = await startServer({ workDir });
      try {
        const db = await openReadOnly(again.dbFile);
        const state = {
          stock: one<any>(db, 'SELECT stock s FROM products WHERE id = 1').s,
          early: one<any>(db, "SELECT qty_on_hand q FROM product_batches WHERE batch_number = 'B-EARLY'").q,
          main: one<any>(db, "SELECT qty_on_hand q FROM product_batches WHERE batch_number = 'B-8910'").q,
          allocations: one<any>(db, 'SELECT COUNT(*) n FROM sale_item_batches').n,
          ledger: one<any>(db, 'SELECT COUNT(*) n FROM customer_ledger WHERE debit = 1760').n,
        };
        expect(state).toEqual(point === 'before-commit'
          ? { stock: 125, early: 5, main: 120, allocations: 0, ledger: 0 }
          : { stock: 117, early: 0, main: 117, allocations: 2, ledger: 1 });
        expect(integrityCheck(db)).toEqual([]);
        db.close();
        expect(invariants(again.dbFile)).toEqual([]);
        // the restarted server sells normally from the right batch
        const c = new Api();
        await c.login('admin', 'admin123');
        expect((await c.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(200);
      } finally {
        await again.stop();
      }
    });
  }
});
