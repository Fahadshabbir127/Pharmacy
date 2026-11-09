/**
 * Client <-> host pairing (mutual proof of a short code, bound to the TLS certificate).
 *
 *   1. client opens TLS WITHOUT trusting the certificate and reads its fingerprint F
 *   2. client -> host  POST /api/pair/start    { clientNonce }
 *      host  -> client { serverNonce, hostProof = HMAC(code, "host|cn|sn|F_host") }
 *   3. client recomputes hostProof with the F it observed. A man-in-the-middle presents
 *      a different certificate, so the proof cannot match unless it knows the code.
 *   4. client -> host  POST /api/pair/complete { serverNonce, clientProof = HMAC(code, "client|sn|cn"), clientName }
 *      host verifies, stores sha256(clientToken), returns { clientId, clientToken }
 *   5. client pins F and sends X-BrainTech-Client: <clientToken> on every request.
 *
 * Codes are 8 characters from an unambiguous alphabet (~40 bits), rotate every 10 minutes
 * and after 5 failed attempts, and sessions expire after 2 minutes.
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function normalizeCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const hmac = (code: string, msg: string) => crypto.createHmac('sha256', normalizeCode(code)).update(msg).digest('hex');

export function hostProof(code: string, clientNonce: string, serverNonce: string, fingerprint: string): string {
  return hmac(code, `host|${clientNonce}|${serverNonce}|${fingerprint.toLowerCase()}`);
}

export function clientProof(code: string, serverNonce: string, clientNonce: string): string {
  return hmac(code, `client|${serverNonce}|${clientNonce}`);
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

interface Session { clientNonce: string; expires: number }

/** In-memory pairing state on the host. */
export class PairingManager {
  private code: string;
  private codeExpires: number;
  private failures = 0;
  private sessions = new Map<string, Session>();
  private readonly now: () => number;
  static CODE_TTL_MS = 10 * 60_000;
  static SESSION_TTL_MS = 2 * 60_000;
  static MAX_FAILURES = 5;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.code = generatePairingCode();
    this.codeExpires = this.now() + PairingManager.CODE_TTL_MS;
  }

  current(): { code: string; expiresAt: string } {
    if (this.now() >= this.codeExpires) this.rotate();
    return { code: this.code, expiresAt: new Date(this.codeExpires).toISOString() };
  }

  rotate(): void {
    this.code = generatePairingCode();
    this.codeExpires = this.now() + PairingManager.CODE_TTL_MS;
    this.failures = 0;
    this.sessions.clear();
  }

  start(clientNonce: string, fingerprint: string): { serverNonce: string; hostProof: string } {
    if (!/^[0-9a-f]{32,128}$/i.test(clientNonce)) throw new PairingError('invalid nonce', 400);
    const { code } = this.current();
    const serverNonce = crypto.randomBytes(24).toString('hex');
    this.sessions.set(serverNonce, { clientNonce, expires: this.now() + PairingManager.SESSION_TTL_MS });
    return { serverNonce, hostProof: hostProof(code, clientNonce, serverNonce, fingerprint) };
  }

  /** Returns true if the client proved the code. Counts failures and rotates the code when exceeded. */
  complete(serverNonce: string, proof: string): boolean {
    const s = this.sessions.get(String(serverNonce));
    this.sessions.delete(String(serverNonce));
    if (!s || s.expires < this.now()) throw new PairingError('pairing session expired or unknown; start again', 400);
    const { code } = this.current();
    const ok = safeEqualHex(clientProof(code, serverNonce, s.clientNonce), String(proof));
    if (!ok) {
      this.failures++;
      if (this.failures >= PairingManager.MAX_FAILURES) this.rotate();
    }
    return ok;
  }
}

export class PairingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
