/**
 * Phase 8c: desktop connection policy (electron/reconnect.ts, electron/proxyPolicy.ts).
 *  - reconnect backoff after a lost connection: 1 s, 2 s, 5 s, then every 10 s; stops on success / stop(); no
 *    duplicate schedules; nothing left running after stop
 *  - the live-event stream has its own idle timeout (45 s) above the 20 s keep-alive; every other request keeps 30 s
 *  - the 5 s heartbeat (3 s timeout) is unchanged
 * electron/connection.ts needs Electron, so its use of these values is checked in its source.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ReconnectScheduler, desktopReconnectDelay, DESKTOP_RECONNECT_DELAYS_MS } from '../../electron/reconnect';
import { proxyIdleTimeoutMs, isEventStream, API_PROXY_IDLE_TIMEOUT_MS, EVENT_STREAM_IDLE_TIMEOUT_MS, EVENT_STREAM_KEEPALIVE_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '../../electron/proxyPolicy';
import { LiveEventHub } from '../../server/events/liveEvents';

afterEach(() => { vi.useRealTimers(); });

describe('desktop reconnect backoff', () => {
  it('delays are 1 s, 2 s, 5 s, then 10 s for every later retry', () => {
    expect(DESKTOP_RECONNECT_DELAYS_MS).toEqual([1000, 2000, 5000, 10000]);
    expect([0, 1, 2, 3, 4, 9, 100].map(desktopReconnectDelay)).toEqual([1000, 2000, 5000, 10000, 10000, 10000, 10000]);
  });

  it('retries at 1 s, 2 s, 5 s, 10 s, 10 s ... until a check succeeds, then stops', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const at: number[] = [];
    const t0 = Date.now();
    const s = new ReconnectScheduler(async () => { calls++; at.push(Date.now() - t0); return calls === 6; });
    s.start();
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(6);
    expect(at).toEqual([1000, 3000, 8000, 18000, 28000, 38000]); // cumulative: 1, +2, +5, +10, +10, +10
    expect(s.delays).toEqual([1000, 2000, 5000, 10000, 10000, 10000]);
    expect(s.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // nothing left behind
  });

  it('start() while retrying does not add a second schedule; stop() clears the pending retry', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = new ReconnectScheduler(async () => { calls++; return false; });
    s.start();
    s.start();
    s.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  it('stop() during a running check: no retry is scheduled afterwards; a later start begins again at 1 s', async () => {
    vi.useFakeTimers();
    let release!: (v: boolean) => void;
    let calls = 0;
    const s = new ReconnectScheduler(() => { calls++; return new Promise<boolean>((r) => { release = r; }); });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    s.stop(); // e.g. monitoring stopped while the health check was still waiting
    release(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    s.start();
    expect(s.delays).toEqual([1000]);
  });

  it('a check that throws counts as "not yet" and the backoff continues', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = new ReconnectScheduler(async () => { calls++; if (calls < 3) throw new Error('host unreachable'); return true; });
    s.start();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 5000);
    expect(calls).toBe(3);
    expect(s.active).toBe(false);
  });
});

describe('event-stream timeout vs ordinary API requests', () => {
  it('GET /api/events gets 45 s; every other request keeps 30 s', () => {
    expect([API_PROXY_IDLE_TIMEOUT_MS, EVENT_STREAM_IDLE_TIMEOUT_MS]).toEqual([30_000, 45_000]);
    expect(proxyIdleTimeoutMs('GET', '/api/events')).toBe(45_000);
    expect(proxyIdleTimeoutMs('get', '/api/events')).toBe(45_000);
    for (const [m, p] of [['GET', '/api/inventory'], ['POST', '/api/sales'], ['GET', '/api/health'], ['POST', '/api/events'], ['GET', '/api/events/x'], ['GET', '/api/sales/history']]) {
      expect(proxyIdleTimeoutMs(m, p), `${m} ${p}`).toBe(30_000);
    }
    expect(isEventStream('GET', '/api/events')).toBe(true);
  });

  it('the stream timeout leaves room for one late keep-alive, and the server really sends one every 20 s', () => {
    expect(EVENT_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThan(2 * EVENT_STREAM_KEEPALIVE_MS);
    expect(API_PROXY_IDLE_TIMEOUT_MS).toBeGreaterThan(EVENT_STREAM_KEEPALIVE_MS);
    vi.useFakeTimers();
    const hub = new LiveEventHub(); // production intervals
    const res = Object.assign(new EventEmitter(), { frames: '', writableEnded: false, destroyed: false, writeHead() { return this; }, write(f: string) { this.frames += f; return true; }, end() { this.writableEnded = true; this.emit('close'); return this; } });
    hub.subscribe(res as any, { userId: 1, tenantId: 1, tokenHash: 'h', check: () => ({ ok: true }) });
    vi.advanceTimersByTime(EVENT_STREAM_KEEPALIVE_MS - 1);
    expect(res.frames).not.toContain(': keep-alive');
    vi.advanceTimersByTime(1);
    expect(res.frames).toContain(': keep-alive');
    hub.closeAll();
  });

  it('heartbeat unchanged: every 5 s with a 3 s timeout; connection.ts uses these values and the stream policy', () => {
    expect([HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS]).toEqual([5000, 3000]);
    const src = fs.readFileSync(path.join(__dirname, '../../electron/connection.ts'), 'utf8');
    expect(src).toMatch(/startMonitoring\(intervalMs = HEARTBEAT_INTERVAL_MS\)/);
    expect(src).toMatch(/setInterval\(\(\) => void this\.heartbeat\(\), intervalMs\)/);
    expect(src).toMatch(/timeoutMs: HEARTBEAT_TIMEOUT_MS/);
    expect(src).toMatch(/timeoutMs: proxyIdleTimeoutMs\(method, url\.pathname\)/);
    expect(src).not.toMatch(/timeoutMs: 30_000/); // no hard-coded proxy timeout left
  });
});
