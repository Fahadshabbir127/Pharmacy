/**
 * Phase 8c: timeouts of the desktop app's connection to the backend (kept free of Electron imports so they can be
 * unit-tested; used by electron/connection.ts).
 *
 *  - ordinary API requests: an idle timeout of 30 s (unchanged)
 *  - the live-event stream (GET /api/events) stays open for hours and is silent between changes; the host sends a
 *    keep-alive comment every 20 s, which resets the idle timer. Its own timeout of 45 s tolerates one late keep-alive
 *    and still notices a host that has gone away (the stream then ends and the window's client reconnects).
 *  - heartbeat: /api/health every 5 s with a 3 s timeout (unchanged)
 */
export const API_PROXY_IDLE_TIMEOUT_MS = 30_000;
export const EVENT_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 3_000;

/** the server's keep-alive interval for the event stream (server/events/liveEvents.ts) */
export const EVENT_STREAM_KEEPALIVE_MS = 20_000;

export function isEventStream(method: string, pathname: string): boolean {
  return method.toUpperCase() === 'GET' && pathname === '/api/events';
}

/** Idle timeout for a request the window sends through the proxy. */
export function proxyIdleTimeoutMs(method: string, pathname: string): number {
  return isEventStream(method, pathname) ? EVENT_STREAM_IDLE_TIMEOUT_MS : API_PROXY_IDLE_TIMEOUT_MS;
}
