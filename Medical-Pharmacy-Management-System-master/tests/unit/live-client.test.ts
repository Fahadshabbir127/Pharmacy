/**
 * Phase 8b: the browser-side live-event client (src/lib/liveEvents.ts) with a fake fetch and controllable streams:
 * SSE parsing (LF / CRLF / CR, multi-line data, comments, any chunking), ordering, gaps, server restarts,
 * reconnect backoff (1 s doubling, capped at 30 s, reset after a working stream), session ends and cleanup.
 */
import { describe, it, expect } from 'vitest';
import { SseParser, LiveEventClient, backoffDelay, liveDetailMatches, SESSION_END_REASONS, type LiveChange, type ResyncReason } from '../../src/lib/liveEvents';

describe('SSE parser', () => {
  it('LF, CRLF and CR line ends; multi-line data; comments; default event name; id', () => {
    const p = new SseParser();
    const msgs = p.push('event: ready\ndata: {"a":1}\n\n: keep-alive\n\nevent: change\r\ndata: line1\r\ndata: line2\r\n\r\ndata:no-space\rid: 7\r\r');
    expect(msgs).toEqual([
      { event: 'ready', data: '{"a":1}' },
      { event: 'change', data: 'line1\nline2' },
      { event: 'message', data: 'no-space', id: '7' },
    ]);
  });

  it('gives the same result however the bytes are split (including between CR and LF)', () => {
    const text = 'event: change\r\ndata: {"seq":1,"topic":"sales","tenantId":1}\r\n\r\n: keep-alive\r\n\r\nevent: end\ndata: {"reason":"LOGGED_OUT"}\n\n';
    const whole = new SseParser().push(text);
    for (let size = 1; size <= 7; size++) {
      const p = new SseParser();
      const got = [];
      for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
      expect(got, `chunk size ${size}`).toEqual(whole);
    }
    expect(whole.map((m) => m.event)).toEqual(['change', 'end']);
  });

  it('a block with no data is not dispatched; unknown fields and retry are ignored', () => {
    expect(new SseParser().push('event: change\n\nretry: 10\nfoo: bar\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
type Conn = { status: number; send: (t: string) => void; end: () => void; fail: () => void; signal: AbortSignal; headers: Record<string, string>; url: string };
/** fetch that hands each request to the test; `plan` decides what each call does */
function fakeFetch(plan: (call: number, conn: Conn) => void | 'reject' | number) {
  const calls: Conn[] = [];
  const impl = (async (url: string, init: any) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const conn: Conn = {
      status: 200, url, headers: init.headers, signal: init.signal,
      send: (t) => { try { ctrl.enqueue(enc.encode(t)); } catch { /* closed */ } },
      end: () => { try { ctrl.close(); } catch { /* closed */ } },
      fail: () => { try { ctrl.error(new Error('network drop')); } catch { /* closed */ } },
    };
    init.signal.addEventListener('abort', () => { try { ctrl.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    calls.push(conn);
    const r = plan(calls.length, conn);
    if (r === 'reject') throw new TypeError('fetch failed');
    if (typeof r === 'number') return new Response(JSON.stringify({ error: 'x' }), { status: r });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const ready = (bootId: string, seq: number | null, tenantId: number | null = 1) => `event: ready\ndata: ${JSON.stringify({ bootId, tenantId, seq })}\n\n`;
const change = (seq: number, topic = 'sales', tenantId = 1) => `event: change\ndata: ${JSON.stringify({ seq, topic, tenantId })}\n\n`;
const endMsg = (reason: string) => `event: end\ndata: ${JSON.stringify({ reason })}\n\n`;
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean, what: string, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await tick(); }
}
function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof LiveEventClient>[0]> = {}) {
  const changes: LiveChange[] = [];
  const resyncs: ResyncReason[] = [];
  const ends: string[] = [];
  const c = new LiveEventClient({
    getToken: () => 'tok-123', fetchImpl, url: '/api/events',
    onChange: (x) => changes.push(x), onResync: (r) => resyncs.push(r), onSessionEnd: (r) => ends.push(r),
    sleep: async () => { await tick(); }, // no real waiting; the requested delays are recorded in c.waits
    ...extra,
  });
  return { c, changes, resyncs, ends };
}

describe('live-event client', () => {
  it('sends the token only in the Authorization header; delivers changes in order; no resync on the first connect', async () => {
    const { impl, calls } = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 4) + change(5) + change(6, 'inventory')), 1); });
    const { c, changes, resyncs } = client(impl);
    c.start();
    await until(() => changes.length === 2, 'two changes');
    expect(calls[0].url).toBe('/api/events');
    expect(calls[0].headers.Authorization).toBe('Bearer tok-123');
    expect(changes).toEqual([{ seq: 5, topic: 'sales', tenantId: 1 }, { seq: 6, topic: 'inventory', tenantId: 1 }]);
    expect(resyncs).toEqual([]);
    c.stop();
  });

  it('a skipped sequence number asks for a resync ("gap"); the change itself is still delivered', async () => {
    const { impl } = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 0) + change(1) + change(3, 'customers')), 1); });
    const { c, changes, resyncs } = client(impl);
    c.start();
    await until(() => changes.length === 2, 'changes');
    expect(resyncs).toEqual(['gap']);
    c.stop();
  });

  it('a backup restore event asks for a full resync', async () => {
    const { impl } = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 0) + change(1, 'backups')), 1); });
    const { c, resyncs } = client(impl);
    c.start();
    await until(() => resyncs.length === 1, 'resync');
    expect(resyncs).toEqual(['backup-restored']);
    c.stop();
  });

  it('after the stream drops it reconnects and resyncs; a new boot id (server restarted) is reported as such', async () => {
    const { impl, calls } = fakeFetch((n, conn) => {
      if (n === 1) setTimeout(() => { conn.send(ready('boot-A', 2) + change(3)); setTimeout(() => conn.fail(), 5); }, 1); // network drop
      if (n === 2) setTimeout(() => { conn.send(ready('boot-A', 3)); setTimeout(() => conn.end(), 5); }, 1); // same server: reconnect
      if (n === 3) setTimeout(() => conn.send(ready('boot-B', 0) + change(1)), 1); // the server restarted
    });
    const { c, changes, resyncs } = client(impl);
    c.start();
    await until(() => calls.length === 3 && changes.length === 2, 'third connection');
    expect(resyncs).toEqual(['reconnect', 'boot-changed']);
    expect(changes.map((x) => x.seq)).toEqual([3, 1]); // seq 1 after the restart is not a "gap"
    expect(c.waits).toEqual([1000, 1000]); // each stream had worked, so the backoff restarted at 1 s
    c.stop();
  });

  it('backoff while the host cannot be reached: 1, 2, 4, 8, 16, 30, 30 s; it resets once a stream works again', async () => {
    const { impl, calls } = fakeFetch((n, conn) => {
      if (n <= 7) return 'reject';
      if (n === 8) { setTimeout(() => { conn.send(ready('boot-A', 0)); setTimeout(() => conn.end(), 5); }, 1); return; }
      if (n === 9) return 'reject';
    });
    const { c } = client(impl);
    c.start();
    await until(() => calls.length >= 10, 'ten attempts');
    c.stop();
    // after the working stream (8th connection) the sequence starts again: 1 s, then 2 s for the next failure
    expect(c.waits.slice(0, 9)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 1000, 2000]);
    expect([0, 1, 2, 5, 6, 10].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 30000, 30000, 30000]);
  });

  it('too many streams (429) and host unavailable (503) are retried; 401/403 end the session without retrying', async () => {
    const retried = fakeFetch((n) => (n === 1 ? 429 : n === 2 ? 503 : undefined));
    const a = client(retried.impl);
    a.c.start();
    await until(() => retried.calls.length === 3, 'third attempt');
    a.c.stop();
    for (const status of [401, 403]) {
      const refused = fakeFetch(() => status);
      const b = client(refused.impl);
      b.c.start();
      await until(() => b.ends.length === 1, `session end on ${status}`);
      await new Promise((r) => setTimeout(r, 30));
      expect(b.ends).toEqual(['UNAUTHORIZED']);
      expect(refused.calls).toHaveLength(1);
    }
  });

  it('the server ending the stream for the session stops the client; ending it for a restart reconnects', async () => {
    for (const reason of ['LOGGED_OUT', 'TOKEN_INVALID_OR_EXPIRED', 'ACCOUNT_INACTIVE', 'STORE_SUSPENDED', 'PAIRING_REVOKED']) {
      expect(SESSION_END_REASONS.has(reason)).toBe(true);
      const f = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 0) + endMsg(reason)), 1); });
      const x = client(f.impl);
      x.c.start();
      await until(() => x.ends.length === 1, reason);
      await new Promise((r) => setTimeout(r, 30));
      expect(x.ends).toEqual([reason]);
      expect(f.calls).toHaveLength(1);
    }
    const f = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 0) + endMsg('SERVER_SHUTDOWN')), 1); });
    const y = client(f.impl);
    y.c.start();
    await until(() => f.calls.length === 2, 'reconnect after shutdown');
    expect(y.ends).toEqual([]);
    y.c.stop();
  });

  it('stop() aborts the open request and nothing reconnects; without a token the client does not connect', async () => {
    const f = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', 0)), 1); });
    const statuses: string[] = [];
    const x = client(f.impl, { onStatus: (s) => statuses.push(s) });
    x.c.start();
    await until(() => statuses.includes('live'), 'live');
    x.c.stop();
    expect(f.calls[0].signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls).toHaveLength(1);
    expect(statuses.at(-1)).toBe('stopped');
    expect(x.ends).toEqual([]); // stopping on purpose is not a session end

    const none = fakeFetch(() => undefined);
    const z = client(none.impl, { getToken: () => null });
    z.c.start();
    await until(() => z.ends.length === 1, 'no token');
    expect([z.ends, none.calls.length]).toEqual([['NO_TOKEN'], 0]);
  });

  it('an all-stores stream (super admin) tracks each store separately and does not report its first events as gaps', async () => {
    const f = fakeFetch((n, conn) => { if (n === 1) setTimeout(() => conn.send(ready('boot-A', null, null) + change(7, 'sales', 1) + change(3, 'sales', 2) + change(8, 'sales', 1) + change(5, 'sales', 2)), 1); });
    const x = client(f.impl);
    x.c.start();
    await until(() => x.changes.length === 4, 'changes');
    expect(x.resyncs).toEqual(['gap']); // store 2 jumped from 3 to 5; store 1 is consecutive
    x.c.stop();
  });

  it('screens match their topics, and everything matches a full resync', () => {
    expect(liveDetailMatches({ topics: ['sales'], reason: 'change' }, ['inventory', 'purchases'])).toBe(false);
    expect(liveDetailMatches({ topics: ['purchases'], reason: 'change' }, ['inventory', 'purchases'])).toBe(true);
    expect(liveDetailMatches({ topics: 'all', reason: 'gap' }, ['sales'])).toBe(true);
  });
});
