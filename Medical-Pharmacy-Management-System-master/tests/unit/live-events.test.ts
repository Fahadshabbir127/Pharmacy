/**
 * Phase 8a: the live-event hub (server/events/liveEvents.ts) on its own: per-store sequence numbers, isolation,
 * payload shape, limits, keep-alive, re-checks (account, store, token expiry, pairing revocation) and closing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LiveEventHub, topicsForWrite, hashToken, LIMITS, StreamLimitError, type StreamCheck } from '../../server/events/liveEvents';

/** The parts of an Express Response the hub uses. */
class FakeRes extends EventEmitter {
  frames = '';
  status = 0;
  headers: Record<string, string> = {};
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; return this; }
  write(chunk: string) { this.frames += chunk; return true; }
  end() { this.writableEnded = true; this.emit('close'); return this; }
  /** parsed events of one kind */
  events(kind: string) {
    return this.frames.split('\n\n').filter((f) => f.startsWith(`event: ${kind}\n`)).map((f) => JSON.parse(f.split('data: ')[1]));
  }
}
const hubs: LiveEventHub[] = [];
const newHub = (opts: ConstructorParameters<typeof LiveEventHub>[0] = {}) => { const h = new LiveEventHub(opts); hubs.push(h); return h; };
afterEach(() => { for (const h of hubs.splice(0)) h.closeAll(); vi.useRealTimers(); });
const ok = (): StreamCheck => ({ ok: true });
const sub = (hub: LiveEventHub, over: Partial<Parameters<LiveEventHub['subscribe']>[1]> = {}) => {
  const res = new FakeRes();
  hub.subscribe(res as any, { userId: 1, tenantId: 1, tokenHash: 'h1', check: ok, ...over });
  return res;
};

describe('change events', () => {
  it('payload is exactly {seq, topic, tenantId}; seq counts per store from 1; the stream starts with a ready message and the boot id', () => {
    const hub = newHub();
    const a = sub(hub);
    expect(a.status).toBe(200);
    expect(a.headers['Content-Type']).toMatch(/^text\/event-stream/);
    expect(a.headers['X-BrainTech-Boot-Id']).toBe(hub.bootId);
    expect(a.events('ready')).toEqual([{ bootId: hub.bootId, tenantId: 1, seq: 0 }]);
    hub.emit(1, 'sales');
    hub.emit(2, 'sales'); // another store: its own counter
    hub.emit(1, 'inventory');
    expect(a.events('change')).toEqual([{ seq: 1, topic: 'sales', tenantId: 1 }, { seq: 2, topic: 'inventory', tenantId: 1 }]);
    for (const e of a.events('change')) expect(Object.keys(e).sort()).toEqual(['seq', 'tenantId', 'topic']);
    expect(hub.seqOf(1)).toBe(2);
    expect(hub.seqOf(2)).toBe(1);
    // a later subscriber learns where the store's sequence stands
    expect(sub(hub).events('ready')[0].seq).toBe(2);
    expect(() => hub.emit(1, 'secrets' as any)).toThrow(/unknown live-event topic/);
  });

  it('store isolation: a store sees only its own events; a SUPER_ADMIN stream (tenantId null) sees every store', () => {
    const hub = newHub();
    const s1 = sub(hub, { tenantId: 1 });
    const s2 = sub(hub, { userId: 2, tenantId: 2 });
    const sa = sub(hub, { userId: 3, tenantId: null });
    hub.emit(1, 'customers');
    hub.emit(2, 'purchases');
    expect(s1.events('change')).toEqual([{ seq: 1, topic: 'customers', tenantId: 1 }]);
    expect(s2.events('change')).toEqual([{ seq: 1, topic: 'purchases', tenantId: 2 }]);
    expect(sa.events('change')).toEqual([{ seq: 1, topic: 'customers', tenantId: 1 }, { seq: 1, topic: 'purchases', tenantId: 2 }]);
    expect(sa.events('ready')).toEqual([{ bootId: hub.bootId, tenantId: null, seq: null }]);
  });

  it('every server start has a new boot id', () => {
    expect(newHub().bootId).not.toBe(newHub().bootId);
  });

  it('keep-alive comments are sent on the interval', async () => {
    const hub = newHub({ keepAliveMs: 30 });
    const a = sub(hub);
    await new Promise((r) => setTimeout(r, 110));
    expect((a.frames.match(/: keep-alive\n\n/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('limits', () => {
  it('per user, per paired computer and in total; a closed stream frees its place', () => {
    const hub = newHub({ limits: { perUser: 2, perPairedClient: 3, total: 4 } });
    const a = sub(hub, { userId: 1 });
    sub(hub, { userId: 1 });
    expect(() => sub(hub, { userId: 1 })).toThrow(StreamLimitError);
    a.end(); // the client went away
    sub(hub, { userId: 1 });
    sub(hub, { userId: 2, pairedClientId: 9 });
    expect(() => sub(hub, { userId: 3, pairedClientId: 9 })).not.toThrow(); // 2 from computer 9 (limit 3)
    expect(() => sub(hub, { userId: 4 })).toThrow(/too many live connections/i); // total 4 reached
    expect(LIMITS).toEqual({ perUser: 5, perPairedClient: 10, total: 200 });
  });
});

describe('closing streams', () => {
  it('re-check closes only streams that fail it, with the reason code (account, store, pairing)', () => {
    const hub = newHub();
    let accountOk = true;
    let pairingOk = true;
    const a = sub(hub, { userId: 1, check: () => (accountOk ? { ok: true } : { ok: false, reason: 'ACCOUNT_INACTIVE' }) });
    const b = sub(hub, { userId: 2, pairedClientId: 5, check: () => (pairingOk ? { ok: true } : { ok: false, reason: 'PAIRING_REVOKED' }) });
    const c = sub(hub, { userId: 3 });
    expect(hub.revalidate()).toBe(0);
    accountOk = false;
    expect(hub.revalidate()).toBe(1);
    expect(a.events('end')).toEqual([{ reason: 'ACCOUNT_INACTIVE' }]);
    expect(a.writableEnded).toBe(true);
    pairingOk = false;
    expect(hub.revalidate()).toBe(1);
    expect(b.events('end')).toEqual([{ reason: 'PAIRING_REVOKED' }]);
    expect(c.writableEnded).toBe(false);
    expect(hub.streamCount).toBe(1);
  });

  it('revoking a paired computer closes only its streams at once', () => {
    const hub = newHub();
    const lan = sub(hub, { userId: 1, pairedClientId: 7 });
    const other = sub(hub, { userId: 1, pairedClientId: 8 });
    expect(hub.closeWhere((s) => s.pairedClientId === 7, 'PAIRING_REVOKED')).toBe(1);
    expect(lan.events('end')).toEqual([{ reason: 'PAIRING_REVOKED' }]);
    expect(other.writableEnded).toBe(false);
  });

  it('logout closes only the streams of that token', () => {
    const hub = newHub();
    const mine = sub(hub, { tokenHash: hashToken('token-A') });
    const theirs = sub(hub, { tokenHash: hashToken('token-B') });
    expect(hub.closeWhere((s) => s.tokenHash === hashToken('token-A'), 'LOGGED_OUT')).toBe(1);
    expect(mine.events('end')).toEqual([{ reason: 'LOGGED_OUT' }]);
    expect(theirs.writableEnded).toBe(false);
  });

  it('a stream is re-checked when its token expires (not only on the 60 s interval)', async () => {
    const hub = newHub({ revalidateMs: 60_000 });
    let expired = false;
    const a = sub(hub, { tokenExp: Math.floor(Date.now() / 1000) + 1, check: () => (expired ? { ok: false, reason: 'TOKEN_INVALID_OR_EXPIRED' } : { ok: true }) });
    expired = true; // what verifying the token will say once it has expired
    await new Promise((r) => setTimeout(r, 1300));
    expect(a.events('end')).toEqual([{ reason: 'TOKEN_INVALID_OR_EXPIRED' }]);
  });

  it('a check that throws closes the stream (fail closed)', () => {
    const hub = newHub();
    const a = sub(hub, { check: () => { throw new Error('database gone'); } });
    hub.revalidate();
    expect(a.events('end')).toEqual([{ reason: 'CHECK_FAILED' }]);
  });

  it('shutdown closes every stream with SERVER_SHUTDOWN and stops the timers', () => {
    const hub = newHub({ keepAliveMs: 10, revalidateMs: 10 });
    const a = sub(hub);
    const b = sub(hub, { userId: 2, tenantId: null });
    expect(hub.closeAll()).toBe(2);
    for (const r of [a, b]) {
      expect(r.events('end')).toEqual([{ reason: 'SERVER_SHUTDOWN' }]);
      expect(r.writableEnded).toBe(true);
    }
    expect(hub.streamCount).toBe(0);
  });

  it('emitting to a client that has gone away removes it instead of throwing', () => {
    const hub = newHub();
    const a = sub(hub);
    a.destroyed = true;
    expect(() => hub.emit(1, 'sales')).not.toThrow();
    expect(hub.streamCount).toBe(0);
  });
});

describe('which writes emit which topics', () => {
  it('maps route groups to topics; reads, login, pairing and the price quote emit nothing', () => {
    expect(topicsForWrite('POST', '/api/sales')).toEqual(['sales', 'inventory', 'customers']);
    expect(topicsForWrite('DELETE', '/api/sales/12')).toEqual(['sales', 'inventory', 'customers']);
    expect(topicsForWrite('POST', '/api/sales/quote')).toEqual([]);
    expect(topicsForWrite('POST', '/api/payments/3/reverse')).toEqual(['sales', 'customers']);
    expect(topicsForWrite('POST', '/api/customers/2/payment')).toEqual(['customers', 'sales']);
    expect(topicsForWrite('POST', '/api/inventory/adjust')).toEqual(['inventory']);
    expect(topicsForWrite('PUT', '/api/batches/4')).toEqual(['inventory']);
    expect(topicsForWrite('POST', '/api/purchases')).toEqual(['purchases', 'inventory']);
    expect(topicsForWrite('PUT', '/api/settings')).toEqual(['settings']);
    expect(topicsForWrite('PUT', '/api/users/3/status')).toEqual(['users']);
    expect(topicsForWrite('PUT', '/api/superadmin/tenants/2/status')).toEqual(['users', 'settings']);
    for (const [m, p] of [['GET', '/api/sales/history'], ['POST', '/api/auth/login'], ['POST', '/api/pair/complete'], ['POST', '/api/local/clients/1/revoke'], ['POST', '/api/sms/queue'], ['POST', '/api/setup/initial-admin'], ['POST', '/api/superadmin/tenants/2/login-as']]) {
      expect(topicsForWrite(m, p), `${m} ${p}`).toEqual([]);
    }
  });
});
