/**
 * HTTPS client with certificate pinning, used by the Electron main process to talk to a
 * backend (its own, or the host's). The certificate is trusted ONLY if its SHA-256
 * fingerprint equals the pinned value; CA chains and host names are irrelevant.
 */
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { clientProof, hostProof, safeEqualHex } from './pairing';

export class PinMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super('The server presented a different security certificate than the one this computer trusts. Re-pair this computer with the pharmacy server.');
    this.name = 'PinMismatchError';
  }
}

const fpOf = (cert: tls.PeerCertificate | tls.DetailedPeerCertificate | undefined) =>
  cert?.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : '';

export interface PinnedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  timeoutMs?: number;
}

/**
 * Open a TLS connection and verify the pin BEFORE anything is sent.
 * (Node only calls checkServerIdentity when normal CA verification succeeds, which never happens
 * for a self-signed certificate, so the pin must be checked explicitly on the connected socket.)
 */
export function connectPinned(host: string, port: number, pin: string, timeoutMs = 15_000): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host, timeout: timeoutMs });
    const fail = (e: Error) => { socket.destroy(); reject(e); };
    socket.once('secureConnect', () => {
      const actual = fpOf(socket.getPeerCertificate(true));
      if (!actual || !safeEqualHex(actual, pin.toLowerCase())) return fail(new PinMismatchError(pin, actual));
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(socket);
    });
    socket.once('timeout', () => fail(Object.assign(new Error('The pharmacy server did not answer in time.'), { code: 'ETIMEDOUT' })));
    socket.once('error', fail);
  });
}

/** Make one HTTPS request over a pinned connection; resolves with the live response (stream). */
export async function pinnedRequest(url: string, pin: string, req: PinnedRequest = {}): Promise<IncomingMessage> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('pinnedRequest only speaks HTTPS');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 443;
  const socket = await connectPinned(host, port, pin, req.timeoutMs);
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host,
        port,
        path: `${u.pathname}${u.search}`,
        method: req.method || 'GET',
        headers: req.headers,
        // The already-verified socket; no second, unverified connection. NO `agent` option: with an agent
        // (`agent: false` creates a fresh one) Node ignores `createConnection` and the agent opens its own,
        // unpinned TLS connection, leaving the verified socket unused, open and without an error listener.
        createConnection: () => socket,
        rejectUnauthorized: false, // CA checks do not apply to a self-signed cert; the pin was verified in connectPinned()
        timeout: req.timeoutMs ?? 15_000,
      },
      resolve,
    );
    r.on('timeout', () => r.destroy(Object.assign(new Error('The pharmacy server did not answer in time.'), { code: 'ETIMEDOUT' })));
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}

export async function readBody(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

export async function pinnedJson<T = any>(url: string, pin: string, req: PinnedRequest = {}): Promise<{ status: number; body: T }> {
  const res = await pinnedRequest(url, pin, req);
  const text = (await readBody(res)).toString('utf8');
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode || 0, body };
}

/** Read the certificate a server presents WITHOUT trusting it (first step of pairing). */
export function probeCertificate(host: string, port: number, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined, timeout: timeoutMs }, () => {
      const fp = fpOf(s.getPeerCertificate(true));
      s.end();
      fp ? resolve(fp) : reject(new Error('The server did not present a certificate.'));
    });
    s.on('timeout', () => s.destroy(new Error('No answer from that address and port.')));
    s.on('error', reject);
  });
}

export interface PairResult { fingerprint: string; clientId: string; clientToken: string; hostName: string; appVersion: string; apiProtocol: number }

/**
 * Pair with a host. Throws if the code is wrong OR if anything between this computer and the
 * host substituted the certificate (the host's proof is bound to the certificate it really has).
 */
export async function pairWithHost(opts: { host: string; port: number; code: string; clientName: string }): Promise<PairResult> {
  const fingerprint = await probeCertificate(opts.host, opts.port);
  const base = `https://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${opts.port}`;
  const clientNonce = crypto.randomBytes(24).toString('hex');
  const json = { 'Content-Type': 'application/json' };
  const start = await pinnedJson(`${base}/api/pair/start`, fingerprint, { method: 'POST', headers: json, body: JSON.stringify({ clientNonce }) });
  if (start.status !== 200) throw new Error(start.body?.error || `Pairing failed (HTTP ${start.status}).`);
  const expected = hostProof(opts.code, clientNonce, start.body.serverNonce, fingerprint);
  if (!safeEqualHex(expected, String(start.body.hostProof))) {
    throw new Error('Pairing failed: the code is wrong, or the connection is being intercepted. Check the code shown on the server computer.');
  }
  const done = await pinnedJson(`${base}/api/pair/complete`, fingerprint, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ serverNonce: start.body.serverNonce, clientProof: clientProof(opts.code, start.body.serverNonce, clientNonce), clientName: opts.clientName }),
  });
  if (done.status !== 200) throw new Error(done.body?.error || `Pairing failed (HTTP ${done.status}).`);
  return { fingerprint, clientId: done.body.clientId, clientToken: done.body.clientToken, hostName: start.body.hostName, appVersion: start.body.appVersion, apiProtocol: start.body.apiProtocol };
}
