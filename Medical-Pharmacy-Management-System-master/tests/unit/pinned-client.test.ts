/**
 * The pinned HTTPS client must send each request over the ONE connection whose certificate was checked
 * against the pin. (Regression: with `agent: false` Node ignored `createConnection`, so every request
 * opened a second, unpinned TLS connection and left the verified socket open without an error handler;
 * on Windows each leftover socket became an unhandled "read ECONNRESET" when the server stopped.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { generateCertificate } from '../../server/lan/tls';
import { pinnedJson, PinMismatchError } from '../../server/lan/pinnedClient';

const real = generateCertificate({ commonName: 'pharmacy host', ips: ['127.0.0.1'] });
const impostor = generateCertificate({ commonName: 'impostor', ips: ['127.0.0.1'] });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  closers.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return (server.address() as net.AddressInfo).port;
}

/** An HTTPS server that records every TLS connection, whether it carried a request, and whether it is still open. */
async function recordingServer(material = real, body = { from: 'pharmacy host' }) {
  const conns: { carried: boolean; socket: tls.TLSSocket }[] = [];
  const server = https.createServer({ cert: material.certPem, key: material.keyPem }, (req, res) => {
    const c = conns.find((x) => x.socket === req.socket);
    if (c) c.carried = true;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  server.on('secureConnection', (socket) => conns.push({ carried: false, socket }));
  return { conns, port: await listen(server) };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

describe('pinned HTTPS client', () => {
  it('uses exactly one TLS connection per request - the pinned one - and leaves none open', async () => {
    const { conns, port } = await recordingServer();
    for (let i = 0; i < 3; i++) {
      const r = await pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(r).toEqual({ status: 200, body: { from: 'pharmacy host' } });
    }
    await settle();
    expect(conns.map((c) => c.carried)).toEqual([true, true, true]); // 3 requests, 3 connections, each carried its request
    expect(conns.filter((c) => !c.socket.destroyed)).toEqual([]); // nothing left open to be reset later
  });

  it('the request goes over the verified connection, never a second one (a man-in-the-middle answering only later connections gets nothing)', async () => {
    // A relay that sends the 1st connection to the real host and every later one to an impostor:
    // a client that verifies one connection but sends the request on another would talk to the impostor.
    const host = await recordingServer(real, { from: 'pharmacy host' });
    const fake = await recordingServer(impostor, { from: 'IMPOSTOR' });
    let n = 0;
    const relay = net.createServer((client) => {
      const upstream = net.connect(n++ === 0 ? host.port : fake.port, '127.0.0.1');
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    const port = await listen(relay);
    const r = await pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint);
    expect(r.body).toEqual({ from: 'pharmacy host' });
    await settle();
    expect(n).toBe(1);
    expect(fake.conns).toEqual([]);
  });

  it('times out (ETIMEDOUT) when the server accepts the connection but never completes the TLS handshake; nothing is left open', async () => {
    const closed: boolean[] = [];
    const silent = net.createServer((s) => { // TCP only, never speaks TLS
      const i = closed.push(false) - 1;
      s.resume(); // read (and discard) the client hello, so the client's close is seen
      s.on('close', () => { closed[i] = true; });
      s.on('error', () => { /* the client resetting the connection is expected here */ });
    });
    const port = await listen(silent);
    const t0 = Date.now();
    await expect(pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint, { timeoutMs: 600 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(5000);
    await settle();
    expect(closed).toEqual([true]); // one connection, and the client closed it
  });

  it('times out (ETIMEDOUT) when the verified server never answers the request', async () => {
    const server = https.createServer({ cert: real.certPem, key: real.keyPem }, () => { /* never responds */ });
    const port = await listen(server);
    const t0 = Date.now();
    await expect(pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint, { timeoutMs: 600 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a host that is not running gives a clear connection error (ECONNREFUSED), not a hang', async () => {
    const probe = net.createServer();
    const port = await listen(probe);
    await closers.pop()!(); // free the port: nothing listens there now
    await expect(pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint, { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('still refuses a server whose certificate does not match the pin', async () => {
    const { port } = await recordingServer(impostor);
    await expect(pinnedJson(`https://127.0.0.1:${port}/api/x`, real.fingerprint)).rejects.toBeInstanceOf(PinMismatchError);
  });

  it('a connection reset after the full response does not leave an unhandled error; a reset before it is reported to the caller', async () => {
    // after the response: the server resets the connection once it has answered
    const server = https.createServer({ cert: real.certPem, key: real.keyPem }, (req, res) => {
      res.end('{"ok":true}', () => setTimeout(() => (req.socket as any)._parent?.resetAndDestroy?.() ?? req.socket.destroy(), 20));
    });
    const port = await listen(server);
    expect((await pinnedJson(`https://127.0.0.1:${port}/x`, real.fingerprint)).body).toEqual({ ok: true });
    await settle();
    // before the response: the caller gets the error (nothing is swallowed)
    const rude = https.createServer({ cert: real.certPem, key: real.keyPem }, (req) => { (req.socket as any)._parent?.resetAndDestroy?.() ?? req.socket.destroy(); });
    const rport = await listen(rude);
    await expect(pinnedJson(`https://127.0.0.1:${rport}/x`, real.fingerprint)).rejects.toThrow(/ECONNRESET|socket hang up/);
  });
});
