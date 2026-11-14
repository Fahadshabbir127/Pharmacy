/**
 * LAN host/client foundation: host lifecycle and access-control gaps not covered by 09-desktop-backend.
 *  - standalone mode's default binding is loopback only (nothing answers on the network address)
 *  - no alternate spelling of an /api path gets past the LAN guard
 *  - a port that is already in use stops startup with a clear error
 *  - repeated host start/stop cycles: HTTPS answers each time, the port is released, pairings persist,
 *    the pairing code is new after each start (in memory by design)
 *  - pairing attempts are rate-limited per address; tokens and codes never appear in logs or the audit log
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, makeTempDir, PORT } from '../helpers/server';
import { openReadOnly, all } from '../helpers/db';
import { generateCertificate } from '../../server/lan/tls';
import { pinnedJson, pairWithHost } from '../../server/lan/pinnedClient';

let cert: ReturnType<typeof generateCertificate>;
let certDir: string;
const LOCAL = 'local-token-' + crypto.randomBytes(16).toString('hex');
const tlsEnv = () => ({ PHARMACY_TLS_CERT_FILE: path.join(certDir, 'cert.pem'), PHARMACY_TLS_KEY_FILE: path.join(certDir, 'key.pem') });
// a non-loopback IPv4 address of this computer (the same choice as 09-desktop-backend)
const networkAddress = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const portInUse = (port: number, host = '127.0.0.1') => new Promise<boolean>((resolve) => {
  const s = net.connect(port, host);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
const hostStatus = async () => (await pinnedJson(`https://127.0.0.1:${PORT}/api/local/host-status`, cert.fingerprint, { headers: { 'x-local-token': LOCAL } })).body;

beforeAll(() => {
  cert = generateCertificate({ commonName: 'lan-host-test', hostnames: [os.hostname()] });
  certDir = makeTempDir();
  fs.writeFileSync(path.join(certDir, 'cert.pem'), cert.certPem);
  fs.writeFileSync(path.join(certDir, 'key.pem'), cert.keyPem);
});

describe('standalone mode is not reachable from the network', () => {
  it('with its default binding nothing answers on the network address, while this computer itself is served', async () => {
    const ip = networkAddress();
    expect(ip, 'this test needs a non-loopback IPv4 address').toBeTruthy();
    const srv = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'standalone' } }); // no PHARMACY_BIND
    try {
      expect((await pinnedJson(`https://127.0.0.1:${PORT}/api/health`, cert.fingerprint)).status).toBe(200);
      expect(await portInUse(PORT, ip!)).toBe(false); // not listening on the network interface at all
    } finally {
      await srv.stop();
    }
  });

  it('even when bound to every interface, no spelling of an /api path gets past the guard', async () => {
    const ip = networkAddress();
    expect(ip, 'this test needs a non-loopback IPv4 address').toBeTruthy();
    const srv = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'standalone', PHARMACY_BIND: '0.0.0.0' } });
    try {
      const refused = ['/api/health', '/API/health', '/Api/auth/me', '/api//health', '/api/health/', '/api/./health', '/api/auth/me', '/api/local/host-status', '/api/sales/history'];
      for (const p of refused) {
        const r = await pinnedJson(`https://${ip}:${PORT}${p}`, cert.fingerprint);
        expect([p, r.status, r.body?.error]).toEqual([p, 403, 'This computer does not accept network connections (standalone mode).']);
      }
      const pair = await pinnedJson(`https://${ip}:${PORT}/api/pair/start`, cert.fingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientNonce: 'ab'.repeat(16) }) });
      expect(pair.status).toBe(403);
      // paths that are not /api at all never reach an API route (no JSON data comes back)
      for (const p of ['/%61pi/health', '//api/health']) {
        const r = await pinnedJson(`https://${ip}:${PORT}${p}`, cert.fingerprint);
        expect(typeof r.body, `${p} returned API data`).toBe('string');
        expect(r.body).not.toMatch(/"apiProtocol"|"status":"ok"/);
      }
    } finally {
      await srv.stop();
    }
  });
});

describe('host startup and shutdown', () => {
  it('a port that is already in use stops startup with a clear error, and nothing is left running', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(startServer({ env: { PHARMACY_PORT: String(busy) } })).rejects.toThrow(/exited early[\s\S]*EADDRINUSE/);
      expect(await portInUse(PORT)).toBe(false);
    } finally {
      await new Promise((r) => blocker.close(() => r(null)));
    }
  });

  it('five start/stop cycles of an HTTPS host: answers each time, releases the port, keeps its pairings, new pairing code each start', async () => {
    const env = { ...tlsEnv(), PHARMACY_MODE: 'host', PHARMACY_BIND: '0.0.0.0', PHARMACY_LOCAL_TOKEN: LOCAL };
    let workDir: string | undefined;
    const codes: string[] = [];
    for (let cycle = 1; cycle <= 5; cycle++) {
      const srv = await startServer({ workDir, tlsPin: cert.fingerprint, env });
      workDir = srv.workDir;
      try {
        expect((await pinnedJson(`https://127.0.0.1:${PORT}/api/health`, cert.fingerprint)).body).toMatchObject({ status: 'ok', mode: 'host' });
        const st = await hostStatus();
        codes.push(st.pairing.code);
        if (cycle === 1) {
          await pairWithHost({ host: '127.0.0.1', port: PORT, code: st.pairing.code, clientName: 'Counter 7' });
        } else {
          expect(st.clients.map((c: any) => [c.name, c.revoked_at ?? null])).toEqual([['Counter 7', null]]); // pairing survived the restart
        }
      } finally {
        await srv.stop();
      }
      expect(await portInUse(PORT), `port still in use after stop ${cycle}`).toBe(false);
    }
    expect(new Set(codes).size).toBe(5);
  }, 120_000);
});

describe('pairing safety', () => {
  it('pairing attempts are limited per address; client tokens and pairing codes appear in no log', async () => {
    const srv = await startServer({ tlsPin: cert.fingerprint, env: { ...tlsEnv(), PHARMACY_MODE: 'host', PHARMACY_LOCAL_TOKEN: LOCAL } });
    try {
      const code = (await hostStatus()).pairing.code;
      const paired = await pairWithHost({ host: '127.0.0.1', port: PORT, code, clientName: 'Counter 8' });
      // pairWithHost made one /pair/start; 19 more are allowed in the 10-minute window, the 21st is refused
      const start = () => pinnedJson(`https://127.0.0.1:${PORT}/api/pair/start`, cert.fingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientNonce: crypto.randomBytes(16).toString('hex') }) });
      for (let i = 0; i < 19; i++) expect((await start()).status).toBe(200);
      const limited = await start();
      expect([limited.status, limited.body.error]).toEqual([429, 'Too many pairing attempts. Wait 10 minutes.']);

      const db = await openReadOnly(srv.dbFile);
      const audit = all<any>(db, "SELECT description FROM audit_logs WHERE action_type LIKE 'LAN_%'").map((r) => r.description).join('\n');
      const stored = all<any>(db, 'SELECT token_hash FROM paired_clients').map((r) => r.token_hash).join('\n');
      db.close();
      for (const [what, text] of [['server log', srv.logs()], ['audit log', audit], ['stored pairing', stored]] as const) {
        expect(text.includes(paired.clientToken), `${what} contains the client token`).toBe(false);
        expect(text.includes(code), `${what} contains the pairing code`).toBe(false);
      }
      expect(audit).toMatch(/Paired LAN client "Counter 8"/);
    } finally {
      await srv.stop();
    }
  });
});
