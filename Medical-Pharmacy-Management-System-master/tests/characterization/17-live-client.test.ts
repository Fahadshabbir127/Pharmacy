/**
 * Phase 8b: the front end's live-event client (src/lib/liveEvents.ts) against a real server: it receives changes,
 * reconnects after the server restarts and asks for a full refresh (new boot id), and stops when the session ends.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startServer, Api, RunningServer, BASE_URL } from '../helpers/server';
import { LiveEventClient, type LiveChange, type ResyncReason, type LiveStatus } from '../../src/lib/liveEvents';

let srv: RunningServer | undefined;
const clients: LiveEventClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await srv?.stop();
  srv = undefined;
});
async function until(cond: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
}
function liveClient(token: () => string | null) {
  const log = { changes: [] as LiveChange[], resyncs: [] as ResyncReason[], ends: [] as string[], statuses: [] as LiveStatus[] };
  const c = new LiveEventClient({
    url: `${BASE_URL}/api/events`, getToken: token,
    onChange: (x) => log.changes.push(x), onResync: (r) => log.resyncs.push(r), onSessionEnd: (r) => log.ends.push(r), onStatus: (s) => log.statuses.push(s),
    backoff: { initialMs: 100, maxMs: 1000 }, // short waits for the test; the app uses 1 s .. 30 s
  });
  clients.push(c);
  return { c: c.start(), log };
}

describe('live-event client against the real server', () => {
  it('receives changes; after a server restart it reconnects on its own and reports the new boot id; the sequence continues without a false gap', async () => {
    srv = await startServer();
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const { log } = liveClient(() => admin.token);
    await until(() => log.statuses.includes('live'), 'live');
    expect((await admin.post('/customers', { name: 'Live Client One', phone: '03002223344' })).status).toBe(200);
    await until(() => log.changes.length === 2, 'two changes');
    expect(log.changes.map((x) => x.topic)).toEqual(['customers', 'sales']);
    expect(log.resyncs).toEqual([]);

    const workDir = srv.workDir;
    await srv.stop(); // the stream drops; the client keeps retrying with backoff
    srv = await startServer({ workDir });
    await until(() => log.resyncs.includes('boot-changed'), 'reconnect to the restarted server');
    expect(log.ends).toEqual([]);

    expect((await admin.post('/customers', { name: 'Live Client Two', phone: '03005556677' })).status).toBe(200);
    await until(() => log.changes.length === 4, 'changes after restart');
    expect(log.changes.slice(2).map((x) => x.seq)).toEqual([1, 2]); // the new server counts from 1
    expect(log.resyncs).toEqual(['boot-changed']); // no "gap" from the restarted numbering
  });

  it('logout and a suspended account end the session: the client stops and does not reconnect', async () => {
    srv = await startServer();
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const staff = new Api();
    await staff.login('staff', 'staff123');
    const a = liveClient(() => admin.token);
    const s = liveClient(() => staff.token);
    await until(() => a.log.statuses.includes('live') && s.log.statuses.includes('live'), 'both live');

    const staffId = ((await admin.get('/users')).body as any[]).find((u) => u.username === 'staff').id;
    expect((await admin.put(`/users/${staffId}/status`, { status: 'SUSPENDED' })).status).toBe(200);
    await until(() => s.log.ends.length === 1, 'staff session end');
    expect(s.log.ends).toEqual(['ACCOUNT_INACTIVE']);

    expect((await admin.post('/auth/logout', {})).body.closedStreams).toBe(1);
    await until(() => a.log.ends.length === 1, 'admin session end');
    expect(a.log.ends).toEqual(['LOGGED_OUT']);
    await new Promise((r) => setTimeout(r, 400));
    expect([a.c.stopped, s.c.stopped]).toEqual([true, true]);
    expect(a.log.statuses.at(-1)).toBe('stopped');
  });
});
