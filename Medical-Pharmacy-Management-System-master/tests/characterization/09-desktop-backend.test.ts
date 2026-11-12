/**
 * Phase 4 backend: first-run setup (C4), health, idempotent sales (C3), HTTPS with pinning,
 * host-mode pairing, LAN guard, local administration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, Api, RunningServer, cartItem, salePayload, makeTempDir, PORT } from '../helpers/server';
import { openReadOnly, one } from '../helpers/db';
import { generateCertificate } from '../../server/lan/tls';
import { pinnedJson, pairWithHost, probeCertificate, PinMismatchError } from '../../server/lan/pinnedClient';

const FRESH = { PHARMACY_TEST_LEGACY_SEED: '0' };

describe('first-run setup on a brand-new installation (C4)', () => {
  let srv: RunningServer;
  beforeAll(async () => { srv = await startServer({ env: FRESH }); });
  afterAll(async () => { await srv?.stop(); });

  it('a new database has no accounts, no demo data and no SUPER_ADMIN', async () => {
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM users WHERE is_placeholder = 0')).toEqual({ n: 0 });
    expect(one(db, 'SELECT COUNT(*) n FROM products')).toEqual({ n: 0 });
    expect(one(db, 'SELECT COUNT(*) n FROM sales_headers')).toEqual({ n: 0 });
    expect((await new Api().post('/auth/login', { username: 'admin', password: 'admin123' })).status).toBe(401);
    expect((await new Api().post('/auth/login', { username: 'superadmin', password: 'admin123' })).status).toBe(401);
    expect((await new Api().get('/setup/status')).body).toMatchObject({ needsSetup: true, storeName: null });
  });

  it('rejects weak passwords and invalid input; creates the admin once; refuses a second setup', async () => {
    const api = new Api();
    const base = { storeName: 'Al-Shifa Pharmacy', ownerName: 'Ayesha Khan', username: 'owner' };
    expect((await api.post('/setup/initial-admin', { ...base, password: 'password' })).status).toBe(400);
    expect((await api.post('/setup/initial-admin', { ...base, username: 'a b', password: 'Str0ngPass!' })).status).toBe(400);
    const ok = await api.post('/setup/initial-admin', { ...base, password: 'Str0ngPass!' });
    expect(ok.status).toBe(200);
    expect((await api.post('/setup/initial-admin', { ...base, username: 'second', password: 'Str0ngPass!' })).status).toBe(409);
    expect((await api.get('/setup/status')).body).toMatchObject({ needsSetup: false, storeName: 'Al-Shifa Pharmacy' });

    const user = await api.login('owner', 'Str0ngPass!');
    expect(user).toMatchObject({ role: 'ADMIN', tenant_id: 1, tenant_name: 'Al-Shifa Pharmacy', fullName: 'Ayesha Khan' });
    expect((await api.get('/inventory')).body).toEqual([]); // no demo data unless requested
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'SETUP_INITIAL_ADMIN'")).toEqual({ n: 1 });
    expect(one<any>(db, "SELECT value FROM settings WHERE key = 'smtp_enabled'")!.value).toBe('false');
    expect(one<any>(db, "SELECT password_hash FROM users WHERE username = 'owner'")!.password_hash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('first-run setup with the optional demo catalogue', () => {
  it('loads products/customers/sample sale but creates NO demo logins', async () => {
    const srv = await startServer({ env: FRESH });
    try {
      const api = new Api();
      expect((await api.post('/setup/initial-admin', { storeName: 'Demo Store', ownerName: 'Owner', username: 'owner', password: 'Str0ngPass!', loadDemoData: true })).status).toBe(200);
      await api.login('owner', 'Str0ngPass!');
      expect((await api.get('/inventory')).body).toHaveLength(12);
      expect((await api.get('/sales/history')).body).toHaveLength(1);
      for (const [u, pw] of [['admin', 'admin123'], ['staff', 'staff123'], ['03001234567', 'customer123'], ['superadmin', 'admin123']]) {
        expect((await new Api().post('/auth/login', { username: u, password: pw })).status, u).toBe(401);
      }
    } finally {
      await srv.stop();
    }
  });
});

describe('health and idempotent sales (C3)', () => {
  let srv: RunningServer;
  let admin: Api;
  beforeAll(async () => { srv = await startServer(); admin = new Api(); await admin.login('admin', 'admin123'); });
  afterAll(async () => { await srv?.stop(); });

  it('/api/health is public and reveals no secrets', async () => {
    const r = await new Api().get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', apiProtocol: 4, mode: 'legacy', db: { ok: true } });
    expect(Object.keys(r.body).sort()).toEqual(['apiProtocol', 'appVersion', 'db', 'mode', 'serverTime', 'status']);
  });

  it('the same client_txn_id records ONE sale; the retry returns the original result', async () => {
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 4); // stock 60
    const txn = crypto.randomUUID();
    const payload = salePayload([cartItem(p, 2)], { client_txn_id: txn, payment_method: 'UDHAR', customer_id: 2 });
    const a = await admin.post('/sales', payload);
    const b = await admin.post('/sales', payload);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.invoice_number).toBe(a.body.invoice_number);
    expect(b.body.sale_id).toBe(a.body.sale_id);
    expect((await admin.get('/inventory')).body.find((x: any) => x.id === 4).stock).toBe(58);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, 'SELECT COUNT(*) n FROM customer_ledger WHERE sale_id = ?', [a.body.sale_id])).toEqual({ n: 1 });
  });

  it('status lookup: committed vs not found', async () => {
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    const txn = crypto.randomUUID();
    expect((await admin.get(`/sales/by-txn/${txn}`)).status).toBe(404);
    const s = await admin.post('/sales', salePayload([cartItem(p, 1)], { client_txn_id: txn }));
    const look = await admin.get(`/sales/by-txn/${txn}`);
    expect(look.body).toMatchObject({ status: 'committed', invoice_number: s.body.invoice_number, sale_id: s.body.sale_id });
  });

  it('a failed sale stores no transaction id, so a corrected retry with the same id can succeed', async () => {
    const txn = crypto.randomUUID();
    const ghost = { id: 99999, name: 'Ghost', unit: 'Pack', sale_price: 10, purchase_price: 5, gst_rate: 0 };
    expect((await admin.post('/sales', salePayload([cartItem(ghost, 1)], { client_txn_id: txn }))).status).toBe(400); // Phase 6: validation
    expect((await admin.get(`/sales/by-txn/${txn}`)).status).toBe(404);
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)], { client_txn_id: txn }))).status).toBe(200);
  });

  it('rejects a malformed transaction id', async () => {
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)], { client_txn_id: 'x' }))).status).toBe(400);
  });

  it('local administration endpoints refuse requests without the local token', async () => {
    expect((await new Api().get('/local/host-status')).status).toBe(403);
  });
});

describe('HTTPS, pinning, host mode and pairing', () => {
  let cert: ReturnType<typeof generateCertificate>;
  let certDir: string;
  const LOCAL = 'local-token-' + crypto.randomBytes(16).toString('hex');
  beforeAll(() => {
    cert = generateCertificate({ commonName: 'test-host', hostnames: [os.hostname()] });
    certDir = makeTempDir();
    fs.writeFileSync(path.join(certDir, 'cert.pem'), cert.certPem);
    fs.writeFileSync(path.join(certDir, 'key.pem'), cert.keyPem);
  });
  const tlsEnv = () => ({ PHARMACY_TLS_CERT_FILE: path.join(certDir, 'cert.pem'), PHARMACY_TLS_KEY_FILE: path.join(certDir, 'key.pem') });

  it('refuses to listen on the network without TLS', async () => {
    await expect(startServer({ env: { PHARMACY_BIND: '0.0.0.0', PHARMACY_MODE: 'host' } })).rejects.toThrow(/Refusing to listen on 0\.0\.0\.0 without TLS/);
  });

  it('host mode: HTTPS only, pinned client works, wrong pin refused, non-private network address refused', async () => {
    const srv = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'host', PHARMACY_BIND: '0.0.0.0', PHARMACY_LOCAL_TOKEN: LOCAL } });
    try {
      expect(await probeCertificate('127.0.0.1', PORT)).toBe(cert.fingerprint);
      const health = await pinnedJson(`https://127.0.0.1:${PORT}/api/health`, cert.fingerprint);
      expect(health.body).toMatchObject({ status: 'ok', mode: 'host' });
      // plain HTTP on the same port does not work
      await expect(fetch(`http://127.0.0.1:${PORT}/api/health`)).rejects.toThrow();
      // a different pinned fingerprint (impostor) is refused before any data is sent
      await expect(pinnedJson(`https://127.0.0.1:${PORT}/api/health`, 'ab'.repeat(32))).rejects.toBeInstanceOf(PinMismatchError);

      // the container's real interface (192.0.2.2, TEST-NET-1) is NOT a private LAN range -> refused
      const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
      if (lanIp) {
        const r = await pinnedJson(`https://${lanIp}:${PORT}/api/health`, cert.fingerprint);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/local network/);
      }

      // local administration (loopback + token)
      const status = await pinnedJson(`https://127.0.0.1:${PORT}/api/local/host-status`, cert.fingerprint, { headers: { 'x-local-token': LOCAL } });
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ mode: 'host', fingerprint: cert.fingerprint, connectedClients: 0 });
      expect(status.body.pairing.code).toMatch(/^[A-Z2-9]{8}$/);
      expect((await pinnedJson(`https://127.0.0.1:${PORT}/api/local/host-status`, cert.fingerprint, { headers: { 'x-local-token': 'wrong' } })).status).toBe(403);

      // pairing: wrong code is detected by the CLIENT (host proof does not verify) - nothing is registered
      await expect(pairWithHost({ host: '127.0.0.1', port: PORT, code: 'WRONGCOD', clientName: 'Counter 2' })).rejects.toThrow(/code is wrong|intercepted/);
      // right code
      const paired = await pairWithHost({ host: '127.0.0.1', port: PORT, code: status.body.pairing.code, clientName: 'Counter 2' });
      expect(paired.fingerprint).toBe(cert.fingerprint);
      expect(paired.clientToken).toMatch(/^[0-9a-f]{64}$/);
      const after = await pinnedJson(`https://127.0.0.1:${PORT}/api/local/host-status`, cert.fingerprint, { headers: { 'x-local-token': LOCAL } });
      expect(after.body.clients.map((c: any) => c.name)).toEqual(['Counter 2']);

      const db = await openReadOnly(srv.dbFile);
      expect(one<any>(db, 'SELECT token_hash FROM paired_clients').token_hash).toBe(crypto.createHash('sha256').update(paired.clientToken).digest('hex'));
      expect(one(db, "SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'LAN_PAIR_SUCCESS'")).toEqual({ n: 1 });
      db.close();

      // revoke
      const rev = await pinnedJson(`https://127.0.0.1:${PORT}/api/local/clients/${after.body.clients[0].id}/revoke`, cert.fingerprint, { method: 'POST', headers: { 'x-local-token': LOCAL } });
      expect(rev.body).toEqual({ revoked: true });
    } finally {
      await srv.stop();
    }
  });

  it('a client pairing with an impostor certificate fails even with the right code', async () => {
    // impostor = a server with a different certificate that relays the real host's answers
    const real = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'host', PHARMACY_LOCAL_TOKEN: LOCAL } });
    const https = await import('node:https');
    const fake = generateCertificate({ commonName: 'impostor' });
    const proxy = https.createServer({ cert: fake.certPem, key: fake.keyPem }, async (req, res) => {
      const body = await new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
      const out = await pinnedJson(`https://127.0.0.1:${PORT}${req.url}`, cert.fingerprint, { method: req.method, headers: { 'Content-Type': 'application/json' }, body });
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    try {
      const code = (await pinnedJson(`https://127.0.0.1:${PORT}/api/local/host-status`, cert.fingerprint, { headers: { 'x-local-token': LOCAL } })).body.pairing.code;
      await expect(pairWithHost({ host: '127.0.0.1', port: (proxy.address() as any).port, code, clientName: 'victim' })).rejects.toThrow(/intercepted/);
    } finally {
      proxy.close();
      await real.stop();
    }
  });

  it('standalone mode bound to the network still refuses every non-loopback request', async () => {
    const srv = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'standalone', PHARMACY_BIND: '0.0.0.0' } });
    try {
      const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
      expect(lanIp).toBeTruthy();
      const r = await pinnedJson(`https://${lanIp}:${PORT}/api/health`, cert.fingerprint);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/standalone/);
      expect((await pinnedJson(`https://127.0.0.1:${PORT}/api/health`, cert.fingerprint)).status).toBe(200);
    } finally {
      await srv.stop();
    }
  });
});
