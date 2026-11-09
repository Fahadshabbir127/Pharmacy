import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cron from 'node-cron';
import { DbAdapter } from './server/db/adapter';
import { openDatabase, checkExistingDatabase, DatabaseIntegrityError } from './server/db/open';
import { MigrationError } from './server/db/migrate';
import { transactionalRoute } from './server/db/transactionalRoute';
import { seedLegacyTestData, seedDemoCatalog, defaultSettingsForNewStore } from './server/seed';
import https from 'node:https';
import os from 'node:os';
import { z } from 'zod';
import { API_PROTOCOL, APP_VERSION, serverMode, isLoopback, normalizeAddress, localIPv4Addresses } from './server/config';
import { lanGuard } from './server/lan/guard';
import { PairingManager, PairingError, hashToken, safeEqualHex } from './server/lan/pairing';
import { certificateFingerprint, shortFingerprint } from './server/lan/tls';
import { loadOrCreateJwtSecret } from './server/security/jwtSecret';
import { currentVersion } from './server/db/migrate';

const PORT = Number(process.env.PHARMACY_PORT) || 3000;
// C8: per-installation secret (set in startServer). The original public fallback secret is gone.
let JWT_SECRET = '';
const DATA_DIR = process.env.PHARMACY_DATA_DIR ? path.resolve(process.env.PHARMACY_DATA_DIR) : path.join(process.cwd(), 'data');
// The desktop app uses 'pharmacy.sqlite'; tests and the legacy browser setup keep the original name.
const DB_FILE = path.join(DATA_DIR, process.env.PHARMACY_DB_FILENAME || 'khushi_pharmacy.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db: DbAdapter;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** Wrap a synchronous route handler in one DB transaction (response sent only after COMMIT). */
// Crash-test hook (tests only): PHARMACY_TEST_CRASH="<before-commit|after-commit>:<METHOD> <path>" hard-kills the
// process at that point of the matching request. Unset in normal use, so it does nothing.
const crashSpec = (process.env.PHARMACY_TEST_CRASH || '').match(/^(before-commit|after-commit):(\w+) (\S+)$/);
const crashIf = (point: string) => (req: express.Request) => {
  if (crashSpec && crashSpec[1] === point && req.method === crashSpec[2] && req.path === crashSpec[3]) {
    // PHARMACY_TEST_CRASH_ONCE_FILE: crash only the first time (a marker file records that it happened)
    const once = process.env.PHARMACY_TEST_CRASH_ONCE_FILE;
    if (once) {
      if (fs.existsSync(once)) return;
      fs.writeFileSync(once, new Date().toISOString());
    }
    process.kill(process.pid, 'SIGKILL');
  }
};
const txHooks = crashSpec ? { beforeCommit: crashIf('before-commit'), afterCommit: crashIf('after-commit') } : {};
const tx = <H extends (...args: any[]) => any>(handler: H) => transactionalRoute(() => db, handler as any, txHooks);

// Database Initialization with Tables and Sample Data
async function initDatabase() {
  // Integrity check (read-only), then versioned migrations with a verified pre-migration backup.
  // A damaged database stops startup and is left untouched (see server/db/open.ts).
  const opened = await openDatabase(DB_FILE, { backupDir: BACKUP_DIR, log: (m) => console.log(`[DB] ${m}`) });
  db = opened.db;

  // Startup data tasks. Idempotent and safe on every start:
  //  - no accounts are created, re-activated, renamed or have their password changed (C4, R8)
  //  - no barcodes are invented (C11)
  //  - optional seeding runs BEFORE the tenant backfill so seeded rows get tenant #1 (first-boot bug)
  db.transaction(() => {
    const userCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_placeholder = 0")!.n;
    if (userCount === 0 && process.env.PHARMACY_TEST_LEGACY_SEED === '1') {
      console.log('[DB] PHARMACY_TEST_LEGACY_SEED=1: loading the original demo seed (tests only)');
      seedLegacyTestData(db);
    }

    // Default message templates (only fill keys that are missing; existing pharmacies keep their own text)
    for (const [k, v] of [
      ['msg_template_udhar_reminder', 'Dear {name}, your outstanding balance at {store_name} is Rs. {balance}. Kindly clear it at your earliest convenience. Thank you!'],
      ['msg_template_payment_receipt', 'Dear {name}, we have received your payment. Your remaining balance at {store_name} is Rs. {balance}. Thank you!'],
      ['msg_template_refill', 'Dear {name}, your regular medicine at {store_name} may be running low. Visit us for a refill.'],
      ['msg_template_welcome', 'Dear {name}, welcome to {store_name}! Your account is active. Thank you!'],
    ]) db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]);

    db.run("UPDATE tenants SET allowed_services = 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL' WHERE allowed_services IS NULL OR allowed_services = ''");

    // A database from the oldest app versions has users but no stores: create store #1 from its own settings
    const hasStore = db.get("SELECT 1 AS x FROM tenants WHERE id = 1");
    if (!hasStore && db.get("SELECT 1 AS x FROM users WHERE is_placeholder = 0 LIMIT 1")) {
      const setting = (k: string) => db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [k])?.value || '';
      db.run(
        "INSERT INTO tenants (id, name, owner_name, owner_email, phone, address, status, plan) VALUES (1, ?, ?, ?, ?, ?, 'ACTIVE', 'PRO')",
        [setting('store_name') || 'My Pharmacy', setting('owner_name') || 'Owner', `store-1-owner@local.invalid`, setting('phone'), setting('address')],
      );
    }
    if (db.get("SELECT 1 AS x FROM tenants WHERE id = 1")) {
      db.run("UPDATE users SET tenant_id = 1 WHERE tenant_id IS NULL AND role != 'SUPER_ADMIN' AND is_placeholder = 0");
      for (const t of ['products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers', 'stock_adjustments', 'settings']) {
        db.run(`UPDATE ${t} SET tenant_id = 1 WHERE tenant_id IS NULL${['products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers'].includes(t) ? ' AND is_placeholder = 0' : ''}`);
      }
    }
    db.run("UPDATE users SET status = 'APPROVED' WHERE (status IS NULL OR status = '') AND is_placeholder = 0");

  });

  console.log("SQLite Database initialized successfully.");
}

// Query helpers (delegate to the DB adapter).
function queryAll<T = any>(sql: string, params: any[] = []): T[] {
  return db.all<T>(sql, params);
}

function queryOne<T = any>(sql: string, params: any[] = []): T | null {
  return db.get<T>(sql, params) ?? null;
}

// Audit Logging Helper
function logAudit(userId: number | undefined | null, userName: string | undefined | null, actionType: string, description: string, targetType?: string, targetId?: number, req?: express.Request, tenantId?: number) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '') : '';
    const userAgent = req ? (req.headers['user-agent'] as string || '') : '';
    let tId = tenantId || null;
    if (!tId && userId) {
      const u = queryOne<any>("SELECT tenant_id FROM users WHERE id = ?", [userId]);
      if (u) tId = u.tenant_id;
    }
    db.run(`
      INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, target_id, ip_address, user_agent, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId || null, userName || 'System', actionType, description, targetType || null, targetId || null, String(ip), String(userAgent), tId || null]);
  } catch (e) {
    console.error('Audit log creation error:', e);
  }
}

/** The pharmacy's own name (Settings > store name), used in messages instead of a hardcoded brand. */
function storeLabel(): string {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'store_name'")?.value
    || db.get<{ name: string }>("SELECT name FROM tenants WHERE id = 1")?.name
    || 'the pharmacy';
}
const NO_EMAIL = 'no-email@local.invalid';

// ---- Archiving (FK2/FK3): records with history are archived, never deleted ----
function hasHistory(checks: [string, any[]][]): boolean {
  return checks.some(([sql, params]) => !!db.get(sql, params));
}

function archiveRow(table: string, id: number, userId: number | undefined | null, reason: string) {
  db.run(`UPDATE "${table}" SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ?`, [new Date().toISOString(), userId ?? null, reason, id]);
}

/**
 * An archived row keeps its UNIQUE values (phone, username, owner email) so its history stays readable.
 * When a NEW active record needs the same value, rename the archived row's value and remember the original
 * in archived_key. Only archived rows are ever touched.
 */
function releaseArchivedUnique(table: string, column: string, value: string) {
  if (!value) return;
  const holder = db.get<{ id: number }>(`SELECT id FROM "${table}" WHERE "${column}" = ? AND archived_at IS NOT NULL`, [value]);
  if (!holder) return;
  db.run(`UPDATE "${table}" SET archived_key = COALESCE(archived_key, "${column}"), "${column}" = ? WHERE id = ?`, [`${value}~archived-${holder.id}`, holder.id]);
}

/** Hidden record that non-customer emails (supplier POs, SMTP tests, platform messages) are attached to. */
function systemCustomerId(): number {
  const row = db.get<{ id: number }>("SELECT id FROM customers WHERE phone = '__system_messages__'");
  if (row) return row.id;
  return db.run(
    "INSERT INTO customers (name, phone, opening_balance, current_balance, archived_at, archive_reason, is_placeholder) VALUES ('[System messages]', '__system_messages__', 0, 0, ?, 'System record for non-customer messages', 1)",
    [new Date().toISOString()],
  ).lastInsertRowid;
}

// Password Strength Checker
function isPasswordStrong(pwd: string): boolean {
  if (!pwd || pwd.length < 8) return false;
  const hasLetter = /[A-Za-z]/.test(pwd);
  const hasNumberOrSymbol = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd);
  return hasLetter && hasNumberOrSymbol;
}

// Input Sanitization to prevent XSS and parameter manipulation
function sanitizeInput(input: any): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// Positive Integer Validator for route IDs (prevents parameter tampering)
function parsePositiveInt(val: any): number | null {
  const num = Number(val);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

// Authentication Middleware
interface AuthRequest extends express.Request {
  user?: UserTokenPayload;
}

interface UserTokenPayload {
  id: number;
  username: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF' | 'CUSTOMER';
  fullName: string;
  customerId?: number;
  tenant_id?: number;
  allowed_services?: string;
}

function authenticateToken(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    const payload = decoded as UserTokenPayload;

    const dbUser = queryOne<any>("SELECT id, status, tenant_id, role, customer_id FROM users WHERE id = ?", [payload.id]);
    if (!dbUser || dbUser.status !== 'APPROVED') {
      return res.status(403).json({ error: 'User account is no longer active or approved.' });
    }

    if (dbUser.role !== 'SUPER_ADMIN' && dbUser.tenant_id) {
      const tenant = queryOne<any>("SELECT status FROM tenants WHERE id = ?", [dbUser.tenant_id]);
      if (tenant && (tenant.status === 'SUSPENDED' || tenant.status === 'DELETED')) {
        return res.status(403).json({ error: 'This pharmacy store account is currently SUSPENDED by Platform Super Admin. Please contact support.' });
      }
    }

    req.user = {
      ...payload,
      // the role and customer link always come from the database, never from the token (S1)
      role: dbUser.role,
      customerId: dbUser.customer_id ?? undefined,
      tenant_id: dbUser.tenant_id || payload.tenant_id || 1
    };
    next();
  });
}

function requireRoles(roles: (string)[]) {
  return (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.user) {
      return res.status(403).json({ error: 'Permission denied for this action' });
    }
    if (req.user.role === 'SUPER_ADMIN' || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Permission denied for this action' });
  };
}

/**
 * Configuration sent by the Electron main process when running as a utilityProcess
 * (TLS key never touches the environment or a plain file), or read from files for tests.
 */
let startupMessage: { tls?: { cert: string; key: string }; localToken?: string } | null = null;
async function receiveStartupMessage(): Promise<void> {
  const port = (process as any).parentPort;
  if (!port) return;
  startupMessage = await new Promise((resolve) => {
    port.once('message', (e: any) => resolve(e?.data ?? e));
  });
}

async function loadTlsMaterial(): Promise<{ cert: string; key: string } | null> {
  if (startupMessage?.tls) return startupMessage.tls;
  const c = process.env.PHARMACY_TLS_CERT_FILE, k = process.env.PHARMACY_TLS_KEY_FILE;
  if (c && k) return { cert: fs.readFileSync(c, 'utf8'), key: fs.readFileSync(k, 'utf8') };
  return null;
}

async function startServer() {
  await receiveStartupMessage();
  await initDatabase();

  JWT_SECRET = loadOrCreateJwtSecret(DATA_DIR);
  const MODE = serverMode();
  const tlsMaterial = await loadTlsMaterial();
  const LOCAL_TOKEN = process.env.PHARMACY_LOCAL_TOKEN || startupMessage?.localToken || '';
  const BIND = process.env.PHARMACY_BIND || (MODE === 'host' ? '0.0.0.0' : '127.0.0.1');
  if (!isLoopback(BIND) && !tlsMaterial) {
    throw new Error(`Refusing to listen on ${BIND} without TLS: network access requires HTTPS (set up the certificate first).`);
  }
  const pairing = new PairingManager();
  const fingerprint = tlsMaterial ? certificateFingerprint(tlsMaterial.cert) : null;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', lanGuard({ mode: () => MODE, db: () => db }));

  const fromLoopback = (req: express.Request) => isLoopback(normalizeAddress(req.socket.remoteAddress));
  const requireLocal = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!fromLoopback(req) || !LOCAL_TOKEN || !safeEqualHex(req.get('x-local-token') || '', LOCAL_TOKEN)) {
      return res.status(403).json({ error: 'Local administration only.' });
    }
    next();
  };
  const needsSetup = () => !db.get("SELECT 1 AS x FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND archived_at IS NULL AND is_placeholder = 0 LIMIT 1");

  // ---- Health (public, no secrets) ----
  app.get('/api/health', (req, res) => {
    let dbOk = true;
    try { db.get('SELECT 1 AS x'); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'db_error', appVersion: APP_VERSION, apiProtocol: API_PROTOCOL, mode: MODE, db: { ok: dbOk }, serverTime: new Date().toISOString() });
  });

  // ---- First-run setup ----
  app.get('/api/setup/status', (req, res) => {
    const store = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'store_name'")?.value || null;
    res.json({ needsSetup: needsSetup(), storeName: store, appVersion: APP_VERSION });
  });

  const InitialAdmin = z.object({
    storeName: z.string().trim().min(2).max(100),
    ownerName: z.string().trim().min(2).max(100),
    username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits and . _ @ - only'),
    password: z.string().min(8).max(200),
    email: z.string().trim().email().max(150).optional().or(z.literal('')),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
    address: z.string().trim().max(200).optional().or(z.literal('')),
    loadDemoData: z.boolean().optional(),
  });
  app.post('/api/setup/initial-admin', tx((req: express.Request, res: express.Response) => {
    if (!fromLoopback(req)) return res.status(403).json({ error: 'The first administrator can only be created on the server computer itself.' });
    if (!needsSetup()) return res.status(409).json({ error: 'An administrator already exists. Sign in instead.' });
    const parsed = InitialAdmin.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const b = parsed.data;
    if (!isPasswordStrong(b.password)) return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    if (db.get("SELECT 1 AS x FROM users WHERE username = ? AND archived_at IS NULL", [b.username])) return res.status(409).json({ error: 'That username is already taken.' });
    releaseArchivedUnique('users', 'username', b.username);

    if (!db.get("SELECT 1 AS x FROM tenants WHERE id = 1")) {
      db.run("INSERT INTO tenants (id, name, owner_name, owner_email, phone, address, status, plan) VALUES (1, ?, ?, ?, ?, ?, 'ACTIVE', 'PRO')",
        [b.storeName, b.ownerName, b.email || 'store-1-owner@local.invalid', b.phone || '', b.address || '']);
    } else {
      db.run("UPDATE tenants SET name = ?, owner_name = ? WHERE id = 1", [b.storeName, b.ownerName]);
    }
    const adminId = db.run(
      "INSERT INTO users (username, password_hash, role, full_name, email, phone, status, tenant_id) VALUES (?, ?, 'ADMIN', ?, ?, ?, 'APPROVED', 1)",
      [b.username, bcrypt.hashSync(b.password, 12), b.ownerName, b.email || null, b.phone || null],
    ).lastInsertRowid;
    for (const [k, v] of defaultSettingsForNewStore({ name: b.storeName, address: b.address, phone: b.phone })) {
      db.run("INSERT OR IGNORE INTO settings (key, value, tenant_id) VALUES (?, ?, 1)", [k, v]);
    }
    db.run("INSERT OR REPLACE INTO settings (key, value, tenant_id) VALUES ('store_name', ?, 1)", [b.storeName]);
    db.run("INSERT OR REPLACE INTO settings (key, value, tenant_id) VALUES ('owner_name', ?, 1)", [b.ownerName]);
    if (b.loadDemoData && !db.get("SELECT 1 AS x FROM products LIMIT 1")) {
      seedDemoCatalog(db, adminId);
      for (const t of ['products', 'sales_headers', 'customers', 'categories', 'suppliers']) db.run(`UPDATE ${t} SET tenant_id = 1 WHERE tenant_id IS NULL AND is_placeholder = 0`);
    }
    logAudit(adminId, b.ownerName, 'SETUP_INITIAL_ADMIN', `First-run setup: store "${b.storeName}" and administrator "${b.username}" created${b.loadDemoData ? ' (with demo catalogue)' : ''}`, 'USER', adminId, req, 1);
    res.json({ ok: true, username: b.username });
  }));

  // ---- Local administration for the Electron main process (loopback + local token) ----
  app.get('/api/local/host-status', requireLocal, (req, res) => {
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(DB_FILE).size + (fs.existsSync(`${DB_FILE}-wal`) ? fs.statSync(`${DB_FILE}-wal`).size : 0); } catch {}
    const backups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).map((f) => fs.statSync(path.join(BACKUP_DIR, f)).mtime.toISOString()).sort() : [];
    const clients = db.all<any>("SELECT id, client_id, name, created_at, last_seen_at, last_ip, revoked_at FROM paired_clients ORDER BY id DESC");
    const onlineSince = Date.now() - 60_000;
    res.json({
      mode: MODE, hostName: os.hostname(), addresses: localIPv4Addresses(), port: PORT, appVersion: APP_VERSION, apiProtocol: API_PROTOCOL,
      fingerprint, fingerprintShort: fingerprint ? shortFingerprint(fingerprint) : null,
      pairing: MODE === 'host' ? pairing.current() : null,
      clients, connectedClients: clients.filter((c) => !c.revoked_at && c.last_seen_at && Date.parse(c.last_seen_at) > onlineSince).length,
      db: { ok: true, file: DB_FILE, sizeBytes, schemaVersion: currentVersion(db), integrity: 'checked at startup' },
      lastBackup: backups.length ? backups[backups.length - 1] : null,
      needsSetup: needsSetup(),
    });
  });
  app.post('/api/local/pairing/rotate', requireLocal, (req, res) => { pairing.rotate(); res.json(pairing.current()); });
  app.post('/api/local/clients/:id/revoke', requireLocal, tx((req: express.Request, res: express.Response) => {
    const r = db.run("UPDATE paired_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date().toISOString(), Number(req.params.id)]);
    if (r.changes) logAudit(null, 'Host computer', 'LAN_CLIENT_REVOKED', `Revoked LAN client #${req.params.id}`, 'LAN_CLIENT', Number(req.params.id), req, 1);
    res.json({ revoked: r.changes === 1 });
  }));

  // ---- Pairing (host mode, private network only - enforced by lanGuard) ----
  const pairAttempts = new Map<string, { n: number; reset: number }>();
  const pairLimited = (ip: string) => {
    const now = Date.now();
    const e = pairAttempts.get(ip) && pairAttempts.get(ip)!.reset > now ? pairAttempts.get(ip)! : { n: 0, reset: now + 10 * 60_000 };
    e.n++;
    pairAttempts.set(ip, e);
    return e.n > 20;
  };
  app.post('/api/pair/start', (req, res) => {
    if (MODE !== 'host' || !fingerprint) return res.status(404).json({ error: 'This computer is not set up as a pharmacy server.' });
    if (pairLimited(normalizeAddress(req.socket.remoteAddress))) return res.status(429).json({ error: 'Too many pairing attempts. Wait 10 minutes.' });
    try {
      const r = pairing.start(String(req.body?.clientNonce || ''), fingerprint);
      res.json({ ...r, hostName: os.hostname(), appVersion: APP_VERSION, apiProtocol: API_PROTOCOL });
    } catch (e: any) {
      res.status(e instanceof PairingError ? e.status : 500).json({ error: e.message });
    }
  });
  app.post('/api/pair/complete', tx((req: express.Request, res: express.Response) => {
    if (MODE !== 'host' || !fingerprint) return res.status(404).json({ error: 'This computer is not set up as a pharmacy server.' });
    const ip = normalizeAddress(req.socket.remoteAddress);
    const name = String(req.body?.clientName || 'Unnamed computer').replace(/[^\w .@()-]/g, '').slice(0, 60) || 'Unnamed computer';
    let ok = false;
    try {
      ok = pairing.complete(String(req.body?.serverNonce || ''), String(req.body?.clientProof || ''));
    } catch (e: any) {
      return res.status(e instanceof PairingError ? e.status : 500).json({ error: e.message });
    }
    if (!ok) {
      logAudit(null, name, 'LAN_PAIR_FAILED', `Failed pairing attempt from ${ip} (wrong code)`, 'LAN_CLIENT', undefined, req, 1);
      return res.status(403).json({ error: 'Wrong pairing code.' });
    }
    const clientToken = crypto.randomBytes(32).toString('hex');
    const clientId = crypto.randomUUID();
    const id = db.run("INSERT INTO paired_clients (client_id, name, token_hash, created_at, last_ip) VALUES (?, ?, ?, ?, ?)",
      [clientId, name, hashToken(clientToken), new Date().toISOString(), ip]).lastInsertRowid;
    logAudit(null, name, 'LAN_PAIR_SUCCESS', `Paired LAN client "${name}" from ${ip}`, 'LAN_CLIENT', id, req, 1);
    res.json({ clientId, clientToken, hostName: os.hostname() });
  }));

  // API Routes

  // Rate Limiting Maps
  const otpRateMap = new Map<string, { count: number; resetAt: number }>();
  const loginAttemptsMap = new Map<string, { attempts: number; lockedUntil: number }>();

  // 1. Auth API

  // Send Email OTP for Registration (Rate limited to 3 per 10 mins per email)
  app.post('/api/auth/send-otp', tx((req, res) => {
    const rawEmail = sanitizeInput(req.body.email);
    const cleanEmail = rawEmail.toLowerCase();
    
    if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length > 100) {
      return res.status(400).json({ error: 'Valid email address is required for OTP sending' });
    }

    // Rate Limiter Check
    const now = Date.now();
    const rateInfo = otpRateMap.get(cleanEmail) || { count: 0, resetAt: now + 10 * 60 * 1000 };
    if (now > rateInfo.resetAt) {
      rateInfo.count = 0;
      rateInfo.resetAt = now + 10 * 60 * 1000;
    }

    if (rateInfo.count >= 3) {
      logAudit(null, cleanEmail, 'OTP_RATE_LIMIT', `OTP generation rate limit exceeded for ${cleanEmail}`, 'OTP', undefined, req);
      return res.status(429).json({ error: 'Too many OTP requests. Please wait 10 minutes before requesting another verification code.' });
    }

    rateInfo.count += 1;
    otpRateMap.set(cleanEmail, rateInfo);

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    db.run("INSERT INTO otp_verifications (email, otp_code, expires_at) VALUES (?, ?, ?)", [
      cleanEmail, otpCode, expiresAt
    ]);

    logAudit(null, cleanEmail, 'OTP_SENT', `Generated registration OTP code for email: ${cleanEmail}`, 'OTP', undefined, req);

    res.json({
      message: `OTP Code generated and sent to ${cleanEmail}`,
      otp_code: otpCode // Returned for easy verification in UI demo mode
    });
  }));

  // User Registration with OTP (Role Manipulation & Replay Attack Protected)
  app.post('/api/auth/register', tx((req, res) => {
    const { email, phone, fullName, password, role, otp_code } = req.body;

    const cleanEmail = sanitizeInput(email).toLowerCase();
    const cleanName = sanitizeInput(fullName);
    const cleanPhone = sanitizeInput(phone);
    const cleanOtp = sanitizeInput(otp_code);

    if (!cleanEmail || !password || !cleanName || !cleanOtp) {
      return res.status(400).json({ error: 'Email, Full Name, Password, and OTP code are required' });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    }

    // Verify OTP
    const validOtp = queryOne<any>(`
      SELECT * FROM otp_verifications 
      WHERE email = ? AND otp_code = ? AND expires_at >= CURRENT_TIMESTAMP
      ORDER BY id DESC LIMIT 1
    `, [cleanEmail, cleanOtp]);

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired OTP verification code.' });
    }

    // Check if user already exists
    const existing = queryOne<any>("SELECT id FROM users WHERE username = ? OR email = ?", [cleanEmail, cleanEmail]);
    if (existing) {
      return res.status(400).json({ error: 'An account with this email address already exists.' });
    }

    const passHash = bcrypt.hashSync(password, 10);
    // STAGE 1 SECURITY: Self-registration CANNOT request ADMIN role under any circumstances
    const userRole = role === 'STAFF' ? 'STAFF' : 'CUSTOMER';
    const status = 'PENDING'; // EVERY new user registration requires Admin approval!

    db.run(`
      INSERT INTO users (username, password_hash, role, full_name, email, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [cleanEmail, passHash, userRole, cleanName, cleanEmail, cleanPhone || '', status]);

    // STAGE 2 SECURITY: Delete verified OTP code to prevent OTP replay manipulation
    db.run("DELETE FROM otp_verifications WHERE email = ?", [cleanEmail]);


    const newUser = queryOne<any>("SELECT id FROM users WHERE username = ?", [cleanEmail]);

    logAudit(newUser ? newUser.id : null, cleanName, 'USER_REGISTER', `New user registered (${cleanEmail}, Role: ${userRole}). Awaiting Admin Approval.`, 'USER', newUser ? newUser.id : undefined, req);

    res.json({
      message: `Registration submitted successfully! Your account is currently PENDING verification by the Admin. You can log in once approved by ${storeLabel()} Admin.`
    });
  }));

  // Register New Store / Pharmacy Tenant
  app.post('/api/auth/register-store', tx((req, res) => {
    const { storeName, ownerName, ownerEmail, phone, password, address, city, otp_code } = req.body;
    if (!storeName || !ownerName || !ownerEmail || !password || !otp_code) {
      return res.status(400).json({ error: 'Store name, owner name, owner email, password, and verification code are required.' });
    }

    const cleanEmail = ownerEmail.trim().toLowerCase();
    const cleanOtp = otp_code.trim();

    // Verify OTP code
    const validOtp = queryOne<any>(`
      SELECT id FROM otp_verifications 
      WHERE email = ? AND otp_code = ? AND expires_at >= CURRENT_TIMESTAMP
      ORDER BY id DESC LIMIT 1
    `, [cleanEmail, cleanOtp]);

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired OTP verification code.' });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    }

    // 1. Create new store tenant
    db.run(`
      INSERT INTO tenants (name, owner_name, owner_email, phone, address, city, status, plan)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 'PRO')
    `, [storeName, ownerName, cleanEmail, phone || '', address || '', city || 'Lahore']);

    const tenant = queryOne<any>("SELECT id FROM tenants WHERE owner_email = ?", [cleanEmail]);
    const tenantId = tenant ? tenant.id : 1;

    // 2. Create or Update Owner User Account (ADMIN of this store)
    const passHash = bcrypt.hashSync(password, 10);
    const existing = queryOne<any>("SELECT id FROM users WHERE username = ? OR email = ?", [cleanEmail, cleanEmail]);

    if (existing) {
      db.run(`
        UPDATE users
        SET tenant_id = ?, role = 'ADMIN', password_hash = ?, full_name = ?, email = ?, status = 'APPROVED'
        WHERE id = ?
      `, [tenantId, passHash, ownerName, cleanEmail, existing.id]);
    } else {
      db.run(`
        INSERT INTO users (username, password_hash, role, full_name, email, phone, status, tenant_id)
        VALUES (?, ?, 'ADMIN', ?, ?, ?, 'APPROVED', ?)
      `, [cleanEmail, passHash, ownerName, cleanEmail, phone || '', tenantId]);
    }

    // Cleanup OTP
    db.run("DELETE FROM otp_verifications WHERE email = ?", [cleanEmail]);

    const newUser = queryOne<any>("SELECT id FROM users WHERE username = ?", [cleanEmail]);
    logAudit(newUser ? newUser.id : null, ownerName, 'TENANT_REGISTER', `New Pharmacy Store registered (${storeName}, ID: ${tenantId}, Owner: ${cleanEmail})`, 'TENANT', tenantId, req);

    res.json({
      message: `Pharmacy store "${storeName}" registered successfully! You can now log in as Store Admin.`,
      tenant_id: tenantId
    });
  }));

  // Super Admin Management APIs
  app.get('/api/superadmin/metrics', authenticateToken, requireRoles(['SUPER_ADMIN']), (req, res) => {
    const totalTenantsRes = queryOne<any>("SELECT COUNT(*) as count FROM tenants WHERE archived_at IS NULL");
    const activeTenantsRes = queryOne<any>("SELECT COUNT(*) as count FROM tenants WHERE status = 'ACTIVE'");
    const totalSalesRes = queryOne<any>("SELECT COUNT(*) as count, COALESCE(SUM(grand_total), 0) as revenue FROM sales_headers");
    const totalUsersRes = queryOne<any>("SELECT COUNT(*) as count FROM users WHERE archived_at IS NULL");

    res.json({
      totalTenants: totalTenantsRes?.count || 0,
      activeTenants: activeTenantsRes?.count || 0,
      totalSales: totalSalesRes?.count || 0,
      totalRevenue: totalSalesRes?.revenue || 0,
      totalUsers: totalUsersRes?.count || 0
    });
  });

  app.get('/api/superadmin/tenants', authenticateToken, requireRoles(['SUPER_ADMIN']), (req, res) => {
    const tenants = queryAll<any>("SELECT * FROM tenants WHERE archived_at IS NULL ORDER BY id DESC");
    const enriched = tenants.map(t => {
      const userCount = queryOne<any>("SELECT COUNT(*) as count FROM users WHERE tenant_id = ? AND archived_at IS NULL", [t.id])?.count || 0;
      const productCount = queryOne<any>("SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND archived_at IS NULL", [t.id])?.count || 0;
      const salesTotal = queryOne<any>("SELECT COALESCE(SUM(grand_total), 0) as total FROM sales_headers WHERE tenant_id = ?", [t.id])?.total || 0;

      return {
        ...t,
        user_count: userCount,
        product_count: productCount,
        sales_total: salesTotal
      };
    });
    res.json(enriched);
  });

  app.get('/api/superadmin/tenants/:id/details', authenticateToken, requireRoles(['SUPER_ADMIN']), (req, res) => {
    const tenantId = Number(req.params.id);
    const tenant = queryOne<any>("SELECT * FROM tenants WHERE id = ?", [tenantId]);
    if (!tenant) {
      return res.status(404).json({ error: 'Pharmacy store tenant not found.' });
    }

    const users = queryAll<any>("SELECT id, username, role, full_name, email, phone, status, tenant_id, created_at FROM users WHERE tenant_id = ? AND archived_at IS NULL ORDER BY id DESC", [tenantId]);
    const sales = queryAll<any>("SELECT * FROM sales_headers WHERE tenant_id = ? ORDER BY id DESC LIMIT 100", [tenantId]);
    const products = queryAll<any>("SELECT * FROM products WHERE tenant_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 100", [tenantId]);
    const customers = queryAll<any>("SELECT * FROM customers WHERE tenant_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 100", [tenantId]);
    const auditLogs = queryAll<any>(`
      SELECT a.* FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id 
      WHERE u.tenant_id = ? OR (a.target_type = 'TENANT' AND a.target_id = ?)
      ORDER BY a.id DESC LIMIT 100
    `, [tenantId, tenantId]);

    res.json({
      tenant,
      users: users.map(u => ({ ...u, fullName: u.full_name })),
      sales,
      products,
      customers,
      auditLogs
    });
  });

  app.put('/api/superadmin/tenants/:id/services', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const tenantId = Number(req.params.id);
    const { allowed_services } = req.body;

    const servicesStr = Array.isArray(allowed_services) ? allowed_services.join(',') : String(allowed_services || '');

    db.run("UPDATE tenants SET allowed_services = ? WHERE id = ?", [servicesStr, tenantId]);

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_TENANT_SERVICES', `Super Admin updated allowed services for store #${tenantId}: ${servicesStr}`, 'TENANT', tenantId, req);
    res.json({ message: 'Store allowed services updated successfully.', allowed_services: servicesStr });
  }));

  app.post('/api/superadmin/tenants', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const { name, owner_name, owner_email, phone, address, city, plan, owner_password, password } = req.body;
    if (!name || !owner_name || !owner_email) {
      return res.status(400).json({ error: 'Store name, owner name, and owner email are required.' });
    }

    const cleanEmail = owner_email.trim().toLowerCase();
    const existing = queryOne<any>("SELECT id FROM tenants WHERE owner_email = ? AND archived_at IS NULL", [cleanEmail]);
    if (!existing) releaseArchivedUnique('tenants', 'owner_email', cleanEmail);
    if (existing) {
      return res.status(400).json({ error: 'A store with this owner email address already exists.' });
    }

    const defaultServices = 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL';

    db.run(`
      INSERT INTO tenants (name, owner_name, owner_email, phone, address, city, status, plan, allowed_services)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `, [name, owner_name, cleanEmail, phone || '', address || '', city || 'Lahore', plan || 'PRO', defaultServices]);

    const createdTenant = queryOne<any>("SELECT * FROM tenants WHERE owner_email = ?", [cleanEmail]);

    const userPassword = (owner_password || password || 'admin123').trim();
    const passHash = bcrypt.hashSync(userPassword, 10);
    const existingUser = queryOne<any>("SELECT id FROM users WHERE username = ? OR email = ?", [cleanEmail, cleanEmail]);

    if (existingUser) {
      // Re-assign and approve existing user to newly created store
      db.run(`
        UPDATE users
        SET tenant_id = ?, role = 'ADMIN', password_hash = ?, full_name = ?, email = ?, status = 'APPROVED'
        WHERE id = ?
      `, [createdTenant.id, passHash, owner_name, cleanEmail, existingUser.id]);
    } else {
      db.run(`
        INSERT INTO users (username, password_hash, role, full_name, email, phone, status, tenant_id)
        VALUES (?, ?, 'ADMIN', ?, ?, ?, 'APPROVED', ?)
      `, [cleanEmail, passHash, owner_name, cleanEmail, phone || '', createdTenant.id]);
    }

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_TENANT_CREATE', `Super Admin onboarded new store "${name}" (ID: ${createdTenant.id})`, 'TENANT', createdTenant.id, req);

    res.json({ 
      message: `Pharmacy store "${name}" onboarded successfully. Owner login credentials set for ${cleanEmail}`, 
      tenant: createdTenant 
    });
  }));

  app.put('/api/superadmin/tenants/:id/status', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const tenantId = Number(req.params.id);
    const { status } = req.body;
    if (!['ACTIVE', 'SUSPENDED', 'PENDING'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    db.run("UPDATE tenants SET status = ? WHERE id = ?", [status, tenantId]);

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_TENANT_STATUS', `Super Admin updated store #${tenantId} status to ${status}`, 'TENANT', tenantId, req);
    res.json({ message: `Store #${tenantId} status updated to ${status}.` });
  }));

  app.delete('/api/superadmin/tenants/:id', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const tenantId = Number(req.params.id);
    if (tenantId === 1) {
      return res.status(400).json({ error: 'Cannot delete primary flagship store tenant #1.' });
    }

    const tenantRow = queryOne<any>("SELECT id, name FROM tenants WHERE id = ? AND archived_at IS NULL", [tenantId]);
    if (!tenantRow) return res.status(404).json({ error: 'Pharmacy store tenant not found.' });

    // FK3: the store is archived (status DELETED, sign-in blocked for its users); none of its data is deleted
    db.run("UPDATE tenants SET status = 'DELETED' WHERE id = ?", [tenantId]);
    archiveRow('tenants', tenantId, req.user?.id, 'Deleted by Super Admin; data kept');

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_TENANT_ARCHIVE', `Super Admin removed store #${tenantId} (${tenantRow.name}); store archived, sign-in disabled, all data kept`, 'TENANT', tenantId, req);
    res.json({ message: `Store #${tenantId} removed. Its data has been archived and kept; its users can no longer sign in.`, archived: true });
  }));

  // Super Admin direct login-as / jump to store account endpoint
  app.post('/api/superadmin/tenants/:id/login-as', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const tenantId = Number(req.params.id);
    const tenant = queryOne<any>("SELECT * FROM tenants WHERE id = ?", [tenantId]);
    if (!tenant) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    if (tenant.status === 'SUSPENDED' || tenant.status === 'DELETED') {
      return res.status(400).json({ error: 'Cannot access a suspended store. Please activate it first.' });
    }

    // Find admin user for this tenant
    let storeUser = queryOne<any>("SELECT * FROM users WHERE tenant_id = ? AND role = 'ADMIN' ORDER BY id ASC LIMIT 1", [tenantId]);
    if (!storeUser) {
      storeUser = queryOne<any>("SELECT * FROM users WHERE tenant_id = ? ORDER BY id ASC LIMIT 1", [tenantId]);
    }

    if (!storeUser) {
      return res.status(404).json({ error: 'No user accounts found for this store tenant.' });
    }

    const payload: UserTokenPayload = {
      id: storeUser.id,
      username: storeUser.username,
      role: storeUser.role as any,
      fullName: storeUser.full_name,
      tenant_id: tenantId,
      allowed_services: tenant.allowed_services,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_IMPERSONATE', `Super Admin logged into store #${tenantId} (${tenant.name}) as ${storeUser.username}`, 'TENANT', tenantId, req);

    res.json({
      message: `Successfully logged into ${tenant.name}`,
      token,
      user: {
        id: storeUser.id,
        username: storeUser.username,
        role: storeUser.role,
        fullName: storeUser.full_name,
        email: storeUser.email,
        phone: storeUser.phone,
        status: storeUser.status,
        allowed_services: tenant.allowed_services,
        tenant_id: tenantId,
        tenant_name: tenant.name,
      }
    });
  }));

  // Super Admin direct message / email dispatch to shopkeepers
  app.post('/api/superadmin/send-message', authenticateToken, requireRoles(['SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const { targetTenantId, recipientEmail, subject, messageBody } = req.body;
    if (!subject || !messageBody) {
      return res.status(400).json({ error: 'Subject and message body are required.' });
    }

    let recipients: { email: string; name: string; tenant_id: number }[] = [];

    if (targetTenantId) {
      const tenant = queryOne<any>("SELECT * FROM tenants WHERE id = ?", [targetTenantId]);
      if (tenant && tenant.owner_email) {
        recipients.push({ email: tenant.owner_email, name: tenant.owner_name, tenant_id: tenant.id });
      }
    } else if (recipientEmail) {
      recipients.push({ email: recipientEmail, name: 'Shopkeeper', tenant_id: targetTenantId || 1 });
    } else {
      // Broadcast to ALL active store owners
      const allTenants = queryAll<any>("SELECT id, owner_name, owner_email FROM tenants WHERE status = 'ACTIVE'");
      recipients = allTenants.map(t => ({ email: t.owner_email, name: t.owner_name, tenant_id: t.id }));
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No valid shopkeeper recipients found.' });
    }

    let queuedCount = 0;
    for (const r of recipients) {
      db.run(`
        INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
        VALUES (?, ?, ?, ?, 'WELCOME', 'PENDING', ?)
      `, [systemCustomerId(), r.email, subject, messageBody, r.tenant_id || 1]);
      queuedCount++;
    }

    logAudit(req.user?.id, req.user?.fullName, 'SUPERADMIN_MESSAGE_DISPATCH', `Super Admin queued ${queuedCount} message(s) to shopkeepers. Subject: ${subject}`, 'COMMUNICATION', undefined, req);

    res.json({ message: `Message successfully dispatched to ${queuedCount} shopkeeper recipient(s).` });
  }));

  app.post('/api/auth/login', tx((req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const cleanUsername = username.trim();
    const lockKey = cleanUsername.toLowerCase();
    const lockInfo = loginAttemptsMap.get(lockKey);

    // Check if user is temporarily locked out due to brute force attempts
    if (lockInfo && lockInfo.lockedUntil > Date.now()) {
      const remainingMinutes = Math.ceil((lockInfo.lockedUntil - Date.now()) / (1000 * 60));
      logAudit(null, cleanUsername, 'LOGIN_BLOCKED_BRUTEFORCE', `Login attempt blocked: Account locked due to 5 consecutive failed login attempts (${cleanUsername}). ${remainingMinutes}m remaining.`, 'AUTH', undefined, req);
      return res.status(429).json({
        error: `Security Alert: Account temporarily locked due to 5 consecutive failed login attempts. Please try again after ${remainingMinutes} minutes or contact the ${storeLabel()} administrator.`
      });
    }

    const user = queryOne<any>("SELECT * FROM users WHERE username = ? OR email = ?", [cleanUsername, cleanUsername]);
    if (!user) {
      const prevAttempts = (lockInfo?.attempts || 0) + 1;
      const lockedUntil = prevAttempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
      loginAttemptsMap.set(lockKey, { attempts: prevAttempts, lockedUntil });

      logAudit(null, cleanUsername, 'LOGIN_FAILED', `Failed login attempt for unknown user: ${cleanUsername} (Attempt ${prevAttempts}/5)`, 'AUTH', undefined, req);
      
      if (prevAttempts >= 5) {
        return res.status(429).json({ error: 'Security Alert: Account temporarily locked for 15 minutes due to 5 failed login attempts.' });
      }
      return res.status(401).json({ error: `Invalid username or password. Warning: ${5 - prevAttempts} attempts remaining before temporary lock.` });
    }

    const validPassword = bcrypt.compareSync(password, user.password_hash);
    if (!validPassword) {
      const prevAttempts = (lockInfo?.attempts || 0) + 1;
      const lockedUntil = prevAttempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
      loginAttemptsMap.set(lockKey, { attempts: prevAttempts, lockedUntil });

      logAudit(user.id, user.full_name, 'LOGIN_FAILED', `Failed login attempt (incorrect password) for user: ${cleanUsername} (Attempt ${prevAttempts}/5)`, 'AUTH', user.id, req);
      
      if (prevAttempts >= 5) {
        return res.status(429).json({ error: 'Security Alert: Account temporarily locked for 15 minutes due to 5 failed login attempts.' });
      }
      return res.status(401).json({ error: `Invalid username or password. Warning: ${5 - prevAttempts} attempts remaining before temporary lock.` });
    }

    // Successful Login: Reset failed attempt counter
    loginAttemptsMap.delete(lockKey);

    // Check Admin approval status
    if (user.status === 'PENDING') {
      logAudit(user.id, user.full_name, 'LOGIN_BLOCKED', `Login blocked: Account is PENDING verification by Admin (${user.username})`, 'AUTH', user.id, req);
      return res.status(403).json({ error: `Your account is pending verification by the Admin. Please contact the ${storeLabel()} administrator for approval.` });
    }

    if (user.status === 'REJECTED') {
      logAudit(user.id, user.full_name, 'LOGIN_BLOCKED', `Login blocked: Account registration REJECTED by Admin (${user.username})`, 'AUTH', user.id, req);
      return res.status(403).json({ error: 'Your account registration was rejected by the Admin.' });
    }

    if (user.status === 'ARCHIVED' || user.archived_at) {
      logAudit(user.id, user.full_name, 'LOGIN_BLOCKED', `Login blocked: Account is ARCHIVED (${user.username})`, 'AUTH', user.id, req);
      return res.status(403).json({ error: 'This account has been archived and can no longer sign in.' });
    }

    if (user.status === 'SUSPENDED') {
      logAudit(user.id, user.full_name, 'LOGIN_BLOCKED', `Login blocked: Account SUSPENDED by Admin (${user.username})`, 'AUTH', user.id, req);
      return res.status(403).json({ error: 'Your account is currently suspended. Please contact Admin.' });
    }

    let tenantName = storeLabel();
    let tenantStatus = 'ACTIVE';
    let allowedServices = 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL';

    if (user.tenant_id) {
      const tenant = queryOne<any>("SELECT name, status, allowed_services FROM tenants WHERE id = ?", [user.tenant_id]);
      if (tenant) {
        tenantName = tenant.name;
        tenantStatus = tenant.status;
        if (tenant.allowed_services) allowedServices = tenant.allowed_services;
      }
    }

    if (user.role === 'STAFF' && user.allowed_services !== null && user.allowed_services !== undefined) {
      allowedServices = user.allowed_services;
    }

    if (user.role !== 'SUPER_ADMIN' && (tenantStatus === 'SUSPENDED' || tenantStatus === 'DELETED')) {
      logAudit(user.id, user.full_name, 'LOGIN_BLOCKED_TENANT_SUSPENDED', `Login blocked: Store tenant "${tenantName}" is SUSPENDED (${user.username})`, 'AUTH', user.id, req);
      return res.status(403).json({ error: 'This pharmacy store account is currently SUSPENDED by Platform Super Admin. Please contact support.' });
    }

    const tokenPayload: UserTokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      fullName: user.full_name,
      tenant_id: user.tenant_id || 1,
      allowed_services: allowedServices,
      customerId: user.customer_id
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    logAudit(user.id, user.full_name, 'LOGIN_SUCCESS', `User successfully logged in: ${user.username} (${user.role})`, 'AUTH', user.id, req);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        status: user.status,
        tenant_id: user.tenant_id || 1,
        tenant_name: tenantName,
        tenant_status: tenantStatus,
        allowed_services: allowedServices,
        customerId: user.customer_id
      }
    });
  }));

  // Send Login OTP via Email
  app.post('/api/auth/send-login-otp', tx((req, res) => {
    const rawEmail = sanitizeInput(req.body.email);
    const cleanEmail = rawEmail.toLowerCase().trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    const user = queryOne<any>("SELECT * FROM users WHERE email = ? OR username = ?", [cleanEmail, cleanEmail]);
    if (!user) {
      return res.status(404).json({ error: 'No registered user account found for this email address.' });
    }

    if (user.status === 'SUSPENDED' || user.status === 'REJECTED' || user.status === 'ARCHIVED' || user.archived_at) {
      return res.status(403).json({ error: `Account is ${user.status.toLowerCase()}. Please contact Admin.` });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.run("INSERT INTO otp_verifications (email, otp_code, expires_at) VALUES (?, ?, ?)", [
      cleanEmail, otpCode, expiresAt
    ]);

    logAudit(user.id, user.full_name, 'LOGIN_OTP_SENT', `Generated Login OTP for email: ${cleanEmail}`, 'AUTH', user.id, req);

    res.json({
      message: `Login OTP code generated and sent to ${cleanEmail}`,
      otp_code: otpCode // Returned for demo / testing
    });
  }));

  // Verify Login OTP & Login User
  app.post('/api/auth/login-otp', tx((req, res) => {
    const { email, otp_code } = req.body;
    const cleanEmail = sanitizeInput(email).toLowerCase().trim();
    const cleanOtp = sanitizeInput(otp_code).trim();

    if (!cleanEmail || !cleanOtp) {
      return res.status(400).json({ error: 'Email and OTP code are required.' });
    }

    const validOtp = queryOne<any>(`
      SELECT * FROM otp_verifications 
      WHERE email = ? AND otp_code = ? AND expires_at >= CURRENT_TIMESTAMP
      ORDER BY id DESC LIMIT 1
    `, [cleanEmail, cleanOtp]);

    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid or expired OTP login code.' });
    }

    const user = queryOne<any>("SELECT * FROM users WHERE email = ? OR username = ?", [cleanEmail, cleanEmail]);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (user.status === 'PENDING') {
      return res.status(403).json({ error: 'Your account is pending verification by the Admin.' });
    }
    if (user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Your account access has been suspended.' });
    }
    if (user.status === 'ARCHIVED' || user.archived_at) {
      return res.status(403).json({ error: 'This account has been archived and can no longer sign in.' });
    }

    // Clear used OTP
    db.run("DELETE FROM otp_verifications WHERE email = ?", [cleanEmail]);

    let tenantName = storeLabel();
    let tenantStatus = 'ACTIVE';
    let allowedServices = 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL';

    if (user.tenant_id) {
      const tenant = queryOne<any>("SELECT name, status, allowed_services FROM tenants WHERE id = ?", [user.tenant_id]);
      if (tenant) {
        tenantName = tenant.name;
        tenantStatus = tenant.status;
        if (tenant.allowed_services) allowedServices = tenant.allowed_services;
      }
    }

    if (user.role === 'STAFF' && user.allowed_services !== null && user.allowed_services !== undefined) {
      allowedServices = user.allowed_services;
    }

    const tokenPayload: UserTokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      fullName: user.full_name,
      customerId: user.customer_id
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    logAudit(user.id, user.full_name, 'LOGIN_SUCCESS_OTP', `User logged in via Email OTP (${user.username}, Role: ${user.role})`, 'AUTH', user.id, req);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        status: user.status,
        tenant_id: user.tenant_id || 1,
        tenant_name: tenantName,
        tenant_status: tenantStatus,
        allowed_services: allowedServices,
        customerId: user.customer_id
      }
    });
  }));

  app.get('/api/auth/me', authenticateToken, (req: AuthRequest, res) => {
    const user = queryOne<any>("SELECT id, username, role, full_name, email, phone, status, allowed_services, tenant_id, customer_id FROM users WHERE id = ?", [req.user!.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let tenantName = storeLabel();
    let tenantStatus = 'ACTIVE';
    let allowedServices = 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL';

    if (user.tenant_id) {
      const tenant = queryOne<any>("SELECT name, status, allowed_services FROM tenants WHERE id = ?", [user.tenant_id]);
      if (tenant) {
        tenantName = tenant.name;
        tenantStatus = tenant.status;
        if (tenant.allowed_services) allowedServices = tenant.allowed_services;
      }
    }

    if (user.role === 'STAFF' && user.allowed_services !== null && user.allowed_services !== undefined) {
      allowedServices = user.allowed_services;
    }

    res.json({ user: {
      id: user.id,
      username: user.username,
      role: user.role,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      tenant_id: user.tenant_id || 1,
      tenant_name: tenantName,
      tenant_status: tenantStatus,
      allowed_services: allowedServices,
      customerId: user.customer_id
    }});
  });

  // 2. Inventory & Products API
  app.get('/api/inventory', authenticateToken, (req: AuthRequest, res) => {
    const { search, category_id, low_stock, expiring } = req.query;
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);

    let sql = `
      SELECT p.*, c.name as category_name, s.name as supplier_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.archived_at IS NULL
    `;
    const params: any[] = [];

    if (req.user?.role !== 'SUPER_ADMIN') {
      sql += ` AND (p.tenant_id = ? OR p.tenant_id IS NULL)`;
      params.push(userTenantId);
    }

    if (search) {
      sql += ` AND (p.name LIKE ? OR p.batch_number LIKE ? OR p.hsn_code LIKE ? OR p.barcode LIKE ? OR CAST(p.id AS TEXT) = ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term, String(search).trim());
    }

    if (category_id) {
      sql += ` AND p.category_id = ?`;
      params.push(Number(category_id));
    }

    if (low_stock === 'true') {
      sql += ` AND p.stock <= p.min_stock`;
    }

    if (expiring === 'true' || req.query.expiry_days) {
      const days = Number(req.query.expiry_days) || 90;
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + days);
      const dateStr = targetDate.toISOString().split('T')[0];
      sql += ` AND p.expiry_date <= ? AND p.expiry_date != ''`;
      params.push(dateStr);
    }

    sql += ` ORDER BY p.name ASC`;

    const products = queryAll(sql, params);
    res.json(products);
  });

  // Helper to resolve or auto-create category
  function resolveCategoryId(val: any, tenantId: number): number | null {
    if (!val || val === '' || val === 'null' || val === 'undefined') return null;
    if (!isNaN(Number(val)) && Number(val) > 0) return Number(val);
    if (typeof val === 'string') {
      const cleanName = sanitizeInput(val);
      if (!cleanName) return null;
      const existing = queryOne<any>("SELECT id FROM categories WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), tenantId]);
      if (existing) return existing.id;
      db.run("INSERT INTO categories (name, description, tenant_id) VALUES (?, 'Auto-created Category', ?)", [cleanName, tenantId]);
      const created = queryOne<any>("SELECT id FROM categories WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), tenantId]);
      return created ? created.id : null;
    }
    return null;
  }

  // Helper to resolve or auto-create supplier
  function resolveSupplierId(val: any, tenantId: number): number | null {
    if (!val || val === '' || val === 'null' || val === 'undefined') return null;
    if (!isNaN(Number(val)) && Number(val) > 0) return Number(val);
    if (typeof val === 'string') {
      const cleanName = sanitizeInput(val);
      if (!cleanName) return null;
      const existing = queryOne<any>("SELECT id FROM suppliers WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), tenantId]);
      if (existing) return existing.id;
      db.run("INSERT INTO suppliers (name, company, phone, tenant_id) VALUES (?, ?, '', ?)", [cleanName, cleanName, tenantId]);
      const created = queryOne<any>("SELECT id FROM suppliers WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), tenantId]);
      return created ? created.id : null;
    }
    return null;
  }

  app.post('/api/inventory', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    try {
      const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
      const {
        name, unit, purchase_price, sale_price, min_stock, stock,
        batch_number, expiry_date, category_id, hsn_code, gst_rate, rack_location, supplier_id, barcode
      } = req.body;

      const cleanName = sanitizeInput(name);
      const cleanUnit = sanitizeInput(unit) || 'Pack';

      if (!cleanName) {
        return res.status(400).json({ error: 'Medicine name is required.' });
      }

      const pPrice = isNaN(Number(purchase_price)) ? 0 : Math.max(0, Number(purchase_price));
      const sPrice = isNaN(Number(sale_price)) ? 0 : Math.max(0, Number(sale_price));
      const catId = resolveCategoryId(category_id, userTenantId);
      const suppId = resolveSupplierId(supplier_id, userTenantId);

      db.run(`
        INSERT INTO products 
        (name, unit, purchase_price, sale_price, min_stock, stock, batch_number, expiry_date, category_id, hsn_code, gst_rate, rack_location, supplier_id, barcode, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cleanName, cleanUnit, pPrice, sPrice,
        Number(min_stock || 10), Number(stock || 0),
        sanitizeInput(batch_number) || '', sanitizeInput(expiry_date) || '', catId,
        sanitizeInput(hsn_code) || '3004.90', Number(gst_rate || 0), sanitizeInput(rack_location) || '', suppId,
        sanitizeInput(barcode) || '', userTenantId
      ]);

      // C11: no invented manufacturer barcodes; a product without one simply has none (manual entry later)
      const newProd = queryOne<any>("SELECT id FROM products WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [userTenantId]);
      logAudit(req.user?.id, req.user?.fullName, 'PRODUCT_ADD', `Added product "${cleanName}" (Unit: ${cleanUnit}, Sale Price: Rs. ${sPrice}, Initial Stock: ${stock || 0})`, 'PRODUCT', newProd ? newProd.id : undefined, req);

      res.json({ message: 'Product added successfully', id: newProd?.id });
    } catch (err: any) {
      console.error('Error adding product:', err);
      res.status(500).json({ error: 'Failed to add medicine: ' + err.message });
    }
  }));

  app.put('/api/inventory/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid product ID' });

      const userTenantId = req.user?.tenant_id || 1;
      const existingProd = queryOne<any>("SELECT * FROM products WHERE id = ?", [id]);
      if (!existingProd) return res.status(404).json({ error: 'Product not found' });

      if (req.user?.role !== 'SUPER_ADMIN' && existingProd.tenant_id && existingProd.tenant_id !== userTenantId) {
        return res.status(403).json({ error: 'Access denied: Product belongs to another store.' });
      }

      const {
        name, unit, purchase_price, sale_price, min_stock, stock,
        batch_number, expiry_date, category_id, hsn_code, gst_rate, rack_location, supplier_id, barcode
      } = req.body;

      const cleanName = sanitizeInput(name);
      if (!cleanName) return res.status(400).json({ error: 'Medicine name is required.' });

      const pPrice = isNaN(Number(purchase_price)) ? 0 : Math.max(0, Number(purchase_price));
      const sPrice = isNaN(Number(sale_price)) ? 0 : Math.max(0, Number(sale_price));
      const catId = resolveCategoryId(category_id, userTenantId);
      const suppId = resolveSupplierId(supplier_id, userTenantId);

      db.run(`
        UPDATE products SET
        name = ?, unit = ?, purchase_price = ?, sale_price = ?, min_stock = ?, stock = ?,
        batch_number = ?, expiry_date = ?, category_id = ?, hsn_code = ?, gst_rate = ?,
        rack_location = ?, supplier_id = ?, barcode = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        cleanName, sanitizeInput(unit) || 'Pack', pPrice, sPrice,
        Number(min_stock || 10), Number(stock || 0), sanitizeInput(batch_number), sanitizeInput(expiry_date),
        catId, sanitizeInput(hsn_code), Number(gst_rate || 0),
        sanitizeInput(rack_location), suppId, sanitizeInput(barcode) || '', id
      ]);

      logAudit(req.user?.id, req.user?.fullName, 'PRODUCT_EDIT', `Updated product #${id} ("${cleanName}", Stock: ${stock}, Sale Price: Rs. ${sPrice})`, 'PRODUCT', id, req);

      res.json({ message: 'Medicine updated successfully' });
    } catch (err: any) {
      console.error('Error updating product:', err);
      res.status(500).json({ error: 'Failed to update medicine: ' + err.message });
    }
  }));

  app.delete('/api/inventory/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const prod = queryOne<any>("SELECT * FROM products WHERE id = ?", [id]);
    if (!prod) return res.status(404).json({ error: 'Product not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && prod.tenant_id && prod.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Product belongs to another store.' });
    }

    // FK2: a product with sales/purchase/adjustment history is archived (kept for invoices and reports)
    if (hasHistory([
      ["SELECT 1 x FROM sale_items WHERE product_id = ? LIMIT 1", [id]],
      ["SELECT 1 x FROM purchase_items WHERE product_id = ? LIMIT 1", [id]],
      ["SELECT 1 x FROM stock_adjustments WHERE product_id = ? LIMIT 1", [id]],
    ])) {
      archiveRow('products', id, req.user?.id, 'Deleted by user; kept because it has transaction history');
      logAudit(req.user?.id, req.user?.fullName, 'PRODUCT_ARCHIVE', `Archived product #${id} (${prod.name}); it has transaction history, which is kept`, 'PRODUCT', id, req);
      return res.json({ message: 'Product removed from the list. It has sales/purchase history, so it was archived and its history is kept.', archived: true });
    }

    db.run("DELETE FROM products WHERE id = ?", [id]);

    logAudit(req.user?.id, req.user?.fullName, 'PRODUCT_DELETE', `Deleted product #${id} (${prod.name})`, 'PRODUCT', id, req);

    res.json({ message: 'Product deleted' });
  }));

  app.post('/api/inventory/adjust', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { product_id, adjustment_type, quantity, reason } = req.body;
    if (!product_id || !quantity || !reason) {
      return res.status(400).json({ error: 'Missing adjustment parameters' });
    }

    const userTenantId = req.user?.tenant_id || 1;
    const prod = queryOne<any>("SELECT * FROM products WHERE id = ?", [product_id]);
    if (!prod) return res.status(404).json({ error: 'Product not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && prod.tenant_id && prod.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Product belongs to another store.' });
    }

    let newStock = prod.stock;
    if (adjustment_type === 'ADD') {
      newStock += Number(quantity);
    } else {
      newStock = Math.max(0, newStock - Number(quantity));
    }

    db.run("UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [newStock, product_id]);
    try {
      db.run(`
        INSERT INTO stock_adjustments (product_id, adjustment_type, quantity, reason, user_id, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [product_id, adjustment_type, Number(quantity), reason, req.user!.id, userTenantId]);
    } catch (e) {}


    logAudit(req.user?.id, req.user?.fullName, 'STOCK_ADJUSTMENT', `Adjusted stock for product #${product_id} (${prod.name}): ${adjustment_type} ${quantity} (Old: ${prod.stock}, New: ${newStock}). Reason: ${reason}`, 'PRODUCT', Number(product_id), req);

    res.json({ message: `Stock adjusted successfully. New stock: ${newStock}` });
  }));

  // 3. Categories & Suppliers
  app.get('/api/categories', authenticateToken, (req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);
    let cats: any[];
    if (req.user?.role === 'SUPER_ADMIN') {
      cats = queryAll("SELECT * FROM categories WHERE archived_at IS NULL ORDER BY name ASC");
    } else {
      cats = queryAll("SELECT * FROM categories WHERE (tenant_id = ? OR tenant_id IS NULL) AND archived_at IS NULL ORDER BY name ASC", [userTenantId]);
    }
    res.json(cats);
  });

  app.post('/api/categories', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { name, description } = req.body;
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    const cleanName = sanitizeInput(name);
    if (!cleanName) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const existing = queryOne<any>("SELECT * FROM categories WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), userTenantId]);
    if (existing) {
      return res.json({ id: existing.id, name: existing.name, message: 'Category already exists' });
    }

    db.run("INSERT INTO categories (name, description, tenant_id) VALUES (?, ?, ?)", [cleanName, sanitizeInput(description) || 'Custom Category', userTenantId]);

    const created = queryOne<any>("SELECT * FROM categories WHERE LOWER(name) = ? AND (tenant_id = ? OR tenant_id IS NULL)", [cleanName.toLowerCase(), userTenantId]);
    logAudit(req.user?.id, req.user?.fullName, 'CATEGORY_ADD', `Added new category "${cleanName}"`, 'CATEGORY', created?.id, req);

    res.json(created);
  }));

  app.get('/api/suppliers', authenticateToken, (req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);
    let supps: any[];
    if (req.user?.role === 'SUPER_ADMIN') {
      supps = queryAll("SELECT * FROM suppliers WHERE archived_at IS NULL ORDER BY name ASC");
    } else {
      supps = queryAll("SELECT * FROM suppliers WHERE (tenant_id = ? OR tenant_id IS NULL) AND archived_at IS NULL ORDER BY name ASC", [userTenantId]);
    }
    res.json(supps);
  });

  app.post('/api/suppliers', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { name, phone, company, address } = req.body;
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }

    db.run("INSERT INTO suppliers (name, phone, company, address, tenant_id) VALUES (?, ?, ?, ?, ?)", [
      name.trim(), 
      phone ? phone.trim() : '', 
      company ? company.trim() : '', 
      address ? address.trim() : '',
      userTenantId
    ]);

    const newSupplier = queryOne<any>("SELECT * FROM suppliers WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [userTenantId]);

    logAudit(req.user?.id, req.user?.fullName, 'ADD_SUPPLIER', `Added pharmaceutical supplier: ${name} (${company || 'N/A'})`, 'SUPPLIER', newSupplier ? newSupplier.id : undefined, req);

    res.json({ message: 'Pharmaceutical Supplier added successfully', supplier: newSupplier });
  }));

  app.put('/api/suppliers/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const existingSupp = queryOne<any>("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!existingSupp) return res.status(404).json({ error: 'Supplier not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && existingSupp.tenant_id && existingSupp.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Supplier belongs to another store.' });
    }

    const { name, phone, company, address } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }

    db.run("UPDATE suppliers SET name = ?, phone = ?, company = ?, address = ? WHERE id = ?", [
      name.trim(), 
      phone ? phone.trim() : '', 
      company ? company.trim() : '', 
      address ? address.trim() : '', 
      id
    ]);

    logAudit(req.user?.id, req.user?.fullName, 'UPDATE_SUPPLIER', `Updated pharmaceutical supplier #${id}: ${name}`, 'SUPPLIER', id, req);

    res.json({ message: 'Supplier updated successfully' });
  }));

  app.delete('/api/suppliers/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const supp = queryOne<any>("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!supp) return res.status(404).json({ error: 'Supplier not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && supp.tenant_id && supp.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Supplier belongs to another store.' });
    }

    if (hasHistory([
      ["SELECT 1 x FROM purchase_headers WHERE supplier_id = ? LIMIT 1", [id]],
      ["SELECT 1 x FROM products WHERE supplier_id = ? LIMIT 1", [id]],
    ])) {
      archiveRow('suppliers', id, req.user?.id, 'Deleted by user; kept because purchases or products reference it');
      logAudit(req.user?.id, req.user?.fullName, 'ARCHIVE_SUPPLIER', `Archived supplier #${id} (${supp.name}); purchase history is kept`, 'SUPPLIER', id, req);
      return res.json({ message: 'Supplier removed from the list. It has purchase history, so it was archived and its history is kept.', archived: true });
    }

    db.run("DELETE FROM suppliers WHERE id = ?", [id]);

    logAudit(req.user?.id, req.user?.fullName, 'DELETE_SUPPLIER', `Deleted pharmaceutical supplier #${id}`, 'SUPPLIER', id, req);

    res.json({ message: 'Supplier deleted successfully' });
  }));

  // 4. Customer Management & Udhar Ledger API
  app.get('/api/customers', authenticateToken, (req: AuthRequest, res) => {
    // SECURITY: If user is CUSTOMER, strictly return only their own profile
    if (req.user?.role === 'CUSTOMER') {
      const myCust = req.user.customerId ? queryOne("SELECT * FROM customers WHERE id = ?", [req.user.customerId]) : null;
      return res.json(myCust ? [myCust] : []);
    }

    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);
    const { search } = req.query;
    let sql = "SELECT * FROM customers WHERE archived_at IS NULL";
    const params: any[] = [];

    if (req.user?.role !== 'SUPER_ADMIN') {
      sql += " AND (tenant_id = ? OR tenant_id IS NULL)";
      params.push(userTenantId);
    }

    if (search) {
      sql += " AND (name LIKE ? OR phone LIKE ?)";
      const term = `%${sanitizeInput(search)}%`;
      params.push(term, term);
    }
    sql += " ORDER BY name ASC";
    const customers = queryAll(sql, params);
    res.json(customers);
  });

  app.post('/api/customers', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    const { name, phone, address, opening_balance } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Customer name and phone are required' });
    }

    const cleanPhone = phone.trim().replace(/[\s-]/g, '');
    const cleanName = name.trim();
    const openBal = Number(opening_balance || 0);

    // Check duplicate phone in customers table for this tenant
    const existingByPhone = queryOne<any>(`
      SELECT id, name FROM customers 
      WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR REPLACE(REPLACE(login_id, '-', ''), ' ', '') = ?) 
        AND (tenant_id = ? OR tenant_id IS NULL) AND archived_at IS NULL
    `, [cleanPhone, cleanPhone, userTenantId]);

    if (existingByPhone) {
      return res.status(400).json({ 
        error: `Customer '${existingByPhone.name}' is already registered with phone number '${phone}'. Duplication is not allowed.` 
      });
    }

    // An archived customer may still hold this phone / login (kept for their history): free it for the new record
    releaseArchivedUnique('customers', 'phone', phone.trim());
    releaseArchivedUnique('customers', 'login_id', cleanPhone);
    releaseArchivedUnique('users', 'username', cleanPhone);

    // Default customer portal password is 'customer123'
    const defaultPasswordHash = bcrypt.hashSync('customer123', 10);

    db.run(`
      INSERT INTO customers (name, phone, address, opening_balance, current_balance, login_id, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [cleanName, phone.trim(), address ? address.trim() : '', openBal, openBal, cleanPhone, userTenantId]);

    const newCustomer = queryOne<any>("SELECT id FROM customers WHERE (phone = ? OR login_id = ?) AND (tenant_id = ? OR tenant_id IS NULL)", [phone.trim(), cleanPhone, userTenantId]);

    // Create user login entry for customer self-service portal
    if (newCustomer) {
      db.run(`
        INSERT OR IGNORE INTO users (username, password_hash, role, full_name, phone, customer_id, tenant_id)
        VALUES (?, ?, 'CUSTOMER', ?, ?, ?, ?)
      `, [cleanPhone, defaultPasswordHash, cleanName, phone.trim(), newCustomer.id, userTenantId]);

      if (openBal > 0) {
        db.run(`
          INSERT INTO customer_ledger (customer_id, transaction_date, type, reference, debit, credit, balance_after, notes)
          VALUES (?, CURRENT_TIMESTAMP, 'ADJUSTMENT', 'Opening Balance', ?, 0, ?, 'Initial opening balance')
        `, [newCustomer.id, openBal, openBal]);
      }
    }

    res.json({ message: 'Customer created successfully' });
  }));

  app.put('/api/customers/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const customerId = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const existingCust = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!existingCust) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (req.user?.role !== 'SUPER_ADMIN' && existingCust.tenant_id && existingCust.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Customer belongs to another store.' });
    }

    const { name, phone, address } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Customer name and phone are required' });
    }

    const cleanPhone = phone.trim().replace(/[\s-]/g, '');
    const cleanName = name.trim();

    // Check if phone number is taken by another customer in the same tenant
    const phoneTaken = queryOne<any>(`
      SELECT id, name FROM customers 
      WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR REPLACE(REPLACE(login_id, '-', ''), ' ', '') = ?) 
        AND id != ? AND (tenant_id = ? OR tenant_id IS NULL)
    `, [cleanPhone, cleanPhone, customerId, userTenantId]);

    if (phoneTaken) {
      return res.status(400).json({ 
        error: `Another customer (${phoneTaken.name}) is already registered with phone number '${phone}'. Duplication is not allowed.` 
      });
    }

    // Update customer record
    db.run(`
      UPDATE customers 
      SET name = ?, phone = ?, address = ?, login_id = ?
      WHERE id = ?
    `, [cleanName, phone.trim(), address ? address.trim() : '', cleanPhone, customerId]);

    // Update linked user account if exists
    db.run(`
      UPDATE users 
      SET username = ?, full_name = ?, phone = ?
      WHERE customer_id = ?
    `, [phone, name, phone, customerId]);

    res.json({ message: 'Customer details updated successfully' });
  }));

  app.delete('/api/customers/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const customerId = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;

    const existingCust = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!existingCust) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (req.user?.role !== 'SUPER_ADMIN' && existingCust.tenant_id && existingCust.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Customer belongs to another store.' });
    }

    // Check if customer has outstanding balance
    if (existingCust.current_balance > 0) {
      return res.status(400).json({ 
        error: `Cannot delete customer with outstanding Udhar debt balance of Rs. ${existingCust.current_balance}. Clear balance or receive payment first.` 
      });
    }

    // FK2: a customer with invoices or ledger entries is archived; the ledger and invoices are kept intact
    if (hasHistory([
      ["SELECT 1 x FROM sales_headers WHERE customer_id = ? LIMIT 1", [customerId]],
      ["SELECT 1 x FROM customer_ledger WHERE customer_id = ? LIMIT 1", [customerId]],
    ])) {
      archiveRow('customers', customerId, req.user?.id, 'Deleted by user; kept because it has invoices or ledger history');
      db.run("UPDATE users SET status = 'ARCHIVED', archived_at = ?, archive_reason = 'Customer archived' WHERE customer_id = ? AND role = 'CUSTOMER'", [new Date().toISOString(), customerId]);
      logAudit(req.user?.id, req.user?.fullName, 'CUSTOMER_ARCHIVE', `Archived customer #${customerId} (${existingCust.name}); invoices and ledger history kept, portal login disabled`, 'CUSTOMER', customerId, req);
      return res.json({ message: 'Customer removed from the list. They have invoice/ledger history, so the account was archived and the history is kept.', archived: true });
    }

    // No history: delete as before (ledger is empty), and record it
    db.run("DELETE FROM customer_ledger WHERE customer_id = ?", [customerId]);
    db.run("DELETE FROM email_queue WHERE customer_id = ?", [customerId]);
    db.run("DELETE FROM sms_queue WHERE customer_id = ?", [customerId]);
    db.run("DELETE FROM users WHERE customer_id = ?", [customerId]);
    db.run("DELETE FROM customers WHERE id = ?", [customerId]);
    logAudit(req.user?.id, req.user?.fullName, 'CUSTOMER_DELETE', `Deleted customer #${customerId} (${existingCust.name}); no transaction history`, 'CUSTOMER', customerId, req);

    res.json({ message: 'Customer account deleted successfully' });
  }));

  // Helper to retrieve ledger entries with full medicine item breakdown
  function getEnrichedLedgerForCustomer(customerId: number) {
    const ledger = queryAll<any>(`
      SELECT * FROM customer_ledger 
      WHERE customer_id = ? 
      ORDER BY transaction_date DESC, id DESC
    `, [customerId]);

    return ledger.map(entry => {
      let items: any[] = [];
      let targetSaleId = entry.sale_id;

      if (!targetSaleId && entry.reference && entry.reference.startsWith('Invoice #')) {
        const invNum = entry.reference.replace('Invoice #', '').trim();
        const saleHeader = queryOne<any>("SELECT id FROM sales_headers WHERE invoice_number = ?", [invNum]);
        if (saleHeader) {
          targetSaleId = saleHeader.id;
        }
      }

      if (targetSaleId) {
        items = queryAll(`
          SELECT si.quantity, si.unit, si.sale_price, si.subtotal, p.name as product_name
          FROM sale_items si
          JOIN products p ON si.product_id = p.id
          WHERE si.sale_id = ?
        `, [targetSaleId]);
      }

      return {
        ...entry,
        sale_id: targetSaleId,
        items
      };
    });
  }

  app.get('/api/customers/:id/ledger', authenticateToken, (req: AuthRequest, res) => {
    const customerId = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;

    // If customer role, check that they only request their own ledger
    if (req.user?.role === 'CUSTOMER' && req.user.customerId !== customerId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const customer = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CUSTOMER' && customer.tenant_id && customer.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Customer belongs to another store.' });
    }

    const ledger = getEnrichedLedgerForCustomer(customerId);

    res.json({ customer, ledger });
  });

  app.post('/api/customers/:id/payment', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const customerId = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const { amount, payment_mode, notes } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Valid payment amount is required' });
    }

    const customer = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && customer.tenant_id && customer.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Customer belongs to another store.' });
    }

    const payAmt = Number(amount);
    const newBal = customer.current_balance - payAmt;

    db.run("UPDATE customers SET current_balance = ? WHERE id = ?", [newBal, customerId]);

    const refStr = `Payment Received (${payment_mode || 'Cash'})`;
    db.run(`
      INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes)
      VALUES (?, 'PAYMENT', ?, 0, ?, ?, ?)
    `, [customerId, refStr, payAmt, newBal, notes || '']);

    // Queue BOTH Email and WhatsApp/SMS notifications for payment confirmation
    const emailSubject = `Payment Confirmation - ${storeLabel()}`;
    const emailMsg = `Dear ${customer.name},\n\nWe have received your payment of Rs. ${payAmt.toFixed(2)} via ${payment_mode || 'Cash'}.\nYour updated ${storeLabel()} balance is Rs. ${newBal.toFixed(2)}.\n\nThank you for choosing ${storeLabel()}!`;
    const custEmail = (customer as any).email || customer.phone || NO_EMAIL;
    
    const tId = req.user?.tenant_id || customer.tenant_id || 1;

    // 1. Email Notification Queue
    db.run(`
      INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
      VALUES (?, ?, ?, ?, 'PAYMENT_CONFIRMATION', 'PENDING', ?)
    `, [customerId, custEmail, emailSubject, emailMsg, tId]);

    // 2. WhatsApp / SMS Notification Queue
    const smsMsg = `${storeLabel()}: Payment Received! Dear ${customer.name}, we received Rs. ${payAmt.toFixed(2)} (${payment_mode || 'Cash'}). Your current Udhar balance is Rs. ${newBal.toFixed(2)}. Thank you!`;
    db.run(`
      INSERT INTO sms_queue (customer_id, phone, message, type, status, tenant_id)
      VALUES (?, ?, ?, 'PAYMENT_CONFIRMATION', 'PENDING', ?)
    `, [customerId, customer.phone, smsMsg, tId]);

    res.json({ message: 'Payment recorded successfully', newBalance: newBal });
  }));

  app.post('/api/customers/:id/remind', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const customerId = Number(req.params.id);
    const userTenantId = req.user?.tenant_id || 1;
    const { message } = req.body;

    const customer = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && customer.tenant_id && customer.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Customer belongs to another store.' });
    }

    const custEmail = customer.email || customer.phone || NO_EMAIL;
    const remSubject = `Udhar Balance Payment Reminder - ${storeLabel()}`;
    const defaultEmailBody = message || `Dear ${customer.name},\n\nThis is a friendly reminder regarding your outstanding Udhar balance of Rs. ${customer.current_balance.toFixed(2)} at ${storeLabel()}.\n\nPlease clear your pending amount at your earliest convenience.\n\nThank you for your cooperation!`;
    const tId = req.user?.tenant_id || customer.tenant_id || 1;

    // 1. Queue Email
    db.run(`
      INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
      VALUES (?, ?, ?, ?, 'UDHAR_REMINDER', 'PENDING', ?)
    `, [customerId, custEmail, remSubject, defaultEmailBody, tId]);

    // 2. Queue WhatsApp / SMS
    const defaultSmsMsg = message || `${storeLabel()}: Dear ${customer.name}, your total outstanding Udhar debt balance is Rs. ${customer.current_balance.toFixed(2)}. Kindly settle your bill at your earliest convenience. Thank you!`;
    db.run(`
      INSERT INTO sms_queue (customer_id, phone, message, type, status, tenant_id)
      VALUES (?, ?, ?, 'UDHAR_REMINDER', 'PENDING', ?)
    `, [customerId, customer.phone, defaultSmsMsg, tId]);

    logAudit(req.user?.id, req.user?.fullName, 'UDHAR_REMINDER_SENT', `Sent Udhar reminder via Email & WhatsApp/SMS to customer ${customer.name} (Balance: Rs. ${customer.current_balance})`, 'CUSTOMER', customerId, req);

    res.json({ message: `Udhar reminder queued for ${customer.name} via Email AND WhatsApp/SMS!` });
  }));

  // 5. Billing & Sales API
  app.post('/api/sales', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    const {
      customer_id,
      items,
      total_amount,
      discount_percent,
      discount_amount,
      net_amount,
      total_gst,
      grand_total,
      payment_method, // 'CASH', 'PARTIAL', 'UDHAR'
      amount_paid
    } = req.body;

    // C3 idempotency: the POS sends one client_txn_id per checkout and re-sends the SAME id on retry.
    // A retry of a committed sale returns the original result instead of recording the sale twice.
    const clientTxnId = req.body.client_txn_id === undefined ? null : String(req.body.client_txn_id);
    if (clientTxnId !== null && !/^[A-Za-z0-9-]{8,64}$/.test(clientTxnId)) {
      return res.status(400).json({ error: 'Invalid client_txn_id' });
    }
    if (clientTxnId) {
      const prior = queryOne<{ response: string }>("SELECT response FROM idempotency_keys WHERE key = ? AND route = 'POST /api/sales'", [clientTxnId]);
      if (prior) return res.json({ ...JSON.parse(prior.response), replayed: true });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart must contain at least one item' });
    }

    if ((payment_method === 'PARTIAL' || payment_method === 'UDHAR') && !customer_id) {
      return res.status(400).json({ error: 'Customer selection is required for Udhar/Partial payment' });
    }

    const invCountRes = queryOne<any>("SELECT COUNT(*) as cnt FROM sales_headers WHERE tenant_id = ?", [userTenantId]);
    const nextInvNum = `INV-${userTenantId}-${1001 + (invCountRes ? invCountRes.cnt : 0)}`;

    const paidAmt = payment_method === 'UDHAR' ? 0 : Number(amount_paid || 0);
    const dueAmt = grand_total - paidAmt;
    let paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' = 'PAID';
    if (dueAmt > 0 && paidAmt > 0) paymentStatus = 'PARTIAL';
    else if (dueAmt > 0 && paidAmt === 0) paymentStatus = 'UNPAID';

    let prevBal = 0;
    let newBal = 0;
    let customerObj: any = null;

    try {
      // The whole route runs in one transaction (tx wrapper); a 500 below rolls everything back.
      if (customer_id) {
        customerObj = queryOne<any>("SELECT * FROM customers WHERE id = ?", [customer_id]);
        if (customerObj) {
          prevBal = customerObj.current_balance;
          newBal = prevBal + dueAmt;
          db.run("UPDATE customers SET current_balance = ? WHERE id = ?", [newBal, customer_id]);
        }
      }

      // Insert Sale Header
      const saleHeaderInsert = db.run(`
        INSERT INTO sales_headers 
        (invoice_number, customer_id, sale_date, total_amount, discount_percent, discount_amount, net_amount, total_gst, grand_total, payment_method, amount_paid, amount_due, payment_status, created_by_user_id, tenant_id)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        nextInvNum,
        customer_id ? Number(customer_id) : null,
        Number(total_amount),
        Number(discount_percent || 0),
        Number(discount_amount || 0),
        Number(net_amount),
        Number(total_gst || 0),
        Number(grand_total),
        payment_method,
        paidAmt,
        dueAmt,
        paymentStatus,
        req.user!.id,
        userTenantId
      ]);

      const saleId = saleHeaderInsert.lastInsertRowid;

      // Process each cart item & update stock
      for (const item of items) {
        db.run(`
          INSERT INTO sale_items 
          (sale_id, product_id, quantity, unit, sale_price, cost_price, discount_percent, discount_amount, gst_amount, batch_number, expiry_date, subtotal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          saleId,
          item.product.id,
          item.quantity,
          item.product.unit,
          item.unit_price,
          item.product.purchase_price,
          item.discount_percent || 0,
          item.discount_amount || 0,
          item.gst_amount || 0,
          item.product.batch_number || '',
          item.product.expiry_date || '',
          item.subtotal
        ]);

        // Deduct Stock
        db.run("UPDATE products SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
          item.quantity, item.product.id
        ]);
      }

      // Update Customer Ledger if customer is selected
      if (customer_id && customerObj) {
        const ledgerRef = `Invoice #${nextInvNum}`;
        const itemSummaryList = items.map((it: any) => `${it.product.name} (${it.quantity} ${it.product.unit || 'Pack'} x Rs.${it.unit_price} = Rs.${it.subtotal})`).join(', ');

        db.run(`
          INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes, sale_id)
          VALUES (?, 'SALE', ?, ?, ?, ?, ?, ?)
        `, [
          customer_id,
          ledgerRef,
          grand_total,
          paidAmt,
          newBal,
          `Bill Total: Rs. ${grand_total}. Paid: Rs. ${paidAmt}. Due: Rs. ${dueAmt}. Items: ${itemSummaryList}`,
          saleId
        ]);

        // Queue BOTH Email and WhatsApp/SMS if customer owes money
        if (dueAmt > 0) {
          const emailSub = `Invoice #${nextInvNum} Notice - ${storeLabel()}`;
          const emailBody = `Dear ${customerObj.name},\n\nInvoice #${nextInvNum} has been generated.\nTotal Bill: Rs. ${grand_total.toFixed(2)}\nAmount Paid: Rs. ${paidAmt.toFixed(2)}\nAmount Due: Rs. ${dueAmt.toFixed(2)}\nYour remaining total Udhar balance is: Rs. ${newBal.toFixed(2)}.\n\nThank you for choosing ${storeLabel()}!`;
          const cEmail = customerObj.email || customerObj.phone || NO_EMAIL;

          const saleTenantId = req.user?.tenant_id || customerObj.tenant_id || userTenantId;

          // 1. Email Queue
          db.run(`
            INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
            VALUES (?, ?, ?, ?, 'UDHAR_REMINDER', 'PENDING', ?)
          `, [customer_id, cEmail, emailSub, emailBody, saleTenantId]);

          // 2. WhatsApp / SMS Queue
          const smsMsg = `${storeLabel()}: Invoice #${nextInvNum} created for ${customerObj.name}. Total: Rs. ${grand_total.toFixed(2)}, Paid: Rs. ${paidAmt.toFixed(2)}, Due: Rs. ${dueAmt.toFixed(2)}. Updated Total Udhar Balance: Rs. ${newBal.toFixed(2)}. Thank you!`;
          db.run(`
            INSERT INTO sms_queue (customer_id, phone, message, type, status, tenant_id)
            VALUES (?, ?, ?, 'UDHAR_REMINDER', 'PENDING', ?)
          `, [customer_id, customerObj.phone, smsMsg, saleTenantId]);
        }
      }

      logAudit(req.user?.id, req.user?.fullName, 'CREATE_SALE', `Completed sale invoice #${nextInvNum} (Grand Total: Rs. ${grand_total})`, 'SALE', saleId, req);

      // Return created invoice details (stored with the transaction id in the same DB transaction)
      const saleResult = {
        message: 'Sale completed successfully',
        invoice_number: nextInvNum,
        sale_id: saleId,
        grand_total,
        amount_paid: paidAmt,
        amount_due: dueAmt,
        previous_balance: prevBal,
        new_balance: newBal,
        client_txn_id: clientTxnId,
      };
      if (clientTxnId) {
        db.run("INSERT INTO idempotency_keys (key, route, user_id, response, created_at) VALUES (?, 'POST /api/sales', ?, ?, ?)",
          [clientTxnId, req.user!.id, JSON.stringify(saleResult), new Date().toISOString()]);
      }
      res.json(saleResult);
    } catch (err: any) {
      console.error("Sale transaction failed:", err);
      res.status(500).json({ error: 'Failed to process sale transaction permanently: ' + err.message });
    }
  }));

  // C3: did the sale with this transaction id commit? (used after a lost connection)
  app.get('/api/sales/by-txn/:key', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const row = queryOne<{ response: string }>("SELECT response FROM idempotency_keys WHERE key = ? AND route = 'POST /api/sales'", [String(req.params.key)]);
    if (!row) return res.status(404).json({ status: 'not_found', message: 'No sale was recorded with this transaction id.' });
    res.json({ status: 'committed', ...JSON.parse(row.response) });
  });

  app.get('/api/sales/history', authenticateToken, (req: AuthRequest, res) => {
    const { start_date, end_date } = req.query;
    let targetCustomerId = req.query.customer_id ? Number(req.query.customer_id) : null;
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);

    // SECURITY: If user is CUSTOMER, strictly restrict query to their own customer ID
    if (req.user?.role === 'CUSTOMER') {
      if (!req.user.customerId) {
        return res.status(403).json({ error: 'Access denied: Customer ID missing from token' });
      }
      targetCustomerId = req.user.customerId;
    }

    let sql = `
      SELECT s.*, c.name as customer_name, c.phone as customer_phone, u.full_name as created_by_name
      FROM sales_headers s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.created_by_user_id = u.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (req.user?.role !== 'SUPER_ADMIN') {
      sql += ` AND (s.tenant_id = ? OR (s.tenant_id IS NULL AND u.tenant_id = ?))`;
      params.push(userTenantId, userTenantId);
    }

    if (targetCustomerId) {
      sql += ` AND s.customer_id = ?`;
      params.push(targetCustomerId);
    }

    if (start_date) {
      sql += ` AND date(s.sale_date) >= date(?)`;
      params.push(String(start_date));
    }

    if (end_date) {
      sql += ` AND date(s.sale_date) <= date(?)`;
      params.push(String(end_date));
    }

    sql += ` ORDER BY s.id DESC LIMIT 100`;

    const sales = queryAll<any>(sql, params);
    if (req.query.include_items === 'true') {
      for (const sale of sales) {
        sale.items = queryAll(`
          SELECT si.*, p.name as product_name 
          FROM sale_items si
          LEFT JOIN products p ON si.product_id = p.id
          WHERE si.sale_id = ?
        `, [sale.id]);
      }
    }
    res.json(sales);
  });

  app.get('/api/sales/:id', authenticateToken, tx((req: AuthRequest, res) => {
    const saleId = parsePositiveInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'Invalid invoice ID' });

    const userTenantId = req.user?.tenant_id || 1;
    const sale = queryOne<any>(`
      SELECT s.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, u.full_name as created_by_name
      FROM sales_headers s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.created_by_user_id = u.id
      WHERE s.id = ?
    `, [saleId]);

    if (!sale) return res.status(404).json({ error: 'Invoice not found' });

    // SECURITY: Check IDOR ownership for customer role & store tenant boundary
    if (req.user?.role === 'CUSTOMER' && sale.customer_id !== req.user.customerId) {
      logAudit(req.user.id, req.user.fullName, 'IDOR_BLOCKED', `Customer #${req.user.customerId} attempted unauthorized access to Invoice #${saleId}`, 'SALE', saleId, req);
      return res.status(403).json({ error: 'Access denied: You do not have permission to view this invoice.' });
    }

    if (req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CUSTOMER' && sale.tenant_id && sale.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Invoice belongs to another store.' });
    }

    const items = queryAll(`
      SELECT si.*, p.name as product_name 
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `, [saleId]);

    res.json({ ...sale, items });
  }));

  // 6. Purchase & Stock-In API (Restricted to Admin & Staff)
  app.get('/api/purchases', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);
    let sql = `
      SELECT p.*, s.name as supplier_name, s.company as supplier_company, s.phone as supplier_phone, s.address as supplier_address
      FROM purchase_headers p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      sql += ` AND (p.tenant_id = ? OR p.tenant_id IS NULL)`;
      params.push(userTenantId);
    }
    sql += ` ORDER BY p.id DESC LIMIT 100`;
    const purchases = queryAll(sql, params);
    res.json(purchases);
  });

  app.get('/api/purchases/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid purchase record ID' });

    const userTenantId = req.user?.tenant_id || 1;
    const purchase = queryOne<any>(`
      SELECT p.*, s.name as supplier_name, s.company as supplier_company, s.phone as supplier_phone, s.address as supplier_address
      FROM purchase_headers p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.id = ?
    `, [id]);

    if (!purchase) return res.status(404).json({ error: 'Purchase record not found' });

    if (req.user?.role !== 'SUPER_ADMIN' && purchase.tenant_id && purchase.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Purchase record belongs to another store.' });
    }

    const items = queryAll(`
      SELECT pi.*, pr.name as product_name, pr.hsn_code, pr.unit
      FROM purchase_items pi
      JOIN products pr ON pi.product_id = pr.id
      WHERE pi.purchase_id = ?
    `, [id]);

    res.json({ ...purchase, items });
  });

  app.post('/api/purchases', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    const { supplier_id, invoice_number, items, notes } = req.body;

    if (!supplier_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Supplier and items required' });
    }

    let totalAmount = 0;
    items.forEach((it: any) => {
      totalAmount += it.quantity * it.purchase_price;
    });

    const invNum = invoice_number || `PUR-${userTenantId}-${Date.now().toString().slice(-6)}`;

    db.run(`
      INSERT INTO purchase_headers (invoice_number, supplier_id, total_amount, notes, tenant_id)
      VALUES (?, ?, ?, ?, ?)
    `, [invNum, supplier_id, totalAmount, notes || '', userTenantId]);

    const purHeader = queryOne<any>("SELECT id FROM purchase_headers WHERE invoice_number = ?", [invNum]);
    const purId = purHeader.id;

    for (const item of items) {
      db.run(`
        INSERT INTO purchase_items (purchase_id, product_id, quantity, purchase_price, batch_number, expiry_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [purId, item.product_id, item.quantity, item.purchase_price, item.batch_number || '', item.expiry_date || '']);

      // Increase Stock and update purchase price
      db.run(`
        UPDATE products 
        SET stock = stock + ?, purchase_price = ?, batch_number = COALESCE(NULLIF(?, ''), batch_number), expiry_date = COALESCE(NULLIF(?, ''), expiry_date), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [item.quantity, item.purchase_price, item.batch_number || '', item.expiry_date || '', item.product_id]);
    }

    logAudit(req.user?.id, req.user?.fullName, 'RECORD_PURCHASE', `Recorded stock purchase #${invNum} total Rs. ${totalAmount}`, 'PURCHASE', purId, req);

    res.json({ message: 'Purchase recorded and stock updated successfully', id: purId, invoice_number: invNum });
  }));

  app.post('/api/purchases/email-po', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { supplier_id, supplier_email, po_number, subject, message, items_summary } = req.body;

    if (!supplier_id || !po_number) {
      return res.status(400).json({ error: 'Supplier ID and PO number are required' });
    }

    const emailToUse = supplier_email || 'supplier@pharmadistributor.com';
    const emailSubject = subject || `Official Purchase Order #${po_number} - ${storeLabel()}`;
    const emailBody = message || `Dear Supplier,\n\nPlease find attached Purchase Order #${po_number} from ${storeLabel()}.\n\nOrder Summary:\n${items_summary || ''}\n\nKindly dispatch the items at your earliest convenience.\n\nRegards,\n${storeLabel()}`;

    db.run(`
      INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
      VALUES (?, ?, ?, ?, 'WELCOME', 'PENDING', ?)
    `, [systemCustomerId(), emailToUse, emailSubject, emailBody, req.user?.tenant_id || 1]);


    logAudit(req.user?.id, req.user?.fullName, 'EMAIL_PO', `Queued Purchase Order #${po_number} email to supplier (${emailToUse})`, 'PURCHASE', undefined, req);

    res.json({ message: `Purchase Order #${po_number} emailed successfully to supplier (${emailToUse})!` });
  }));

  // 7. Reports & Analytics API (Restricted to Admin & Staff)
  app.get('/api/reports/dashboard', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);

    // 1. Today's Sales & Profit
    const todaySalesRes = queryOne<any>(`
      SELECT COALESCE(SUM(grand_total), 0) as total, COUNT(*) as cnt 
      FROM sales_headers 
      WHERE DATE(sale_date) = DATE('now', 'localtime') AND (tenant_id = ? OR tenant_id IS NULL)
    `, [userTenantId]);

    const todayProfitRes = queryOne<any>(`
      SELECT COALESCE(SUM((si.sale_price - si.cost_price) * si.quantity - si.discount_amount), 0) as gross_profit
      FROM sale_items si
      JOIN sales_headers sh ON si.sale_id = sh.id
      WHERE DATE(sh.sale_date) = DATE('now', 'localtime') AND (sh.tenant_id = ? OR sh.tenant_id IS NULL)
    `, [userTenantId]);

    // 2. Current Month's Sales & Profit
    const monthSalesRes = queryOne<any>(`
      SELECT COALESCE(SUM(grand_total), 0) as total, COUNT(*) as cnt 
      FROM sales_headers 
      WHERE strftime('%Y-%m', sale_date) = strftime('%Y-%m', 'now', 'localtime') AND (tenant_id = ? OR tenant_id IS NULL)
    `, [userTenantId]);

    const monthProfitRes = queryOne<any>(`
      SELECT COALESCE(SUM((si.sale_price - si.cost_price) * si.quantity - si.discount_amount), 0) as gross_profit
      FROM sale_items si
      JOIN sales_headers sh ON si.sale_id = sh.id
      WHERE strftime('%Y-%m', sh.sale_date) = strftime('%Y-%m', 'now', 'localtime') AND (sh.tenant_id = ? OR sh.tenant_id IS NULL)
    `, [userTenantId]);

    // 3. Current Year's Sales & Profit
    const yearSalesRes = queryOne<any>(`
      SELECT COALESCE(SUM(grand_total), 0) as total, COUNT(*) as cnt 
      FROM sales_headers 
      WHERE strftime('%Y', sale_date) = strftime('%Y', 'now', 'localtime') AND (tenant_id = ? OR tenant_id IS NULL)
    `, [userTenantId]);

    const yearProfitRes = queryOne<any>(`
      SELECT COALESCE(SUM((si.sale_price - si.cost_price) * si.quantity - si.discount_amount), 0) as gross_profit
      FROM sale_items si
      JOIN sales_headers sh ON si.sale_id = sh.id
      WHERE strftime('%Y', sh.sale_date) = strftime('%Y', 'now', 'localtime') AND (sh.tenant_id = ? OR sh.tenant_id IS NULL)
    `, [userTenantId]);

    const udharRes = queryOne<any>(`
      SELECT COALESCE(SUM(current_balance), 0) as total_udhar FROM customers WHERE current_balance > 0 AND (tenant_id = ? OR tenant_id IS NULL)
    `, [userTenantId]);

    const lowStockRes = queryOne<any>(`
      SELECT COUNT(*) as count FROM products WHERE stock <= min_stock AND archived_at IS NULL AND (tenant_id = ? OR tenant_id IS NULL)
    `, [userTenantId]);

    const ninetyDaysAhead = new Date();
    ninetyDaysAhead.setDate(ninetyDaysAhead.getDate() + 90);
    const expDateStr = ninetyDaysAhead.toISOString().split('T')[0];

    const expiringRes = queryOne<any>(`
      SELECT COUNT(*) as count FROM products WHERE expiry_date <= ? AND stock > 0 AND archived_at IS NULL AND (tenant_id = ? OR tenant_id IS NULL)
    `, [expDateStr, userTenantId]);

    const totalProd = queryOne<any>("SELECT COUNT(*) as count FROM products WHERE (tenant_id = ? OR tenant_id IS NULL) AND archived_at IS NULL", [userTenantId]);
    const totalCust = queryOne<any>("SELECT COUNT(*) as count FROM customers WHERE (tenant_id = ? OR tenant_id IS NULL) AND archived_at IS NULL", [userTenantId]);

    res.json({
      todaySalesTotal: todaySalesRes ? todaySalesRes.total : 0,
      todaySalesCount: todaySalesRes ? todaySalesRes.cnt : 0,
      todayGrossProfit: todayProfitRes ? todayProfitRes.gross_profit : 0,

      monthSalesTotal: monthSalesRes ? monthSalesRes.total : 0,
      monthSalesCount: monthSalesRes ? monthSalesRes.cnt : 0,
      monthGrossProfit: monthProfitRes ? monthProfitRes.gross_profit : 0,

      yearSalesTotal: yearSalesRes ? yearSalesRes.total : 0,
      yearSalesCount: yearSalesRes ? yearSalesRes.cnt : 0,
      yearGrossProfit: yearProfitRes ? yearProfitRes.gross_profit : 0,

      totalUdharBalance: udharRes ? udharRes.total_udhar : 0,
      lowStockCount: lowStockRes ? lowStockRes.count : 0,
      expiringCount: expiringRes ? expiringRes.count : 0,
      totalProductsCount: totalProd ? totalProd.count : 0,
      totalCustomersCount: totalCust ? totalCust.count : 0
    });
  });

  app.get('/api/reports/sales', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const { start_date, end_date, group_by } = req.query;
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);

    let groupCol = "DATE(sale_date)";
    if (group_by === 'monthly') {
      groupCol = "strftime('%Y-%m', sale_date)";
    } else if (group_by === 'yearly') {
      groupCol = "strftime('%Y', sale_date)";
    }

    let whereSql = "WHERE 1=1";
    const params: any[] = [];

    if (req.user?.role !== 'SUPER_ADMIN') {
      whereSql += ` AND (tenant_id = ? OR tenant_id IS NULL)`;
      params.push(userTenantId);
    }

    if (start_date) {
      whereSql += ` AND sale_date >= ?`;
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      whereSql += ` AND sale_date <= ?`;
      params.push(`${end_date} 23:59:59`);
    }

    const sql = `
      SELECT 
        sh_summary.date,
        sh_summary.total_orders,
        sh_summary.total_sales,
        sh_summary.total_discounts,
        sh_summary.grand_total,
        COALESCE(profit_summary.total_profit, 0) as profit
      FROM (
        SELECT 
          ${groupCol} as date, 
          COUNT(id) as total_orders, 
          SUM(total_amount) as total_sales, 
          SUM(discount_amount) as total_discounts,
          SUM(grand_total) as grand_total
        FROM sales_headers
        ${whereSql}
        GROUP BY ${groupCol}
      ) sh_summary
      LEFT JOIN (
        SELECT 
          ${groupCol} as date,
          SUM((si.sale_price - si.cost_price) * si.quantity - si.discount_amount) as total_profit
        FROM sales_headers sh
        JOIN sale_items si ON sh.id = si.sale_id
        ${whereSql}
        GROUP BY ${groupCol}
      ) profit_summary ON sh_summary.date = profit_summary.date
      ORDER BY sh_summary.date DESC
    `;

    const report = queryAll(sql, [...params, ...params]);
    res.json(report);
  });

  app.get('/api/reports/top-products', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.query.tenant_id ? Number(req.query.tenant_id) : (req.user?.tenant_id || 1);
    let sql = `
      SELECT p.name, p.unit, SUM(si.quantity) as total_qty_sold, SUM(si.subtotal) as total_revenue
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales_headers sh ON si.sale_id = sh.id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      sql += ` AND (sh.tenant_id = ? OR sh.tenant_id IS NULL)`;
      params.push(userTenantId);
    }
    sql += `
      GROUP BY p.id
      ORDER BY total_qty_sold DESC
      LIMIT 10
    `;
    const top = queryAll(sql, params);
    res.json(top);
  });

  // 8. Email Queue & Outbox API
  app.get('/api/email/queue', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    let sql = `
      SELECT q.*, c.name as customer_name 
      FROM email_queue q
      LEFT JOIN customers c ON q.customer_id = c.id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      sql += ` AND (q.tenant_id = ? OR c.tenant_id = ? OR (q.tenant_id IS NULL AND (c.tenant_id = ? OR c.tenant_id IS NULL)))`;
      params.push(tenantId, tenantId, tenantId);
    }
    sql += ` ORDER BY q.id DESC LIMIT 100`;
    const queue = queryAll(sql, params);
    res.json(queue);
  });

  app.post('/api/email/process', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    // Process pending messages
    let pendingSql = "SELECT * FROM email_queue WHERE status = 'PENDING'";
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      pendingSql += " AND (tenant_id = ? OR tenant_id IS NULL)";
      params.push(tenantId);
    }
    const pending = queryAll(pendingSql, params);
    let processedCount = 0;

    for (const item of pending) {
      db.run("UPDATE email_queue SET status = 'SENT', sent_at = CURRENT_TIMESTAMP WHERE id = ?", [item.id]);
      processedCount++;
    }

    res.json({ message: `Successfully dispatched ${processedCount} queued Email notifications.` });
  }));

  app.delete('/api/email/queue/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM email_queue WHERE id = ?", [id]);
    res.json({ message: 'Email queue item deleted successfully.' });
  }));

  app.delete('/api/email/queue', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      db.run("DELETE FROM email_queue WHERE tenant_id = ? OR (tenant_id IS NULL AND customer_id IN (SELECT id FROM customers WHERE tenant_id = ?))", [tenantId, tenantId]);
    } else {
      db.run("DELETE FROM email_queue");
    }
    res.json({ message: 'Email outbox queue cleared successfully.' });
  }));

  app.put('/api/email/queue/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req, res) => {
    const { id } = req.params;
    const { email, subject, message, status } = req.body;
    db.run("UPDATE email_queue SET email = ?, subject = ?, message = ?, status = ? WHERE id = ?", [email, subject, message, status || 'PENDING', id]);
    res.json({ message: 'Email queue item updated successfully.' });
  }));

  // SMS & WhatsApp Queue Endpoints
  app.get('/api/sms/queue', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    let sql = `
      SELECT q.id, q.customer_id, q.phone, q.message, q.type, q.status, q.error_message, q.created_at, q.sent_at, c.name as customer_name 
      FROM sms_queue q
      LEFT JOIN customers c ON q.customer_id = c.id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      sql += ` AND (q.tenant_id = ? OR c.tenant_id = ? OR (q.tenant_id IS NULL AND (c.tenant_id = ? OR c.tenant_id IS NULL)))`;
      params.push(tenantId, tenantId, tenantId);
    }
    sql += ` ORDER BY q.id DESC LIMIT 100`;
    const queue = queryAll(sql, params);
    res.json(queue);
  });

  app.post('/api/sms/process', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    let pendingSql = "SELECT * FROM sms_queue WHERE status = 'PENDING'";
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      pendingSql += " AND (tenant_id = ? OR tenant_id IS NULL)";
      params.push(tenantId);
    }
    const pending = queryAll(pendingSql, params);
    let processedCount = 0;
    for (const item of pending) {
      db.run("UPDATE sms_queue SET status = 'SENT', sent_at = CURRENT_TIMESTAMP WHERE id = ?", [item.id]);
      processedCount++;
    }
    res.json({ message: `Successfully processed ${processedCount} queued WhatsApp/SMS notifications.` });
  }));

  app.delete('/api/sms/queue/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM sms_queue WHERE id = ?", [id]);
    res.json({ message: 'SMS queue item deleted successfully.' });
  }));

  app.delete('/api/sms/queue', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    if (req.user?.role !== 'SUPER_ADMIN') {
      const tenantId = req.user?.tenant_id || 1;
      db.run("DELETE FROM sms_queue WHERE tenant_id = ? OR (tenant_id IS NULL AND customer_id IN (SELECT id FROM customers WHERE tenant_id = ?))", [tenantId, tenantId]);
    } else {
      db.run("DELETE FROM sms_queue");
    }
    res.json({ message: 'SMS outbox queue cleared successfully.' });
  }));

  app.put('/api/sms/queue/:id', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req, res) => {
    const { id } = req.params;
    const { phone, message, status } = req.body;
    db.run("UPDATE sms_queue SET phone = ?, message = ?, status = ? WHERE id = ?", [phone, message, status || 'PENDING', id]);
    res.json({ message: 'SMS queue item updated successfully.' });
  }));

  // 9. System Settings & Encrypted Backup API
  app.get('/api/settings', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req, res) => {
    const rows = queryAll<{ key: string; value: string }>("SELECT * FROM settings");
    const settingsObj: Record<string, string> = {};
    rows.forEach(r => { settingsObj[r.key] = r.value; });
    res.json(settingsObj);
  });

  app.post('/api/settings/test-smtp', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { testEmail } = req.body;
    
    // Fetch current settings
    const rows = queryAll<{ key: string; value: string }>("SELECT * FROM settings");
    const settingsObj: Record<string, string> = {};
    rows.forEach(r => { settingsObj[r.key] = r.value; });

    const smtpHost = settingsObj.smtp_host || 'smtp.gmail.com';
    const smtpPort = settingsObj.smtp_port || '587';
    const smtpUser = settingsObj.smtp_user || '(not set)';
    const smtpEnabled = settingsObj.smtp_enabled === 'true';
    const targetEmail = testEmail || settingsObj.smtp_from_email || '';

    if (!smtpEnabled) {
      return res.status(400).json({ error: 'SMTP Email Gateway is currently disabled in system settings.' });
    }

    // Queue a test message to email_queue
    if (!targetEmail) return res.status(400).json({ error: 'Enter an email address to send the test message to.' });
    const testSubject = `SMTP Gateway Connection Test - ${storeLabel()}`;
    const testBody = `This is a test notification sent from ${storeLabel()} (BrainTech Pharmacy AI).\n\nSMTP Configuration Verified:\nHost: ${smtpHost}:${smtpPort}\nSender/Username: ${smtpUser}\nTimestamp: ${new Date().toLocaleString()}\n\nIf you received this message, your SMTP Email Gateway configuration is working correctly!`;

    const userTenantId = req.user?.tenant_id || 1;
    db.run(`
      INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id)
      VALUES (?, ?, ?, ?, 'WELCOME', 'PENDING', ?)
    `, [systemCustomerId(), targetEmail, testSubject, testBody, userTenantId]);

    logAudit(req.user?.id, req.user?.fullName, 'TEST_SMTP_GATEWAY', `Triggered SMTP Gateway Connection Test to ${targetEmail} (Host: ${smtpHost}:${smtpPort})`, 'SETTINGS', undefined, req);

    res.json({
      message: `SMTP Gateway Test Successful! Queued test email to ${targetEmail} via ${smtpHost}:${smtpPort}. You can dispatch or review it in the Email Outbox.`
    });
  }));

  app.post('/api/settings', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const settingsObj = req.body;
    for (const key of Object.keys(settingsObj)) {
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(settingsObj[key])]);
    }
    logAudit(req.user?.id, req.user?.fullName, 'SETTINGS_UPDATE', 'Updated pharmacy system settings and receipt configurations', 'SETTINGS', undefined, req);
    res.json({ message: 'Settings saved successfully' });
  }));

  // Encrypted Backup Download
  app.post('/api/backup/export', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), tx((req: AuthRequest, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Master backup password is required' });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Backup encryption password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    }

    const dbBuffer = db.serialize(); // consistent snapshot, includes data still in the WAL

    // Encrypt with AES-256-CBC
    const key = crypto.scryptSync(password, 'khushi_pharmacy_salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    const encrypted = Buffer.concat([cipher.update(dbBuffer), cipher.final()]);
    const backupPayload = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      iv: iv.toString('hex'),
      data: encrypted.toString('base64')
    };

    logAudit(req.user?.id, req.user?.fullName, 'BACKUP_EXPORT', 'Exported AES-256 encrypted database backup file', 'BACKUP', undefined, req);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${storeLabel().replace(/[^A-Za-z0-9-]+/g, '_')}_Backup_${new Date().toISOString().split('T')[0]}.kmhbackup`);
    res.send(JSON.stringify(backupPayload, null, 2));
  }));

  // Export MySQL SQL Dump
  app.get('/api/backup/mysql-export', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req: AuthRequest, res) => {
    try {
      let sqlOutput = `-- ========================================================\n`;
      sqlOutput += `-- ${storeLabel()} - BrainTech Pharmacy AI database export\n`;
      sqlOutput += `-- MySQL / MariaDB Full Database Migration Dump\n`;
      sqlOutput += `-- Exported At: ${new Date().toISOString()}\n`;
      sqlOutput += `-- Target RDBMS: MySQL 5.7+ / MySQL 8.0+ / MariaDB 10.3+\n`;
      sqlOutput += `-- ========================================================\n\n`;
      sqlOutput += `SET FOREIGN_KEY_CHECKS = 0;\n`;
      sqlOutput += `SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";\n`;
      sqlOutput += `START TRANSACTION;\n`;
      sqlOutput += `SET time_zone = "+00:00";\n\n`;

      const sqliteTables = queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");

      for (const tObj of sqliteTables) {
        const table = tObj.name;
        sqlOutput += `-- --------------------------------------------------------\n`;
        sqlOutput += `-- Table structure for table \`${table}\`\n`;
        sqlOutput += `-- --------------------------------------------------------\n`;
        sqlOutput += `DROP TABLE IF EXISTS \`${table}\`;\n`;

        const colInfo = queryAll<any>(`PRAGMA table_info(${table})`);
        if (colInfo && colInfo.length > 0) {
          const colDefs = colInfo.map((col: any) => {
            let colName = `\`${col.name}\``;
            let colType = String(col.type || 'VARCHAR(255)').toUpperCase();
            if (colType.includes('INT')) colType = 'INT';
            else if (colType.includes('TEXT')) colType = 'TEXT';
            else if (colType.includes('REAL') || colType.includes('FLOAT') || colType.includes('DOUBLE')) colType = 'DECIMAL(12,2)';
            else if (colType.includes('TIMESTAMP') || colType.includes('DATETIME')) colType = 'DATETIME';
            else colType = 'VARCHAR(255)';

            let pk = col.pk === 1 ? ' PRIMARY KEY' : '';
            if (col.pk === 1 && colType === 'INT') pk = ' AUTO_INCREMENT PRIMARY KEY';
            let notNull = col.notnull === 1 ? ' NOT NULL' : '';
            let dflt = (col.dflt_value !== null && col.dflt_value !== undefined) ? ` DEFAULT ${col.dflt_value}` : '';

            return `  ${colName} ${colType}${notNull}${dflt}${pk}`;
          });

          sqlOutput += `CREATE TABLE \`${table}\` (\n${colDefs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n`;
        }

        const rows = queryAll(`SELECT * FROM ${table}`);
        if (rows && rows.length > 0) {
          sqlOutput += `-- Dumping data for table \`${table}\`\n`;
          const keys = Object.keys(rows[0]);
          const colsEscaped = keys.map(k => `\`${k}\``).join(', ');

          const valueTuples = rows.map((row: any) => {
            const vals = keys.map(k => {
              const val = row[k];
              if (val === null || val === undefined) return 'NULL';
              if (typeof val === 'number') return val;
              const str = String(val).replace(/\\/g, '\\\\').replace(/'/g, "''");
              return `'${str}'`;
            });
            return `(${vals.join(', ')})`;
          });

          sqlOutput += `INSERT INTO \`${table}\` (${colsEscaped}) VALUES\n` + valueTuples.join(',\n') + ';\n\n';
        }
      }

      sqlOutput += `SET FOREIGN_KEY_CHECKS = 1;\n`;
      sqlOutput += `COMMIT;\n`;

      logAudit(req.user?.id, req.user?.fullName, 'MYSQL_EXPORT', 'Exported MySQL SQL Dump file', 'BACKUP', undefined, req);

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename=${storeLabel().replace(/[^A-Za-z0-9-]+/g, '_')}_MySQL_Dump_${new Date().toISOString().split('T')[0]}.sql`);
      res.send(sqlOutput);
    } catch (err: any) {
      console.error('MySQL export error:', err);
      res.status(500).json({ error: 'Failed to generate MySQL dump: ' + err.message });
    }
  });

  // Restore Database from Encrypted Backup
  app.post('/api/backup/import', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req: AuthRequest, res) => {
    const { backupPayload, password } = req.body;
    if (!backupPayload) {
      return res.status(400).json({ error: 'Backup file payload is required' });
    }

    try {
      let payloadObj = backupPayload;
      if (typeof payloadObj === 'string') {
        try {
          const parsed = JSON.parse(payloadObj);
          if (parsed && typeof parsed === 'object') {
            payloadObj = parsed;
          }
        } catch (e) {
          // payloadObj remains string
        }
      }

      let decryptedBuffer: Buffer | null = null;

      // Check if payloadObj is object with iv and data
      if (typeof payloadObj === 'object' && payloadObj !== null && (payloadObj.iv || payloadObj.data)) {
        if (!password) {
          return res.status(400).json({ error: 'Backup password is required to decrypt this file.' });
        }
        const iv = Buffer.from(payloadObj.iv, 'hex');
        const encryptedBuffer = Buffer.from(payloadObj.data, 'base64');
        const key = crypto.scryptSync(password, 'khushi_pharmacy_salt', 32);

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
      } else if (typeof payloadObj === 'string') {
        try {
          const buf = Buffer.from(payloadObj, 'base64');
          if (buf.length > 16 && buf.slice(0, 16).toString('utf-8').includes('SQLite format 3')) {
            decryptedBuffer = buf;
          } else {
            decryptedBuffer = Buffer.from(payloadObj, 'utf-8');
          }
        } catch (e) {
          decryptedBuffer = Buffer.from(payloadObj, 'utf-8');
        }
      } else if (Buffer.isBuffer(payloadObj)) {
        decryptedBuffer = payloadObj;
      }

      if (!decryptedBuffer || decryptedBuffer.length === 0) {
        return res.status(400).json({ error: 'Unable to parse backup payload buffer.' });
      }

      // Validate header for SQLite DB ("SQLite format 3")
      const headerString = decryptedBuffer.slice(0, 16).toString('utf-8');
      if (!headerString.includes('SQLite format 3')) {
        return res.status(400).json({ error: 'Decryption failed or invalid backup file. Incorrect decryption password or non-SQLite file.' });
      }

      // Safe swap: verify the restored file first, keep the current database as a
      // pre-restore safety copy, and put it back automatically if the restored one cannot be opened.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const incoming = `${DB_FILE}.restore-${stamp}`;
      fs.writeFileSync(incoming, decryptedBuffer);
      const problems = checkExistingDatabase(incoming);
      if (!problems.length) {
        // refuse SQLite files that are not a pharmacy database (an empty file would silently wipe all data)
        const probe = DbAdapter.open(incoming, { readonly: true });
        try {
          const tables = probe.tableNames();
          if (!tables.includes('users') || !tables.includes('products')) problems.push('it does not contain pharmacy data (no users/products tables)');
        } finally {
          probe.close();
        }
      }
      // the read-only checks of a WAL-mode file create empty -wal/-shm side files; remove them
      for (const ext of ['-wal', '-shm']) fs.rmSync(`${incoming}${ext}`, { force: true });
      if (problems.length) {
        fs.rmSync(incoming, { force: true });
        return res.status(400).json({ error: `The backup file is damaged and was not restored (${problems[0]}). Your current data is unchanged.` });
      }
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const safetyCopy = path.join(BACKUP_DIR, `pre-restore-${stamp}.sqlite`);
      db.close(); // checkpoints the WAL so the main file is complete
      for (const ext of ['-wal', '-shm']) fs.rmSync(`${DB_FILE}${ext}`, { force: true });
      fs.renameSync(DB_FILE, safetyCopy);
      fs.renameSync(incoming, DB_FILE);
      try {
        db = (await openDatabase(DB_FILE, { backupDir: BACKUP_DIR })).db;
      } catch (openErr: any) {
        for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${DB_FILE}${ext}`, { force: true });
        fs.renameSync(safetyCopy, DB_FILE);
        db = (await openDatabase(DB_FILE, { backupDir: BACKUP_DIR })).db;
        return res.status(400).json({ error: `The backup could not be opened (${openErr.message}). Your previous data was put back unchanged.` });
      }

      logAudit(req.user?.id, req.user?.fullName, 'BACKUP_RESTORE', 'Restored database successfully from encrypted backup file', 'BACKUP', undefined, req);

      res.json({ message: 'Database restored successfully! All data and settings have been restored.' });
    } catch (err: any) {
      console.error('Backup restore error:', err);
      res.status(400).json({ error: err.message || 'Decryption failed. Incorrect backup password or corrupted backup file.' });
    }
  });

  // 10. User Management API (ADMIN ONLY)
  app.get('/api/users', authenticateToken, requireRoles(['ADMIN']), (req: AuthRequest, res) => {
    let sql = `
      SELECT id, username, role, full_name, full_name as fullName, email, phone, status, allowed_services, tenant_id, customer_id, customer_id as customerId, created_at 
      FROM users 
      WHERE archived_at IS NULL
    `;
    const params: any[] = [];
    if (req.user?.role !== 'SUPER_ADMIN') {
      const userTenantId = req.user?.tenant_id || 1;
      sql += ` AND (tenant_id = ? OR tenant_id IS NULL) `;
      params.push(userTenantId);
    }
    sql += ` ORDER BY id DESC `;
    const users = queryAll(sql, params);
    res.json(users);
  });

  app.post('/api/users', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const { username, password, fullName, role, email, phone, allowed_services } = req.body;

    if (!username || !password || !fullName || !role) {
      return res.status(400).json({ error: 'Username, password, full name, and role are required' });
    }

    if (!['ADMIN', 'STAFF', 'CUSTOMER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role selected' });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    }

    const cleanUsername = username.trim();
    const existingUser = queryOne("SELECT id FROM users WHERE (username = ? OR (email = ? AND email != '')) AND archived_at IS NULL", [cleanUsername, email || '']);
    if (existingUser) {
      return res.status(400).json({ error: 'A user account with this username or email already exists.' });
    }
    releaseArchivedUnique('users', 'username', cleanUsername);

    const passHash = bcrypt.hashSync(password, 10);
    const tenantId = req.user?.role === 'SUPER_ADMIN' ? (req.body.tenant_id || 1) : (req.user?.tenant_id || 1);
    const servicesStr = Array.isArray(allowed_services) ? allowed_services.join(',') : String(allowed_services || '');

    db.run(`
      INSERT INTO users (username, password_hash, role, full_name, email, phone, status, tenant_id, allowed_services)
      VALUES (?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?)
    `, [cleanUsername, passHash, role, fullName, email || cleanUsername, phone || '', tenantId, servicesStr]);

    const createdUser = queryOne<any>("SELECT id, username, role, full_name, email, phone, status, allowed_services, tenant_id FROM users WHERE username = ?", [cleanUsername]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_CREATE', `Admin manually created user account ${cleanUsername} (${fullName}, Role: ${role})`, 'USER', createdUser?.id, req);

    res.json({ message: 'User account created successfully', user: createdUser });
  }));

  app.put('/api/users/:id/permissions', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    const { allowed_services } = req.body;

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (req.user?.role !== 'SUPER_ADMIN') {
      if (targetUser.tenant_id && targetUser.tenant_id !== (req.user?.tenant_id || 1)) {
        return res.status(403).json({ error: 'Permission denied: Cannot manage users from another store profile.' });
      }
    }

    const servicesStr = Array.isArray(allowed_services) ? allowed_services.join(',') : String(allowed_services || '');

    db.run("UPDATE users SET allowed_services = ? WHERE id = ?", [servicesStr, userId]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_PERMISSIONS_UPDATE', `Shopkeeper updated staff permissions for ${targetUser.username} (${targetUser.full_name}) to [${servicesStr}]`, 'USER', userId, req);

    res.json({ message: `Permissions updated successfully for staff account @${targetUser.username}`, allowed_services: servicesStr });
  }));

  app.put('/api/users/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    const { fullName, email, phone, role } = req.body;

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (req.user?.role !== 'SUPER_ADMIN') {
      if (targetUser.tenant_id && targetUser.tenant_id !== (req.user?.tenant_id || 1)) {
        return res.status(403).json({ error: 'Permission denied: Cannot modify users from another store profile.' });
      }
    }

    if (role && !['ADMIN', 'STAFF', 'CUSTOMER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    db.run(`
      UPDATE users 
      SET full_name = COALESCE(?, full_name), 
          email = COALESCE(?, email), 
          phone = COALESCE(?, phone), 
          role = COALESCE(?, role)
      WHERE id = ?
    `, [fullName || null, email || null, phone || null, role || null, userId]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_UPDATE', `Admin updated profile for user ${targetUser.username} (${targetUser.full_name})`, 'USER', userId, req);

    res.json({ message: 'User details updated successfully' });
  }));

  app.put('/api/users/:id/status', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    const { status } = req.body;

    if (!['APPROVED', 'REJECTED', 'PENDING', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.email === 'umarumair75108@gmail.com' || targetUser.role === 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'Cannot suspend protected Super Admin user.' });
    }

    if (userId === req.user?.id) {
      return res.status(400).json({ error: 'You cannot suspend your own active admin account.' });
    }

    try {
      db.run("UPDATE users SET status = ? WHERE id = ?", [status, userId]);

      logAudit(req.user?.id, req.user?.fullName, 'USER_VERIFY', `Admin set verification status of user ${targetUser.username} (${targetUser.full_name}) to ${status}`, 'USER', userId, req);

      res.json({ message: `User status updated to ${status}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update user status' });
    }
  }));

  app.put('/api/users/:id/role', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!['ADMIN', 'STAFF', 'CUSTOMER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    db.run("UPDATE users SET role = ? WHERE id = ?", [role, userId]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_ROLE_CHANGE', `Admin changed role of user ${targetUser.username} to ${role}`, 'USER', userId, req);

    res.json({ message: `User role updated to ${role}` });
  }));

  app.put('/api/users/:id/reset-password', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    const { password } = req.body;

    if (!password || !isPasswordStrong(password)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long and contain both letters and numbers/symbols.' });
    }

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const newHash = bcrypt.hashSync(password, 10);
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, userId]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_PASSWORD_RESET', `Admin reset password for user ${targetUser.username} (${targetUser.full_name})`, 'USER', userId, req);

    res.json({ message: `Password reset successfully for user ${targetUser.username}` });
  }));

  app.delete('/api/users/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const userId = Number(req.params.id);
    if (userId === req.user?.id) {
      return res.status(400).json({ error: 'You cannot delete your own active admin account.' });
    }

    const targetUser = queryOne<any>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.email === 'umarumair75108@gmail.com' || targetUser.role === 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'Cannot delete protected Super Admin user.' });
    }

    // FK2: a user who created sales or stock adjustments is archived. The old code re-assigned their
    // history to user #1, which falsified who made each sale; history now stays attributed correctly.
    if (hasHistory([
      ["SELECT 1 x FROM sales_headers WHERE created_by_user_id = ? LIMIT 1", [userId]],
      ["SELECT 1 x FROM stock_adjustments WHERE user_id = ? LIMIT 1", [userId]],
    ])) {
      db.run("UPDATE users SET status = 'ARCHIVED' WHERE id = ?", [userId]);
      archiveRow('users', userId, req.user?.id, 'Deleted by admin; kept because sales/adjustments reference it');
      logAudit(req.user?.id, req.user?.fullName, 'USER_ARCHIVE', `Archived user account ${targetUser.username} (${targetUser.full_name}); sign-in disabled, history kept`, 'USER', userId, req);
      return res.json({ message: 'User removed. They have sales history, so the account was archived (cannot sign in) and the history is kept.', archived: true });
    }

    db.run("DELETE FROM users WHERE id = ?", [userId]);

    logAudit(req.user?.id, req.user?.fullName, 'USER_DELETE', `Admin deleted user account ${targetUser.username} (${targetUser.full_name})`, 'USER', userId, req);

    res.json({ message: 'User account deleted successfully' });
  }));

  // 11. Audit Log API (ADMIN ONLY)
  app.get('/api/audit-logs', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), (req: AuthRequest, res) => {
    const { search, action_type, tenant_id, user_id } = req.query;

    let sql = `
      SELECT a.*, u.tenant_id as user_tenant_id, COALESCE(t.name, 'Default Store') as store_name
      FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id 
      LEFT JOIN tenants t ON COALESCE(a.tenant_id, u.tenant_id, 1) = t.id
      WHERE 1=1
    `;
    const params: any[] = [];

    // Store-level scoping for standard admins
    if (req.user?.role !== 'SUPER_ADMIN') {
      const userTenant = queryOne<any>("SELECT tenant_id FROM users WHERE id = ?", [req.user?.id]);
      const tId = userTenant?.tenant_id || 1;
      sql += ` AND (u.tenant_id = ? OR a.tenant_id = ? OR (a.target_type = 'TENANT' AND a.target_id = ?))`;
      params.push(tId, tId, tId);
    } else {
      // Super admin can filter by tenant_id
      if (tenant_id && tenant_id !== 'ALL') {
        const tId = Number(tenant_id);
        sql += ` AND (u.tenant_id = ? OR a.tenant_id = ? OR (a.target_type = 'TENANT' AND a.target_id = ?))`;
        params.push(tId, tId, tId);
      }
    }

    if (user_id && user_id !== 'ALL') {
      sql += ` AND a.user_id = ?`;
      params.push(Number(user_id));
    }

    if (search) {
      sql += ` AND (a.description LIKE ? OR a.user_name LIKE ? OR a.ip_address LIKE ? OR a.user_agent LIKE ? OR t.name LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term);
    }

    if (action_type && action_type !== 'ALL') {
      sql += ` AND a.action_type LIKE ?`;
      params.push(`%${action_type}%`);
    }

    sql += ` ORDER BY a.id DESC LIMIT 300`;

    const logs = queryAll(sql, params);
    res.json(logs);
  });

  app.delete('/api/audit-logs/clear', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    db.run("DELETE FROM audit_logs");
    logAudit(req.user?.id, req.user?.fullName, 'AUDIT_LOGS_CLEARED', 'Admin cleared all historic audit log entries', 'AUDIT', undefined, req);
    res.json({ message: 'Audit logs cleared successfully' });
  }));

  // 12. Sale Void/Deletion API (ADMIN ONLY)
  app.delete('/api/sales/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const saleId = Number(req.params.id);
    const sale = queryOne<any>("SELECT * FROM sales_headers WHERE id = ?", [saleId]);
    if (!sale) return res.status(404).json({ error: 'Invoice not found' });

    // 1. Restore stock
    const items = queryAll<any>("SELECT * FROM sale_items WHERE sale_id = ?", [saleId]);
    for (const item of items) {
      db.run("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.product_id]);
    }

    // 2. Reverse customer balance
    if (sale.customer_id) {
      const dueAmt = sale.amount_due || 0;
      if (dueAmt > 0) {
        db.run("UPDATE customers SET current_balance = MAX(0, current_balance - ?) WHERE id = ?", [dueAmt, sale.customer_id]);
      }
      db.run(`
        INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes)
        VALUES (?, 'ADJUSTMENT', ?, 0, ?, (SELECT current_balance FROM customers WHERE id = ?), ?)
      `, [sale.customer_id, `Void Invoice #${sale.invoice_number}`, dueAmt, sale.customer_id, `Invoice #${sale.invoice_number} voided/deleted by admin`]);
    }

    // 3. Delete sale items and header
    db.run("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);
    db.run("DELETE FROM sales_headers WHERE id = ?", [saleId]);


    logAudit(req.user?.id, req.user?.fullName, 'SALE_DELETE', `Voided and deleted Invoice #${sale.invoice_number} (Amount: Rs. ${sale.grand_total}). Restored item stock.`, 'SALE', saleId, req);

    res.json({ message: `Invoice #${sale.invoice_number} successfully voided and stock restored.` });
  }));

  // 10. Restricted Customer Portal API
  app.get('/api/customer-portal/me', authenticateToken, requireRoles(['CUSTOMER']), (req: AuthRequest, res) => {
    const customerId = req.user!.customerId;
    const customer = queryOne("SELECT * FROM customers WHERE id = ?", [customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer account not found' });

    const recentInvoices = queryAll(`
      SELECT s.* 
      FROM sales_headers s
      WHERE s.customer_id = ?
      ORDER BY s.id DESC LIMIT 20
    `, [customerId]);

    const ledger = getEnrichedLedgerForCustomer(customerId);

    res.json({ customer, recentInvoices, ledger });
  });

  // Automated Daily Backup Cron Job
  cron.schedule('0 0 * * *', () => {
    console.log('[AUTO-BACKUP] Creating daily automatic SQLite database checkpoint...');
    // NOTE: still only a WAL checkpoint, not a backup (legacy behaviour R11; the real backup engine is Phase 9).
    try { db.checkpoint(); } catch (e) { console.error('[AUTO-BACKUP] checkpoint failed:', e); }
  });

  // Serve Vite in development or static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite'); // dev only: never loaded in the desktop app
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.PHARMACY_STATIC_DIR || path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = tlsMaterial
    ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key, minVersion: 'TLSv1.2' }, app)
    : (await import('node:http')).createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, BIND, () => resolve());
  });
  const actualPort = (httpServer.address() as any)?.port ?? PORT;
  console.log(`====================================================`);
  console.log(`BrainTech Pharmacy AI server (${MODE}) listening on ${tlsMaterial ? 'https' : 'http'}://${BIND}:${actualPort}`);
  console.log(`====================================================`);
  (process as any).parentPort?.postMessage({ type: 'listening', port: actualPort, fingerprint });

  // Graceful shutdown: stop accepting requests, then close the database (checkpoints the WAL).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received, closing server and database...`);
    httpServer.close(() => {
      try { db.close(); } catch (e) { console.error('[SHUTDOWN] database close failed:', e); }
      process.exit(0);
    });
    setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Electron main process asks the utilityProcess to stop gracefully
  (process as any).parentPort?.on('message', (e: any) => { if ((e?.data ?? e)?.type === 'shutdown') shutdown('desktop app quit'); });
}

startServer().catch(err => {
  if (err instanceof DatabaseIntegrityError || err instanceof MigrationError) {
    console.error(`\n[DATABASE] STARTUP STOPPED - ${err.message}`);
    if ((err as MigrationError).details) console.error('[DATABASE] details:', JSON.stringify((err as MigrationError).details));
  } else {
    console.error("Failed to start server:", err);
  }
  process.exit(1);
});
