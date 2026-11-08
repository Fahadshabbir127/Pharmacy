/**
 * Characterisation: authentication, authorisation, OTP, tenant/customer isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { startServer, Api, RunningServer } from '../helpers/server';
import { editDbFile, openReadOnly, one } from '../helpers/db';

const HARDCODED_SECRET = 'khushi_medical_hall_secret_key_2026';

describe('auth & authorisation', () => {
  let srv: RunningServer;
  beforeAll(async () => { srv = await startServer(); });
  afterAll(async () => { await srv?.stop(); });

  it('login returns token + user profile with tenant info', async () => {
    const r = await new Api().post('/auth/login', { username: 'admin', password: 'admin123' });
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.user).toMatchObject({ username: 'admin', role: 'ADMIN', tenant_id: 1, tenant_name: 'Khushi Medical Hall', status: 'APPROVED' });
  });

  it('login token expires in 7 days', async () => {
    const r = await new Api().post('/auth/login', { username: 'staff', password: 'staff123' });
    const decoded: any = jwt.decode(r.body.token);
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 3600);
  });

  it('rejects missing credentials (400) and wrong password (401 with attempts remaining)', async () => {
    const api = new Api();
    expect((await api.post('/auth/login', {})).status).toBe(400);
    const r = await api.post('/auth/login', { username: 'staff', password: 'nope' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/4 attempts remaining/);
  });

  it('locks an account for 15 minutes after 5 failed attempts (429), even with the right password', async () => {
    const api = new Api();
    let last: any;
    for (let i = 0; i < 5; i++) last = await api.post('/auth/login', { username: 'lockme-unknown', password: 'x' });
    expect(last.status).toBe(429);
  });

  it('a real user locked after 5 failures cannot log in with the correct password', async () => {
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const create = await admin.post('/users', { username: 'locktest', password: 'Locktest123', fullName: 'Lock Test', role: 'STAFF', email: 'lock@test.local' });
    expect(create.status).toBe(200);
    const api = new Api();
    for (let i = 0; i < 5; i++) await api.post('/auth/login', { username: 'locktest', password: 'wrong' });
    const r = await api.post('/auth/login', { username: 'locktest', password: 'Locktest123' });
    expect(r.status).toBe(429);
  });

  it('protected routes require a token (401) and a valid signature (403)', async () => {
    const api = new Api();
    expect((await api.get('/inventory')).status).toBe(401);
    api.token = 'garbage';
    expect((await api.get('/inventory')).status).toBe(403);
  });

  it('role checks: STAFF cannot manage users (403); ADMIN can', async () => {
    const staff = new Api();
    await staff.login('staff', 'staff123');
    expect((await staff.get('/users')).status).toBe(403);
    const admin = new Api();
    await admin.login('admin', 'admin123');
    expect((await admin.get('/users')).status).toBe(200);
  });

  it('[LEGACY-SECURITY S1] a token forged with the hardcoded secret is accepted, and the role claim is trusted', async () => {
    const db = await openReadOnly(srv.dbFile);
    const staffId = one<{ id: number }>(db, "SELECT id FROM users WHERE username='staff'")!.id;
    const forged = jwt.sign({ id: staffId, username: 'staff', role: 'ADMIN', fullName: 'x', tenant_id: 1 }, HARDCODED_SECRET);
    const api = new Api();
    api.token = forged;
    expect((await api.get('/users')).status).toBe(200); // STAFF escalated to ADMIN
  });

  it('[LEGACY-SECURITY S9] STAFF can read all settings including SMTP/Twilio secret fields', async () => {
    const staff = new Api();
    await staff.login('staff', 'staff123');
    const r = await staff.get('/settings');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('smtp_pass');
    expect(r.body).toHaveProperty('twilio_auth_token');
  });

  it('[LEGACY-SECURITY S11] allowed_services is not enforced by the backend', async () => {
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const db = await openReadOnly(srv.dbFile);
    const staffId = one<{ id: number }>(db, "SELECT id FROM users WHERE username='staff'")!.id;
    const r = await admin.put(`/users/${staffId}/permissions`, { allowed_services: 'POS_BILLING' });
    expect(r.status).toBe(200);
    const staff = new Api();
    const u = await staff.login('staff', 'staff123');
    expect(u.allowed_services).toBe('POS_BILLING');
    expect((await staff.get('/purchases')).status).toBe(200); // PURCHASES not allowed in UI, but API serves it
  });

  it('customer can only see own invoices (IDOR protection on /sales/:id)', async () => {
    const cust = new Api();
    await cust.login('03001234567', 'customer123');
    expect((await cust.get('/sales/1')).status).toBe(200); // INV-1001 belongs to customer 1
    const portal = await cust.get('/customer-portal/me');
    expect(portal.status).toBe(200);
    expect(portal.body.customer.id).toBe(1);
  });

  it('[LEGACY-SECURITY] CUSTOMER role can read the full inventory list (route only requires a token)', async () => {
    const cust = new Api();
    await cust.login('03001234567', 'customer123');
    const r = await cust.get('/inventory');
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body[0]).toHaveProperty('purchase_price');
  });
});

describe('OTP flows', () => {
  let srv: RunningServer;
  beforeAll(async () => { srv = await startServer(); });
  afterAll(async () => { await srv?.stop(); });

  it('[LEGACY-SECURITY S4] registration OTP code is returned in the API response', async () => {
    const r = await new Api().post('/auth/send-otp', { email: 'newbie@test.local' });
    expect(r.status).toBe(200);
    expect(r.body.otp_code).toMatch(/^\d{6}$/);
  });

  it('registration with OTP creates a PENDING CUSTOMER that cannot log in until approved', async () => {
    const api = new Api();
    const otp = (await api.post('/auth/send-otp', { email: 'reg@test.local' })).body.otp_code;
    const r = await api.post('/auth/register', { email: 'reg@test.local', fullName: 'Reg User', password: 'Passw0rd!', otp_code: otp, role: 'ADMIN' });
    expect(r.status).toBe(200);
    const db = await openReadOnly(srv.dbFile);
    expect(one(db, "SELECT role, status FROM users WHERE username='reg@test.local'")).toEqual({ role: 'CUSTOMER', status: 'PENDING' });
    const login = await api.post('/auth/login', { username: 'reg@test.local', password: 'Passw0rd!' });
    expect(login.status).toBe(403);
  });

  it('OTP is single-use (replay rejected)', async () => {
    const api = new Api();
    const otp = (await api.post('/auth/send-otp', { email: 'once@test.local' })).body.otp_code;
    expect((await api.post('/auth/register', { email: 'once@test.local', fullName: 'Once', password: 'Passw0rd!', otp_code: otp })).status).toBe(200);
    expect((await api.post('/auth/register', { email: 'once2@test.local', fullName: 'Once', password: 'Passw0rd!', otp_code: otp })).status).toBe(400);
  });

  it('send-otp is rate limited to 3 per email per 10 minutes', async () => {
    const api = new Api();
    for (let i = 0; i < 3; i++) expect((await api.post('/auth/send-otp', { email: 'rate@test.local' })).status).toBe(200);
    expect((await api.post('/auth/send-otp', { email: 'rate@test.local' })).status).toBe(429);
  });

  it('[LEGACY-SECURITY S4] login OTP is returned in the response and logs the user in', async () => {
    const api = new Api();
    const s = await api.post('/auth/send-login-otp', { email: 'superadmin@khushipos.com' });
    expect(s.status).toBe(200);
    expect(s.body.otp_code).toMatch(/^\d{6}$/);
    const l = await api.post('/auth/login-otp', { email: 'superadmin@khushipos.com', otp_code: s.body.otp_code });
    expect(l.status).toBe(200);
    expect(l.body.user.role).toBe('SUPER_ADMIN');
  });

  it('[LEGACY-SECURITY] send-login-otp reveals whether an account exists (404 vs 200)', async () => {
    expect((await new Api().post('/auth/send-login-otp', { email: 'nobody@nowhere.test' })).status).toBe(404);
  });
});

describe('OTP expiry comparison', () => {
  it('[LEGACY-BUG] an OTP that expired earlier the same UTC day is still accepted (ISO "T" vs SQLite " " text compare)', async (ctx) => {
    const t = new Date();
    if (t.getUTCHours() === 0 && t.getUTCMinutes() < 2) ctx.skip(); // cannot build a same-day expired OTP right after UTC midnight
    let srv = await startServer();
    const workDir = srv.workDir;
    const dbFile = srv.dbFile;
    await srv.stop();
    // expired 1 hour ago, same UTC day if possible
    const now = new Date();
    const expired = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 1)).toISOString();
    await editDbFile(dbFile, (db) => {
      db.run("INSERT INTO otp_verifications (email, otp_code, expires_at) VALUES ('expired@test.local', '123456', ?)", [expired]);
    });
    srv = await startServer({ workDir });
    try {
      const r = await new Api().post('/auth/register', { email: 'expired@test.local', fullName: 'Exp', password: 'Passw0rd!', otp_code: '123456' });
      expect(r.status).toBe(200); // expired, but accepted
    } finally {
      await srv.stop();
    }
  });
});
