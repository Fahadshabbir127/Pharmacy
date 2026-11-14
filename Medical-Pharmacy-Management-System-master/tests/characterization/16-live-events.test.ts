/**
 * Phase 8a: GET /api/events (server-sent events) on a real server.
 * Authentication (header only), events only after COMMIT, store isolation, sequence numbers and boot id,
 * keep-alive, closing on logout / expiry / account and store suspension / the periodic re-check, stream limits,
 * backup restore (full refresh) and graceful shutdown. No credentials or business data in events or logs.
 * (Pairing revocation of a LAN stream is covered in tests/unit/live-events.test.ts: requests from this computer
 * are loopback and never carry a paired-client identity.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { startServer, Api, RunningServer, BASE_URL, cartItem, salePayload } from '../helpers/server';

type Frame = { event?: string; data?: any; comment?: string };
class EventStream {
  status = 0;
  headers!: Headers;
  json: any;
  frames: Frame[] = [];
  raw = '';
  ended = false;
  private ctrl = new AbortController();
  static async open(token?: string | null, query = '') {
    const s = new EventStream();
    const res = await fetch(`${BASE_URL}/api/events${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: s.ctrl.signal });
    s.status = res.status;
    s.headers = res.headers;
    if (res.status !== 200) { s.json = await res.json(); s.ended = true; return s; }
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            s.raw += `${block}\n\n`;
            const f: Frame = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) f.comment = line.slice(1).trim();
              else if (line.startsWith('event: ')) f.event = line.slice(7);
              else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
            }
            s.frames.push(f);
          }
        }
      } catch { /* aborted */ }
      s.ended = true;
    })();
    return s;
  }
  of(kind: string) { return this.frames.filter((f) => f.event === kind).map((f) => f.data); }
  changes() { return this.of('change'); }
  close() { this.ctrl.abort(); }
  async until(cond: () => boolean, ms = 3000, what = 'condition') {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

let srv: RunningServer | undefined;
const streams: EventStream[] = [];
const open = async (token?: string | null, query = '') => { const s = await EventStream.open(token, query); streams.push(s); return s; };
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await srv?.stop();
  srv = undefined;
});
const login = async (u: string, p: string) => { const a = new Api(); await a.login(u, p); return a; };
const quiet = () => new Promise((r) => setTimeout(r, 400)); // time for an (unexpected) event to arrive

describe('authentication', () => {
  it('needs the Authorization header; a token in the URL is refused; bad tokens and customer accounts are refused', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    expect([(await open()).status, (await open()).json]).toEqual([401, { error: 'Access token required' }]);
    const inUrl = await open(admin.token, `?token=${admin.token}`);
    expect([inUrl.status, inUrl.json.code]).toEqual([400, 'TOKEN_IN_URL']);
    expect((await open(null, `?access_token=${admin.token}`)).status).toBe(400);
    expect((await open('not-a-token')).status).toBe(403);
    const ok = await open(admin.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/event-stream/);
    await ok.until(() => ok.of('ready').length === 1, 3000, 'ready');
    expect(ok.of('ready')[0]).toEqual({ bootId: ok.headers.get('x-braintech-boot-id'), tenantId: 1, seq: 0 });
  });
});

describe('events follow committed changes only', () => {
  it('a successful write emits {seq, topic, tenantId} in order; refused and invalid requests emit nothing', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    const s = await open(admin.token);
    expect((await admin.post('/customers', { name: 'Live Event Customer', phone: '03001112233' })).status).toBe(200);
    await s.until(() => s.changes().length === 2, 3000, 'customer events');
    expect(s.changes()).toEqual([{ seq: 1, topic: 'customers', tenantId: 1 }, { seq: 2, topic: 'sales', tenantId: 1 }]);
    // refused (409: not enough stock) and invalid (400) requests: nothing changed, nothing emitted
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    expect((await admin.post('/sales', salePayload([cartItem(p, 99_999)]))).status).toBe(409);
    expect((await admin.post('/customers', {})).status).toBe(400);
    await quiet();
    expect(s.changes()).toHaveLength(2);
    // a sale: sales, stock and customer balances may have changed; seq continues with no gap
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(200);
    await s.until(() => s.changes().length === 5, 3000, 'sale events');
    expect(s.changes().slice(2)).toEqual([{ seq: 3, topic: 'sales', tenantId: 1 }, { seq: 4, topic: 'inventory', tenantId: 1 }, { seq: 5, topic: 'customers', tenantId: 1 }]);
    // no business data, no credentials anywhere in the stream or the server log
    expect(s.raw).not.toMatch(/Live Event Customer|03001112233|admin123|INV-|grand_total|amount/);
    expect(s.raw.includes(admin.token!)).toBe(false);
    expect(srv.logs().includes(admin.token!)).toBe(false);
  });

  it('a sale that fails and is rolled back emits nothing (the next event is seq 1)', async () => {
    srv = await startServer({ env: { PHARMACY_TEST_THROW: 'sale-after-payments' } });
    const admin = await login('admin', 'admin123');
    const s = await open(admin.token);
    const p = (await admin.get('/inventory')).body.find((x: any) => x.id === 1);
    expect((await admin.post('/sales', salePayload([cartItem(p, 1)]))).status).toBe(500);
    await quiet();
    expect(s.changes()).toEqual([]);
    expect((await admin.post('/customers', { name: 'After Rollback', phone: '03004445566' })).status).toBe(200);
    await s.until(() => s.changes().length === 2, 3000, 'events after rollback');
    expect(s.changes()[0]).toEqual({ seq: 1, topic: 'customers', tenantId: 1 });
  });
});

describe('store isolation, suspension and account status', () => {
  it('each store sees only its own events; the super admin sees both; suspending a store or an account closes its streams at once', async () => {
    srv = await startServer();
    const sa = await login('superadmin', 'admin123');
    expect((await sa.post('/superadmin/tenants', { name: 'Second Pharmacy', owner_name: 'Owner Two', owner_email: 'owner2@test.local', owner_password: 'Owner123!' })).status).toBe(200);
    const t2 = ((await sa.get('/superadmin/tenants')).body as any[]).find((x) => x.owner_email === 'owner2@test.local');
    const owner2 = new Api();
    owner2.token = (await sa.post(`/superadmin/tenants/${t2.id}/login-as`, {})).body.token;
    const admin = await login('admin', 'admin123');
    const staff = await login('staff', 'staff123');
    const s1 = await open(admin.token);
    const s2 = await open(owner2.token);
    const sStaff = await open(staff.token);
    const sSa = await open(sa.token);
    await sSa.until(() => sSa.of('ready').length === 1);
    expect(sSa.of('ready')[0]).toMatchObject({ tenantId: null, seq: null });
    const sSaBefore = sSa.changes().length;

    expect((await admin.post('/customers', { name: 'Store One Customer', phone: '03007778899' })).status).toBe(200);
    expect((await owner2.post('/customers', { name: 'Store Two Customer', phone: '03009990000' })).status).toBe(200);
    await s1.until(() => s1.changes().length === 2);
    await s2.until(() => s2.changes().length === 2);
    await quiet();
    expect(s1.changes().every((e) => e.tenantId === 1)).toBe(true);
    expect(s2.changes().every((e) => e.tenantId === t2.id)).toBe(true);
    // store 2 counts on its own, with no gap after where its stream started (the "log in as" emitted nothing)
    expect(s2.changes().map((e) => e.seq)).toEqual([s2.of('ready')[0].seq + 1, s2.of('ready')[0].seq + 2]);
    expect(s2.of('ready')[0].seq).toBe(0);
    expect(new Set(sSa.changes().slice(sSaBefore).map((e) => e.tenantId))).toEqual(new Set([1, t2.id]));

    // suspend store 2: its stream ends at once; store 1 unaffected
    expect((await sa.put(`/superadmin/tenants/${t2.id}/status`, { status: 'SUSPENDED' })).status).toBe(200);
    await s2.until(() => s2.of('end').length === 1, 3000, 'store 2 stream end');
    expect(s2.of('end')).toEqual([{ reason: 'STORE_SUSPENDED' }]);
    await s2.until(() => s2.ended);
    // suspend the staff account: the staff stream ends at once; the admin's stays
    const staffId = ((await admin.get('/users')).body as any[]).find((u) => u.username === 'staff').id;
    expect((await admin.put(`/users/${staffId}/status`, { status: 'SUSPENDED' })).status).toBe(200);
    await sStaff.until(() => sStaff.of('end').length === 1, 3000, 'staff stream end');
    expect(sStaff.of('end')).toEqual([{ reason: 'ACCOUNT_INACTIVE' }]);
    expect(s1.ended).toBe(false);
    expect(sSa.ended).toBe(false);
  });

  it('the periodic re-check closes a stream whose account was disabled by any other means', async () => {
    srv = await startServer({ env: { PHARMACY_TEST_SSE_REVALIDATE_MS: '300' } });
    const staff = await login('staff', 'staff123');
    const s = await open(staff.token);
    await s.until(() => s.of('ready').length === 1);
    // changed outside any API route (e.g. by a restore or a tool): only the periodic re-check can notice
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(srv.dbFile);
    db.prepare("UPDATE users SET status = 'SUSPENDED' WHERE username = 'staff'").run();
    db.close();
    await s.until(() => s.of('end').length === 1, 3000, 'periodic re-check');
    expect(s.of('end')).toEqual([{ reason: 'ACCOUNT_INACTIVE' }]);
  });
});

describe('token expiry, logout and limits', () => {
  it('a stream ends when its token expires', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    const secret = fs.readFileSync(path.join(srv.workDir, 'data', 'jwt.secret'), 'utf8').trim();
    const claims = jwt.decode(admin.token!) as any;
    const shortLived = jwt.sign({ id: claims.id, username: claims.username, role: claims.role, fullName: claims.fullName, tenant_id: claims.tenant_id }, secret, { expiresIn: 2 });
    const s = await open(shortLived);
    expect(s.status).toBe(200);
    await s.until(() => s.of('end').length === 1, 5000, 'expiry');
    expect(s.of('end')).toEqual([{ reason: 'TOKEN_INVALID_OR_EXPIRED' }]);
  });

  it('logout ends only the streams of that token', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    const staff = await login('staff', 'staff123');
    const a = await open(admin.token);
    const b = await open(staff.token);
    await b.until(() => b.of('ready').length === 1);
    const out = await admin.post('/auth/logout', {});
    expect(out.body).toEqual({ loggedOut: true, closedStreams: 1 });
    await a.until(() => a.of('end').length === 1);
    expect(a.of('end')).toEqual([{ reason: 'LOGGED_OUT' }]);
    await quiet();
    expect(b.ended).toBe(false);
  });

  it('at most 5 streams per user; a closed stream frees its place', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    const five = [];
    for (let i = 0; i < 5; i++) five.push(await open(admin.token));
    expect(five.map((s) => s.status)).toEqual([200, 200, 200, 200, 200]);
    const sixth = await open(admin.token);
    expect([sixth.status, sixth.json.code]).toEqual([429, 'STREAM_LIMIT']);
    expect((await open((await login('staff', 'staff123')).token)).status).toBe(200); // another user is not affected
    five[0].close();
    const t0 = Date.now();
    let again = await open(admin.token);
    while (again.status === 429 && Date.now() - t0 < 3000) { await new Promise((r) => setTimeout(r, 50)); again = await open(admin.token); }
    expect(again.status).toBe(200);
  });
});

describe('keep-alive, boot id, restore and shutdown', () => {
  it('keep-alive comments arrive on the interval', async () => {
    srv = await startServer({ env: { PHARMACY_TEST_SSE_KEEPALIVE_MS: '150' } });
    const s = await open((await login('admin', 'admin123')).token);
    await s.until(() => s.frames.filter((f) => f.comment === 'keep-alive').length >= 2, 3000, 'keep-alive');
  });

  it('a restart has a new boot id and the sequence starts again', async () => {
    srv = await startServer();
    let admin = await login('admin', 'admin123');
    const a = await open(admin.token);
    await a.until(() => a.of('ready').length === 1);
    await admin.post('/customers', { name: 'Before Restart', phone: '03001231234' });
    await a.until(() => a.changes().length === 2);
    const boot1 = a.of('ready')[0].bootId;
    a.close();
    const workDir = srv.workDir;
    await srv.stop();
    srv = await startServer({ workDir });
    admin = await login('admin', 'admin123');
    const b = await open(admin.token);
    await b.until(() => b.of('ready').length === 1);
    expect(b.of('ready')[0].bootId).not.toBe(boot1);
    expect(b.of('ready')[0].seq).toBe(0);
  });

  it('a backup restore sends a full-refresh "backups" event; streams of accounts that still exist stay open', async () => {
    srv = await startServer();
    const admin = await login('admin', 'admin123');
    const exp = await admin.post('/backup/export', { password: 'Backup123!' });
    expect(exp.status).toBe(200);
    const s = await open(admin.token);
    await s.until(() => s.of('ready').length === 1);
    expect((await admin.post('/backup/import', { backupPayload: exp.body, password: 'Backup123!' })).status).toBe(200);
    await s.until(() => s.changes().some((e) => e.topic === 'backups'), 3000, 'backups event');
    expect(s.changes().filter((e) => e.topic === 'backups')).toEqual([expect.objectContaining({ topic: 'backups', tenantId: 1 })]);
    await quiet();
    expect(s.ended).toBe(false);
  });

  it('graceful shutdown ends every stream first, so the server stops at once (not after the 5 s fallback)', async () => {
    srv = await startServer({ ipc: true });
    const admin = await login('admin', 'admin123');
    const a = await open(admin.token);
    const b = await open(admin.token);
    await b.until(() => b.of('ready').length === 1);
    const t0 = Date.now();
    expect(await srv.requestShutdown()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(4000);
    for (const s of [a, b]) {
      await s.until(() => s.ended);
      expect(s.of('end')).toEqual([{ reason: 'SERVER_SHUTDOWN' }]);
    }
    expect(srv.logs()).toMatch(/\[SHUTDOWN\] parent process request received/);
  });
});
