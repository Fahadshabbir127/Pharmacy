/**
 * LAN guard decisions (with simulated source addresses) and pairing primitives.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lanGuard } from '../../server/lan/guard';
import { PairingManager, clientProof, hostProof, generatePairingCode, hashToken, normalizeCode } from '../../server/lan/pairing';
import { isPrivateLan, isLoopback } from '../../server/config';
import { DbAdapter } from '../../server/db/adapter';
import { lanAndIdempotency } from '../../server/db/migrations/0006_lan_and_idempotency';
import { generateCertificate, certificateFingerprint, shortFingerprint } from '../../server/lan/tls';
import { loadOrCreateJwtSecret } from '../../server/security/jwtSecret';

function run(mw: any, ip: string, p: string, headers: Record<string, string> = {}) {
  let status = 200;
  let body: any = null;
  let passed = false;
  const req: any = { socket: { remoteAddress: ip }, path: p, get: (h: string) => headers[h.toLowerCase()] };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; return res; } };
  mw(req, res, () => { passed = true; });
  return { passed, status, body, req };
}

describe('address classification', () => {
  it('loopback and private ranges', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true);
    for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20', '::ffff:192.168.0.9', '169.254.3.4', 'fd00::1', 'fe80::1']) expect(isPrivateLan(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '192.0.2.2', '100.64.0.1', '2001:4860::8888', '']) expect(isPrivateLan(a), a).toBe(false);
  });
});

describe('lanGuard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const db = DbAdapter.open(path.join(dir, 'g.sqlite'));
  lanAndIdempotency.up(db);
  const token = crypto.randomBytes(32).toString('hex');
  const revoked = crypto.randomBytes(32).toString('hex');
  db.run("INSERT INTO paired_clients (client_id, name, token_hash, created_at) VALUES ('a', 'Counter', ?, 'x')", [hashToken(token)]);
  db.run("INSERT INTO paired_clients (client_id, name, token_hash, created_at, revoked_at) VALUES ('b', 'Old', ?, 'x', 'y')", [hashToken(revoked)]);
  const host = lanGuard({ mode: () => 'host', db: () => db });
  const standalone = lanGuard({ mode: () => 'standalone', db: () => db });

  it('loopback always passes', () => {
    expect(run(host, '127.0.0.1', '/api/inventory').passed).toBe(true);
    expect(run(standalone, '::1', '/api/inventory').passed).toBe(true);
  });
  it('standalone refuses any non-loopback address', () => {
    expect(run(standalone, '192.168.1.5', '/api/health').status).toBe(403);
  });
  it('host refuses public addresses even for health/pairing', () => {
    expect(run(host, '8.8.8.8', '/api/health').status).toBe(403);
    expect(run(host, '8.8.8.8', '/api/pair/start').status).toBe(403);
  });
  it('host allows health and pairing from the LAN without a client token', () => {
    expect(run(host, '192.168.1.5', '/api/health').passed).toBe(true);
    expect(run(host, '192.168.1.5', '/api/pair/start').passed).toBe(true);
    expect(run(host, '192.168.1.5', '/api/pair/complete').passed).toBe(true);
  });
  it('host requires a valid, unrevoked client token for everything else', () => {
    expect(run(host, '192.168.1.5', '/api/auth/login').status).toBe(401);
    expect(run(host, '192.168.1.5', '/api/auth/login', { 'x-braintech-client': 'nope' }).status).toBe(401);
    expect(run(host, '192.168.1.5', '/api/auth/login', { 'x-braintech-client': revoked }).body.code).toBe('NOT_PAIRED');
    const ok = run(host, '192.168.1.5', '/api/auth/login', { 'x-braintech-client': token });
    expect(ok.passed).toBe(true);
    expect(ok.req.pairedClientId).toBe(1);
    expect(db.get<any>('SELECT last_ip FROM paired_clients WHERE id = 1').last_ip).toBe('192.168.1.5');
  });
  it('/api/local/* is not reachable from the LAN even with a client token (guard passes, route checks loopback)', () => {
    // documented: requireLocal() in server.ts additionally demands loopback + local token
    expect(run(host, '192.168.1.5', '/api/local/host-status').status).toBe(401);
  });
});

describe('pairing primitives', () => {
  it('codes use an unambiguous alphabet and normalise case/spaces', () => {
    for (let i = 0; i < 50; i++) expect(generatePairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizeCode(' ab-cd ef12 ')).toBe('ABCDEF12');
  });
  it('host proof binds the certificate fingerprint; client proof binds both nonces', () => {
    const fp = 'aa'.repeat(32);
    expect(hostProof('ABCDEFGH', 'c1', 's1', fp)).not.toBe(hostProof('ABCDEFGH', 'c1', 's1', 'bb'.repeat(32)));
    expect(hostProof('ABCDEFGH', 'c1', 's1', fp)).not.toBe(hostProof('ABCDEFGX', 'c1', 's1', fp));
    expect(clientProof('ABCDEFGH', 's1', 'c1')).not.toBe(clientProof('ABCDEFGH', 's1', 'c2'));
  });
  it('manager: correct proof accepted once; session cannot be replayed; 5 failures rotate the code', () => {
    const pm = new PairingManager();
    const fp = 'cc'.repeat(32);
    const cn = crypto.randomBytes(16).toString('hex');
    const { code } = pm.current();
    const s = pm.start(cn, fp);
    expect(s.hostProof).toBe(hostProof(code, cn, s.serverNonce, fp));
    expect(pm.complete(s.serverNonce, clientProof(code, s.serverNonce, cn))).toBe(true);
    expect(() => pm.complete(s.serverNonce, clientProof(code, s.serverNonce, cn))).toThrow(/expired or unknown/);
    for (let i = 0; i < 5; i++) {
      const t = pm.start(cn, fp);
      expect(pm.complete(t.serverNonce, 'bad')).toBe(false);
    }
    expect(pm.current().code).not.toBe(code);
  });
  it('code expires after 10 minutes', () => {
    let now = 0;
    const pm = new PairingManager(() => now);
    const c1 = pm.current().code;
    now += 10 * 60_000 + 1;
    expect(pm.current().code).not.toBe(c1);
  });
});

describe('certificate and secrets', () => {
  it('self-signed certificate: SANs, 5-year validity, fingerprint', () => {
    const c = generateCertificate({ commonName: 'pc-1', hostnames: ['pc-1'], ips: ['192.168.1.10'] });
    const x = new crypto.X509Certificate(c.certPem);
    expect(x.subjectAltName).toContain('DNS:pc-1');
    expect(x.subjectAltName).toContain('IP Address:192.168.1.10');
    expect(new Date(x.validTo).getTime() - Date.now()).toBeGreaterThan(4.9 * 365 * 86_400_000);
    expect(certificateFingerprint(c.certPem)).toBe(c.fingerprint);
    expect(shortFingerprint(c.fingerprint)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    expect(x.checkPrivateKey(crypto.createPrivateKey(c.keyPem))).toBe(true);
  });
  it('JWT secret: created once per installation, owner-only file, reused afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-'));
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const a = loadOrCreateJwtSecret(dir);
      expect(a).toMatch(/^[0-9a-f]{128}$/);
      expect(loadOrCreateJwtSecret(dir)).toBe(a);
      if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'jwt.secret')).mode & 0o777).toBe(0o600);
      expect(loadOrCreateJwtSecret(fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-')))).not.toBe(a);
    } finally {
      if (saved !== undefined) process.env.JWT_SECRET = saved;
    }
  });
});
