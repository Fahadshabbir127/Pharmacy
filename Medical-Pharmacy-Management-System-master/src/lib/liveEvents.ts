/**
 * Phase 8b: client for the host's live-event stream (GET /api/events, ARCHITECTURE.md §9).
 *
 * Uses fetch + ReadableStream (not EventSource), so the access token travels in the Authorization header and never in
 * a URL. Events only say WHAT changed ({seq, topic, tenantId}); screens re-fetch through the normal API.
 *
 *  - reconnects with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s); a stream that opened resets the backoff
 *  - asks for a full refresh ("resync") after every reconnect, when the server restarted (new bootId) and when a
 *    sequence number was skipped (missed events)
 *  - stops for good when the session is no longer valid (401/403, or the server ended the stream for logout,
 *    expiry, a disabled account, a suspended store or a revoked pairing) and reports why
 *  - stop() aborts the request and every timer
 *
 * No React or DOM dependency: App.tsx wires it to a window CustomEvent (see useLiveRefresh.ts).
 */
export const LIVE_TOPICS = ['inventory', 'sales', 'customers', 'purchases', 'settings', 'users', 'backups'] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];
export interface LiveChange { seq: number; topic: LiveTopic; tenantId: number }
export type ResyncReason = 'reconnect' | 'boot-changed' | 'gap' | 'backup-restored';
export type LiveStatus = 'connecting' | 'live' | 'waiting' | 'stopped';

/** Reasons after which reconnecting cannot help: the session must be checked (and normally the user signs in again). */
export const SESSION_END_REASONS = new Set(['LOGGED_OUT', 'TOKEN_INVALID_OR_EXPIRED', 'ACCOUNT_INACTIVE', 'STORE_SUSPENDED', 'PAIRING_REVOKED', 'UNAUTHORIZED', 'NO_TOKEN']);

// ---------------------------------------------------------------------------------------------
// Server-sent events parser (WHATWG event-stream rules: LF, CRLF or CR line ends; multi-line data; comments)
// ---------------------------------------------------------------------------------------------
export interface SseMessage { event: string; data: string; id?: string }

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private sawCR = false;

  /** Feed decoded text (any chunking); returns the messages completed by it. */
  push(text: string): SseMessage[] {
    const out: SseMessage[] = [];
    for (const ch of text) {
      if (this.sawCR) {
        this.sawCR = false;
        if (ch === '\n') continue; // the LF of a CRLF pair
      }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r') this.sawCR = true;
        this.line(this.buf, out);
        this.buf = '';
      } else {
        this.buf += ch;
      }
    }
    return out;
  }

  private line(line: string, out: SseMessage[]) {
    if (line === '') { // blank line: dispatch
      if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment (keep-alive)
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    // 'retry' and unknown fields are ignored: reconnect timing is ours
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------
export interface LiveEventOptions {
  /** current access token (read on every connect); null stops the client */
  getToken: () => string | null;
  /** a topic changed (already ordered; delivered even when a gap was detected, together with a resync) */
  onChange: (change: LiveChange) => void;
  /** screens should reload everything */
  onResync: (reason: ResyncReason) => void;
  /** the client stopped for good; `reason` is one of SESSION_END_REASONS or 'STOPPED' */
  onSessionEnd?: (reason: string) => void;
  onStatus?: (status: LiveStatus) => void;
  url?: string;
  fetchImpl?: typeof fetch;
  backoff?: { initialMs?: number; maxMs?: number };
  /** injectable for tests */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export function backoffDelay(attempt: number, initialMs = 1000, maxMs = 30_000): number {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
}

export class LiveEventClient {
  private readonly stopCtrl = new AbortController();
  private requestCtrl: AbortController | null = null;
  private running = false;
  private bootId: string | null = null;
  private readonly lastSeq = new Map<number, number>();
  private everConnected = false;
  /** delays waited between attempts (for diagnostics and tests) */
  readonly waits: number[] = [];

  constructor(private readonly o: LiveEventOptions) {}

  get stopped() { return this.stopCtrl.signal.aborted; }

  start(): this {
    if (this.running || this.stopped) return this;
    this.running = true;
    void this.loop();
    return this;
  }

  /** Close the stream and stop reconnecting (logout, user change, unmount). */
  stop(): void {
    if (this.stopped) return;
    this.stopCtrl.abort();
    this.requestCtrl?.abort();
    this.o.onStatus?.('stopped');
  }

  private async loop() {
    let attempt = 0;
    while (!this.stopped) {
      const token = this.o.getToken();
      if (!token) return this.end('NO_TOKEN');
      this.o.onStatus?.('connecting');
      const outcome = await this.connectOnce(token);
      if (this.stopped) return;
      if (outcome.kind === 'session-end') return this.end(outcome.reason);
      if (outcome.kind === 'opened') attempt = 0; // the stream worked; start the backoff again from 1 s
      const wait = backoffDelay(attempt++, this.o.backoff?.initialMs, this.o.backoff?.maxMs);
      this.waits.push(wait);
      this.o.onStatus?.('waiting');
      await (this.o.sleep ?? abortableSleep)(wait, this.stopCtrl.signal);
    }
  }

  private end(reason: string) {
    if (this.stopped) return;
    this.stopCtrl.abort();
    this.o.onStatus?.('stopped');
    this.o.onSessionEnd?.(reason);
  }

  /** One connection. Resolves when it is over: 'opened' (it delivered a ready message), 'failed', or a session end. */
  private async connectOnce(token: string): Promise<{ kind: 'opened' | 'failed' } | { kind: 'session-end'; reason: string }> {
    const ctrl = new AbortController();
    this.requestCtrl = ctrl;
    let opened = false;
    try {
      const res = await (this.o.fetchImpl ?? fetch)(this.o.url ?? '/api/events', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) return { kind: 'session-end', reason: 'UNAUTHORIZED' };
      if (!res.ok || !res.body) return { kind: 'failed' }; // 429 (too many streams), 503 (host away), ...
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parser.push(decoder.decode(value, { stream: true }))) {
          const r = this.handle(m);
          if (r === 'opened') opened = true;
          else if (r && r.endReason) {
            ctrl.abort();
            return SESSION_END_REASONS.has(r.endReason) ? { kind: 'session-end', reason: r.endReason } : { kind: opened ? 'opened' : 'failed' };
          }
        }
      }
      return { kind: opened ? 'opened' : 'failed' }; // the connection ended (host stopped, network drop)
    } catch {
      return { kind: opened ? 'opened' : 'failed' }; // network error or abort
    } finally {
      ctrl.abort();
      if (this.requestCtrl === ctrl) this.requestCtrl = null;
    }
  }

  private handle(m: SseMessage): 'opened' | { endReason: string } | null {
    let data: any;
    try { data = JSON.parse(m.data); } catch { return null; } // not ours: ignore
    if (m.event === 'ready') {
      const boot = String(data?.bootId ?? '');
      const resync: ResyncReason | null = this.bootId && boot !== this.bootId ? 'boot-changed' : this.everConnected ? 'reconnect' : null;
      if (resync === 'boot-changed') this.lastSeq.clear(); // sequence numbers restart with the server
      this.bootId = boot;
      if (Number.isInteger(data?.tenantId) && Number.isInteger(data?.seq)) this.lastSeq.set(data.tenantId, data.seq);
      else this.lastSeq.clear(); // all-stores stream (SUPER_ADMIN): each store's first event sets its starting point
      this.everConnected = true;
      this.o.onStatus?.('live');
      if (resync) this.o.onResync(resync);
      return 'opened';
    }
    if (m.event === 'change') {
      const { seq, topic, tenantId } = data ?? {};
      if (!Number.isInteger(seq) || !Number.isInteger(tenantId) || !LIVE_TOPICS.includes(topic)) return null;
      const last = this.lastSeq.get(tenantId);
      this.lastSeq.set(tenantId, seq);
      this.o.onChange({ seq, topic, tenantId });
      if (topic === 'backups') this.o.onResync('backup-restored');
      else if (last !== undefined && seq !== last + 1) this.o.onResync('gap');
      return null;
    }
    if (m.event === 'end') return { endReason: String(data?.reason ?? 'ENDED') };
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Window event used to tell mounted screens what changed (App.tsx dispatches, useLiveRefresh listens)
// ---------------------------------------------------------------------------------------------
export const LIVE_EVENT_NAME = 'braintech:live-change';
/** `topics: 'all'` = reload everything (reconnect, server restart, missed events, backup restore). */
export interface LiveChangeDetail { topics: LiveTopic[] | 'all'; reason: 'change' | ResyncReason }

export function liveDetailMatches(detail: LiveChangeDetail, interested: readonly LiveTopic[]): boolean {
  return detail.topics === 'all' || detail.topics.some((t) => interested.includes(t));
}
