/**
 * Phase 8a: live events (server-sent events, ARCHITECTURE.md §9).
 *
 * A change event says only WHAT kind of data changed and in which store: {seq, topic, tenantId}. No business data
 * and no credentials travel in events; a client re-fetches through the normal, authorised endpoints.
 *
 *  - emitted only after a successful COMMIT (the caller emits from the transaction's afterCommit hook)
 *  - per store: a subscriber receives only its own store's events (a SUPER_ADMIN stream receives every store's)
 *  - `seq` increases by one per event within a store, from 1 after each server start; `bootId` identifies the start.
 *    A client that sees a gap, a different bootId, or that reconnects, refreshes everything.
 *  - every stream is re-checked every 60 s and when its token expires (and at once on logout, account or store
 *    status changes and pairing revocation); a stream that fails the check is closed with a reason code
 *  - a keep-alive comment every 20 s keeps idle Wi-Fi/NAT paths from dropping the stream
 *  - limits: per user, per paired computer and in total
 */
import crypto from 'node:crypto';
import type { Response } from 'express';

export const TOPICS = ['inventory', 'sales', 'customers', 'purchases', 'settings', 'users', 'backups'] as const;
export type Topic = (typeof TOPICS)[number];

export interface LiveEvent { seq: number; topic: Topic; tenantId: number }

/** Result of re-checking a stream's credentials; ok=false closes the stream with `reason`. */
export type StreamCheck = { ok: true } | { ok: false; reason: string };

export interface StreamInfo {
  userId: number;
  /** the store this stream follows; null = every store (SUPER_ADMIN) */
  tenantId: number | null;
  /** sha256 of the access token (the token itself is kept only inside `check`) */
  tokenHash: string;
  /** token expiry, seconds since 1970 (from the token); the stream is re-checked at that moment */
  tokenExp?: number;
  /** the paired computer the request came through (LAN requests only) */
  pairedClientId?: number;
  /** re-validates token, account, store and pairing */
  check: () => StreamCheck;
}

interface Stream extends StreamInfo { id: number; res: Response; expiryTimer?: NodeJS.Timeout }

export const LIMITS = { perUser: 5, perPairedClient: 10, total: 200 };

export class StreamLimitError extends Error {
  readonly code = 'STREAM_LIMIT';
  constructor(message: string) { super(message); }
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class LiveEventHub {
  readonly bootId = crypto.randomUUID();
  private readonly seqs = new Map<number, number>();
  private readonly streams = new Map<number, Stream>();
  private nextId = 1;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private revalidateTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { keepAliveMs?: number; revalidateMs?: number; limits?: typeof LIMITS } = {}) {}

  private get limits() { return this.opts.limits ?? LIMITS; }

  /** current sequence number of a store (0 = nothing emitted since this server started) */
  seqOf(tenantId: number): number { return this.seqs.get(tenantId) ?? 0; }

  get streamCount(): number { return this.streams.size; }

  /** Emit one change event to the store's subscribers (and every SUPER_ADMIN stream). Call only after COMMIT. */
  emit(tenantId: number, topic: Topic): LiveEvent {
    if (!TOPICS.includes(topic)) throw new Error(`unknown live-event topic ${topic}`);
    const seq = this.seqOf(tenantId) + 1;
    this.seqs.set(tenantId, seq);
    const ev: LiveEvent = { seq, topic, tenantId };
    const frame = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const s of this.streams.values()) {
      if (s.tenantId === null || s.tenantId === tenantId) this.write(s, frame);
    }
    return ev;
  }

  /** Throws StreamLimitError if a new stream for this user / paired computer would exceed the limits. */
  assertCapacity(userId: number, pairedClientId?: number): void {
    const all = [...this.streams.values()];
    if (all.length >= this.limits.total) throw new StreamLimitError('The server has too many live connections open. Try again shortly.');
    if (all.filter((s) => s.userId === userId).length >= this.limits.perUser) throw new StreamLimitError('Too many live connections are open for this user. Close other windows and try again.');
    if (pairedClientId !== undefined && all.filter((s) => s.pairedClientId === pairedClientId).length >= this.limits.perPairedClient) {
      throw new StreamLimitError('Too many live connections are open from this computer.');
    }
  }

  /** Start an event stream on `res` (headers, ready message, timers). The caller has authenticated the request. */
  subscribe(res: Response, info: StreamInfo): number {
    this.assertCapacity(info.userId, info.pairedClientId);
    const s: Stream = { ...info, id: this.nextId++, res };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-BrainTech-Boot-Id': this.bootId,
    });
    // stream metadata (not a change event): which server start this is and where the store's sequence stands
    const ready = { bootId: this.bootId, tenantId: info.tenantId, seq: info.tenantId === null ? null : this.seqOf(info.tenantId) };
    res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
    this.streams.set(s.id, s);
    res.on('close', () => this.remove(s.id));
    if (info.tokenExp) {
      const ms = info.tokenExp * 1000 - Date.now();
      // re-check just after expiry (setTimeout cannot wait longer than ~24.8 days; the 60 s check covers the rest)
      if (ms < 2 ** 31 - 1) s.expiryTimer = setTimeout(() => this.revalidate((x) => x.id === s.id), Math.max(0, ms) + 50);
    }
    this.ensureTimers();
    return s.id;
  }

  /** Re-check streams (all, or those matching `which`); close the ones that fail. Returns how many were closed. */
  revalidate(which: (s: StreamInfo & { id: number }) => boolean = () => true): number {
    let closed = 0;
    for (const s of [...this.streams.values()]) {
      if (!which(s)) continue;
      let r: StreamCheck;
      try { r = s.check(); } catch { r = { ok: false, reason: 'CHECK_FAILED' }; }
      if (r.ok === false) { this.close(s, r.reason); closed++; }
    }
    return closed;
  }

  /** Close the streams matching `which` (e.g. logout of one token, revocation of one paired computer). */
  closeWhere(which: (s: StreamInfo & { id: number }) => boolean, reason: string): number {
    let n = 0;
    for (const s of [...this.streams.values()]) if (which(s)) { this.close(s, reason); n++; }
    return n;
  }

  /** Close every stream (server shutdown) and stop the timers. */
  closeAll(reason = 'SERVER_SHUTDOWN'): number {
    const n = this.closeWhere(() => true, reason);
    this.stopTimers();
    return n;
  }

  private close(s: Stream, reason: string) {
    this.write(s, `event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    this.remove(s.id);
    try { s.res.end(); } catch { /* already gone */ }
  }

  private remove(id: number) {
    const s = this.streams.get(id);
    if (!s) return;
    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    this.streams.delete(id);
    if (!this.streams.size) this.stopTimers();
  }

  private write(s: Stream, frame: string) {
    if (s.res.writableEnded || s.res.destroyed) { this.remove(s.id); return; }
    try { s.res.write(frame); } catch { this.remove(s.id); }
  }

  private ensureTimers() {
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => { for (const s of [...this.streams.values()]) this.write(s, ': keep-alive\n\n'); }, this.opts.keepAliveMs ?? 20_000);
      this.keepAliveTimer.unref();
    }
    if (!this.revalidateTimer) {
      this.revalidateTimer = setInterval(() => this.revalidate(), this.opts.revalidateMs ?? 60_000);
      this.revalidateTimer.unref();
    }
  }

  private stopTimers() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    this.keepAliveTimer = this.revalidateTimer = null;
  }
}

/**
 * Which topics a successful write changes, from its method and path. Writes that change no shared business data
 * (login, OTP, SMS/e-mail queues, audit-log export, pairing, local administration, setup) emit nothing.
 */
export function topicsForWrite(method: string, path: string): Topic[] {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return [];
  const p = path.toLowerCase();
  const group = p.split('/')[2] ?? ''; // /api/<group>/...
  switch (group) {
    case 'sales': return p === '/api/sales/quote' ? [] : ['sales', 'inventory', 'customers'];
    case 'payments': return ['sales', 'customers'];
    case 'customers': return ['customers', 'sales'];
    case 'inventory': case 'batches': case 'categories': return ['inventory'];
    case 'purchases': return ['purchases', 'inventory'];
    case 'suppliers': return ['purchases'];
    case 'settings': return ['settings'];
    case 'users': return ['users'];
    case 'superadmin': return /\/login-as$/.test(p) ? [] : ['users', 'settings']; // "log in as" changes no store data
    default: return [];
  }
}
