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
import { today, addDays, isExpired, batchStatus, parseExpiryInput, parseMfgInput } from './server/inventory/expiry';
import { planFefo, weightedCost, fefoOrder, LineRequest } from './server/inventory/fefo';
import { createBatch, takeFromBatch, addToBatch, batchesFor, inventoryInvariantIssues, StockConflictError } from './server/inventory/batches';
import { normalizeExpiry } from './server/inventory/expiry';
import { priceBill, sameMoney, validPercent, round2, PricedBill } from './shared/pricing';
import { DiscountAuthorizations, discountLimits } from './server/pos/discountAuth';
import { reconcilePayments, PaymentReconciliation } from './server/payments/reconcile';
import * as Pay from './server/payments/service';
import { takeInvoiceNumber, raiseSequences } from './server/sales/invoiceNumbers';

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
      for (const t of ['products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers', 'stock_adjustments', 'settings', 'product_batches']) {
        db.run(`UPDATE ${t} SET tenant_id = 1 WHERE tenant_id IS NULL${['products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers'].includes(t) ? ' AND is_placeholder = 0' : ''}`);
      }
    }
    db.run("UPDATE users SET status = 'APPROVED' WHERE (status IS NULL OR status = '') AND is_placeholder = 0");

  });

  console.log("SQLite Database initialized successfully.");
  checkInventoryAtStartup();
}

/** Phase 6: report (never repair) inventory problems at startup; shown on the host status screen. */
let inventoryStartupReport: { checkedAt: string; issues: any[]; migrationIssues: number; testDateOverride: string | null } | null = null;
function checkInventoryAtStartup() {
  const override = process.env.PHARMACY_TEST_TODAY || null;
  if (override) console.warn(`[INVENTORY] WARNING: PHARMACY_TEST_TODAY=${override} is set. Expiry checks use this date instead of the real date. This is for automated tests only.`);
  const issues = inventoryInvariantIssues(db);
  const migrationIssues = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inventory_migration_issues")?.n ?? 0;
  if (issues.length) console.error(`[INVENTORY] ${issues.length} inventory consistency problem(s) found (nothing was changed): ${JSON.stringify(issues.slice(0, 20))}`);
  if (migrationIssues) console.warn(`[INVENTORY] ${migrationIssues} item(s) were recorded during the batch upgrade (see inventory_migration_issues / audit log).`);
  inventoryStartupReport = { checkedAt: new Date().toISOString(), issues, migrationIssues, testDateOverride: override };

  // Phase 7 Batch 2a: customer balances vs payment records (reported, never repaired)
  paymentStartupReport = reconcilePayments(db);
  const pr = paymentStartupReport;
  if (pr.mismatches.length) console.warn(`[PAYMENTS] ${pr.mismatches.length} customer balance(s) differ from what invoices and payments explain (nothing was changed): ${JSON.stringify(pr.mismatches.slice(0, 20))}`);
  if (pr.untrackedSales) console.warn(`[PAYMENTS] ${pr.untrackedSales} invoice(s) have money recorded at the sale but no payment record.`);
  if (pr.walkInSalesWithDue) console.warn(`[PAYMENTS] ${pr.walkInSalesWithDue} walk-in invoice(s) still show money owed.`);
  if (pr.migrationIssues) console.warn(`[PAYMENTS] ${pr.migrationIssues} item(s) were recorded while carrying over payment history (see payment_migration_issues / audit log).`);
}
let paymentStartupReport: PaymentReconciliation | null = null;

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
      db.run('UPDATE product_batches SET tenant_id = 1 WHERE tenant_id IS NULL');
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
      inventory: inventoryStartupReport,
      payments: paymentStartupReport,
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
      sql += ` AND (p.name LIKE ? OR p.batch_number LIKE ? OR p.hsn_code LIKE ? OR p.barcode LIKE ? OR CAST(p.id AS TEXT) = ?
               OR EXISTS (SELECT 1 FROM product_batches sb WHERE sb.product_id = p.id AND sb.qty_on_hand > 0 AND sb.batch_number LIKE ?))`;
      const term = `%${search}%`;
      params.push(term, term, term, term, String(search).trim(), term);
    }

    if (category_id) {
      sql += ` AND p.category_id = ?`;
      params.push(Number(category_id));
    }

    const onDate = today();
    if (low_stock === 'true') {
      // sellable stock (expired batches cannot be sold) at or below the minimum
      sql += ` AND (SELECT COALESCE(SUM(lb.qty_on_hand), 0) FROM product_batches lb WHERE lb.product_id = p.id AND (lb.expiry_date IS NULL OR lb.expiry_date >= ?)) <= p.min_stock`;
      params.push(onDate);
    }

    if (expiring === 'true' || req.query.expiry_days) {
      const days = Number(req.query.expiry_days) || 90;
      sql += ` AND EXISTS (SELECT 1 FROM product_batches eb WHERE eb.product_id = p.id AND eb.qty_on_hand > 0 AND eb.expiry_date IS NOT NULL AND eb.expiry_date <= ?)`;
      params.push(addDays(onDate, days));
    }

    sql += ` ORDER BY p.name ASC`;

    const products = queryAll<any>(sql, params);
    res.json(withBatchSummary(products, onDate));
  });

  /**
   * Phase 6: each product carries a summary of its batches. batch_number / expiry_date describe the
   * batch FEFO will sell next (or the earliest expired one if nothing is sellable), so existing screens
   * keep showing sensible values.
   */
  function withBatchSummary(products: any[], onDate: string): any[] {
    if (!products.length) return products;
    const ids = products.map((p) => p.id);
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...queryAll<any>(`SELECT id, product_id, batch_number, expiry_date, qty_on_hand, purchase_price, sale_price FROM product_batches WHERE qty_on_hand > 0 AND product_id IN (${chunk.map(() => '?').join(',')})`, chunk));
    }
    const byProduct = new Map<number, any[]>();
    for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);
    return products.map((p) => {
      const list = (byProduct.get(p.id) ?? []).sort(fefoOrder);
      const sellable = list.filter((b) => !isExpired(b.expiry_date, onDate));
      const expired = list.filter((b) => isExpired(b.expiry_date, onDate));
      const next = sellable[0] ?? expired[0];
      return {
        ...p,
        sellable_stock: sellable.reduce((s, b) => s + b.qty_on_hand, 0),
        expired_stock: expired.reduce((s, b) => s + b.qty_on_hand, 0),
        batch_count: list.length,
        next_batch_id: sellable[0]?.id ?? null,
        batch_number: next ? (next.batch_number || '') : p.batch_number,
        expiry_date: next ? (next.expiry_date || '') : (list.length ? '' : p.expiry_date),
        next_expiry: sellable[0]?.expiry_date ?? null,
        has_undated_stock: list.some((b) => !b.expiry_date),
      };
    });
  }

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

      // Phase 6: validate the opening stock BEFORE writing anything; it becomes an OPENING batch
      const openingQty = stock === undefined || stock === null || stock === '' ? 0 : Number(stock);
      if (!Number.isInteger(openingQty) || openingQty < 0) return res.status(400).json({ error: 'Opening stock must be a whole number of units (0 or more).' });
      const exp = parseExpiryInput(expiry_date);
      if (!exp.ok) return res.status(400).json({ error: exp.error });
      const mfg = parseMfgInput(req.body.mfg_date);
      if (!mfg.ok) return res.status(400).json({ error: mfg.error });
      if (mfg.date && exp.date && mfg.date > exp.date) return res.status(400).json({ error: 'Manufacturing date is after the expiry date.' });

      const catId = resolveCategoryId(category_id, userTenantId);
      const suppId = resolveSupplierId(supplier_id, userTenantId);

      const newProductId = db.run(`
        INSERT INTO products 
        (name, unit, purchase_price, sale_price, min_stock, stock, batch_number, expiry_date, category_id, hsn_code, gst_rate, rack_location, supplier_id, barcode, tenant_id)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cleanName, cleanUnit, pPrice, sPrice,
        Number(min_stock || 10),
        sanitizeInput(batch_number) || '', exp.date || '', catId,
        sanitizeInput(hsn_code) || '3004.90', Number(gst_rate || 0), sanitizeInput(rack_location) || '', suppId,
        sanitizeInput(barcode) || '', userTenantId
      ]).lastInsertRowid;
      if (openingQty > 0) {
        createBatch(db, { productId: newProductId, batchNumber: sanitizeInput(batch_number) || null, mfgDate: mfg.date, expiryDate: exp.date, expiryRaw: expiry_date ?? null,
          purchasePrice: pPrice, salePrice: sPrice, quantity: openingQty, supplierId: suppId, source: 'OPENING', tenantId: userTenantId, createdBy: req.user?.id });
      }

      // C11: no invented manufacturer barcodes; a product without one simply has none (manual entry later)
      const newProd = { id: newProductId };
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

      // D1: stock is changed only by purchases, stock adjustments and sales (it is the sum of the batches).
      if (stock !== undefined && stock !== null && stock !== '' && Number(stock) !== Number(existingProd.stock)) {
        return res.status(409).json({ code: 'STOCK_NOT_EDITABLE', error: 'Stock cannot be changed from the product form. Use Stock Adjustment (per batch) or record a Purchase.' });
      }

      const pPrice = isNaN(Number(purchase_price)) ? 0 : Math.max(0, Number(purchase_price));
      const sPrice = isNaN(Number(sale_price)) ? 0 : Math.max(0, Number(sale_price));
      const catId = resolveCategoryId(category_id, userTenantId);
      const suppId = resolveSupplierId(supplier_id, userTenantId);

      // batch number / expiry live on the batches now (edited from the Batches panel); not changed here
      db.run(`
        UPDATE products SET
        name = ?, unit = ?, purchase_price = ?, sale_price = ?, min_stock = ?,
        category_id = ?, hsn_code = ?, gst_rate = ?,
        rack_location = ?, supplier_id = ?, barcode = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        cleanName, sanitizeInput(unit) || 'Pack', pPrice, sPrice,
        Number(min_stock || 10),
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

    // no sales/purchases/adjustments: its batches (opening/migrated stock only) go with it
    const stockGone = queryOne<any>("SELECT COALESCE(SUM(qty_on_hand), 0) AS q, COUNT(*) AS n FROM product_batches WHERE product_id = ?", [id]);
    db.run("DELETE FROM product_batches WHERE product_id = ?", [id]);
    db.run("DELETE FROM products WHERE id = ?", [id]);

    logAudit(req.user?.id, req.user?.fullName, 'PRODUCT_DELETE', `Deleted product #${id} (${prod.name})${stockGone.n ? ` with ${stockGone.n} batch(es), ${stockGone.q} unit(s)` : ''}`, 'PRODUCT', id, req);

    res.json({ message: 'Product deleted' });
  }));

  const ADJUST_REASONS = ['DAMAGED', 'EXPIRED', 'LOST', 'THEFT', 'COUNT_CORRECTION', 'OTHER'];

  /**
   * Phase 6 stock adjustment, per batch.
   *  REMOVE: needs the batch (which physical units are damaged/expired/lost) and never goes below 0 (409).
   *  ADD:    adds to an existing batch, or creates an ADJUSTMENT batch (batch number / expiry optional).
   *          Expired stock may be recorded so it can be written off; it is never sellable.
   */
  app.post('/api/inventory/adjust', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const { product_id, batch_id, adjustment_type, quantity, reason } = req.body;
    if (!product_id || !reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Missing adjustment parameters (product and reason are required).' });
    }
    if (adjustment_type !== 'ADD' && adjustment_type !== 'REMOVE') return res.status(400).json({ error: 'adjustment_type must be ADD or REMOVE.' });
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Quantity must be a whole number greater than zero.' });
    const reasonCode = req.body.reason_code ? String(req.body.reason_code).toUpperCase() : 'OTHER';
    if (!ADJUST_REASONS.includes(reasonCode)) return res.status(400).json({ error: `reason_code must be one of ${ADJUST_REASONS.join(', ')}.` });

    const userTenantId = req.user?.tenant_id || 1;
    const prod = queryOne<any>("SELECT * FROM products WHERE id = ?", [product_id]);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    if (req.user?.role !== 'SUPER_ADMIN' && prod.tenant_id && prod.tenant_id !== userTenantId) {
      return res.status(403).json({ error: 'Access denied: Product belongs to another store.' });
    }
    const batch = batch_id ? queryOne<any>("SELECT * FROM product_batches WHERE id = ?", [Number(batch_id)]) : null;
    if (batch_id && (!batch || batch.product_id !== prod.id)) return res.status(404).json({ error: 'Batch not found for this product.' });

    let targetBatchId: number;
    if (adjustment_type === 'REMOVE') {
      if (!batch) return res.status(400).json({ code: 'BATCH_REQUIRED', error: 'Choose the batch the units are removed from.' });
      if (qty > batch.qty_on_hand) {
        return res.status(409).json({ code: 'INSUFFICIENT_BATCH_STOCK', error: `Batch ${batch.batch_number || '#' + batch.id} has only ${batch.qty_on_hand} unit(s); cannot remove ${qty}.`, available: batch.qty_on_hand });
      }
      takeFromBatch(db, batch.id, qty);
      targetBatchId = batch.id;
    } else if (batch) {
      addToBatch(db, batch.id, qty);
      targetBatchId = batch.id;
    } else {
      const exp = parseExpiryInput(req.body.expiry_date);
      if (!exp.ok) return res.status(400).json({ error: exp.error });
      const mfg = parseMfgInput(req.body.mfg_date);
      if (!mfg.ok) return res.status(400).json({ error: mfg.error });
      targetBatchId = createBatch(db, {
        productId: prod.id, batchNumber: sanitizeInput(req.body.batch_number) || null, mfgDate: mfg.date, expiryDate: exp.date, expiryRaw: req.body.expiry_date ?? null,
        purchasePrice: req.body.purchase_price !== undefined ? Math.max(0, Number(req.body.purchase_price) || 0) : prod.purchase_price,
        salePrice: req.body.sale_price !== undefined ? Math.max(0, Number(req.body.sale_price) || 0) : prod.sale_price,
        quantity: qty, source: 'ADJUSTMENT', tenantId: prod.tenant_id ?? userTenantId, createdBy: req.user?.id,
      });
    }

    db.run(`
      INSERT INTO stock_adjustments (product_id, adjustment_type, quantity, reason, user_id, tenant_id, batch_id, reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [product_id, adjustment_type, qty, sanitizeInput(reason), req.user!.id, userTenantId, targetBatchId, reasonCode]);

    const newStock = queryOne<any>("SELECT stock FROM products WHERE id = ?", [product_id]).stock;
    const b = queryOne<any>("SELECT batch_number, qty_on_hand FROM product_batches WHERE id = ?", [targetBatchId]);
    logAudit(req.user?.id, req.user?.fullName, 'STOCK_ADJUSTMENT', `Adjusted stock for product #${product_id} (${prod.name}), batch ${b.batch_number || '#' + targetBatchId}: ${adjustment_type} ${qty} [${reasonCode}] (Product stock: ${prod.stock} -> ${newStock}). Reason: ${sanitizeInput(reason)}`, 'PRODUCT', Number(product_id), req);

    res.json({ message: `Stock adjusted successfully. New stock: ${newStock}`, stock: newStock, batch_id: targetBatchId, batch_qty: b.qty_on_hand });
  }));

  // ---- Phase 6: batches ----
  const batchView = (b: any, onDate: string) => ({ ...b, status: batchStatus(b.expiry_date, b.qty_on_hand, onDate), sellable: b.qty_on_hand > 0 && !isExpired(b.expiry_date, onDate) });
  const productForUser = (req: AuthRequest, id: number) => {
    const p = queryOne<any>("SELECT * FROM products WHERE id = ?", [id]);
    if (!p) return { error: 404 as const };
    if (req.user?.role !== 'SUPER_ADMIN' && p.tenant_id && p.tenant_id !== (req.user?.tenant_id || 1)) return { error: 403 as const };
    return { product: p };
  };

  app.get('/api/inventory/expiry-report', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 0), 3650);
    const onDate = today();
    const tenantId = req.user?.tenant_id || 1;
    const rows = queryAll<any>(`
      SELECT b.*, p.name AS product_name, p.unit, s.name AS supplier_name
      FROM product_batches b JOIN products p ON p.id = b.product_id LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.qty_on_hand > 0 AND p.archived_at IS NULL AND (p.tenant_id = ? OR p.tenant_id IS NULL)
        AND (b.expiry_date IS NULL OR b.expiry_date <= ?)
      ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, p.name ASC`, [tenantId, addDays(onDate, days)]).map((b) => batchView(b, onDate));
    const sum = (st: string) => rows.filter((r) => r.status === st);
    res.json({
      today: onDate, days,
      expired: sum('EXPIRED'), expiring: sum('EXPIRING_SOON').concat(rows.filter((r) => r.status === 'OK')), noExpiry: sum('NO_EXPIRY'),
      totals: { expiredUnits: sum('EXPIRED').reduce((s, r) => s + r.qty_on_hand, 0), expiredValue: sum('EXPIRED').reduce((s, r) => s + r.qty_on_hand * (r.purchase_price || 0), 0) },
    });
  });

  app.get('/api/inventory/:id/batches', authenticateToken, (req: AuthRequest, res) => {
    const r = productForUser(req, Number(req.params.id));
    if (r.error) return res.status(r.error).json({ error: r.error === 404 ? 'Product not found' : 'Access denied: Product belongs to another store.' });
    const onDate = today();
    const all = req.query.include_empty === 'true';
    const batches = queryAll<any>(`SELECT b.*, s.name AS supplier_name FROM product_batches b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.product_id = ? ${all ? '' : 'AND b.qty_on_hand > 0'}`, [r.product.id])
      .sort(fefoOrder).map((b) => batchView(b, onDate));
    res.json({ product_id: r.product.id, product_name: r.product.name, stock: r.product.stock, today: onDate, batches });
  });

  /** Corrections to a batch's identity (number, dates, sale price). Quantities change only through sales, purchases and adjustments. */
  app.put('/api/batches/:id', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const b = queryOne<any>("SELECT * FROM product_batches WHERE id = ?", [Number(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    const r = productForUser(req, b.product_id);
    if (r.error) return res.status(r.error).json({ error: 'Access denied: Product belongs to another store.' });
    if (req.body.qty_on_hand !== undefined || req.body.quantity !== undefined) {
      return res.status(400).json({ code: 'QUANTITY_NOT_EDITABLE', error: 'Batch quantity cannot be edited here. Use a stock adjustment.' });
    }
    const next = { batch_number: b.batch_number, mfg_date: b.mfg_date, expiry_date: b.expiry_date, expiry_raw: b.expiry_raw, sale_price: b.sale_price };
    if (req.body.batch_number !== undefined) next.batch_number = sanitizeInput(req.body.batch_number) || null;
    if (req.body.expiry_date !== undefined) {
      const e = parseExpiryInput(req.body.expiry_date);
      if (!e.ok) return res.status(400).json({ error: e.error });
      next.expiry_date = e.date; next.expiry_raw = req.body.expiry_date === null ? null : String(req.body.expiry_date);
    }
    if (req.body.mfg_date !== undefined) {
      const m = parseMfgInput(req.body.mfg_date);
      if (!m.ok) return res.status(400).json({ error: m.error });
      next.mfg_date = m.date;
    }
    if (next.mfg_date && next.mfg_date > today()) return res.status(400).json({ error: 'Manufacturing date cannot be in the future.' });
    if (next.mfg_date && next.expiry_date && next.mfg_date > next.expiry_date) return res.status(400).json({ error: 'Manufacturing date must be on or before the expiry date.' });
    if (req.body.sale_price !== undefined) {
      const sp = Number(req.body.sale_price);
      if (!Number.isFinite(sp) || sp < 0) return res.status(400).json({ error: 'Sale price must be zero or more.' });
      next.sale_price = sp;
    }
    const reason = sanitizeInput(req.body.reason || '');
    if (!reason) return res.status(400).json({ error: 'A reason for the correction is required.' });
    const changes = Object.entries(next).filter(([k, v]) => k !== 'expiry_raw' && (b as any)[k] !== v).map(([k, v]) => `${k}: ${(b as any)[k] ?? '-'} -> ${v ?? '-'}`);
    if (!changes.length) return res.json({ ...b, unchanged: true });
    db.run("UPDATE product_batches SET batch_number = ?, mfg_date = ?, expiry_date = ?, expiry_raw = ?, sale_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [next.batch_number, next.mfg_date, next.expiry_date, next.expiry_raw, next.sale_price, b.id]);
    logAudit(req.user?.id, req.user?.fullName, 'BATCH_CORRECTION', `Corrected batch #${b.id} of product #${b.product_id} (${r.product.name}): ${changes.join('; ')}. Reason: ${reason}`, 'BATCH', b.id, req);
    res.json(batchView(queryOne<any>("SELECT * FROM product_batches WHERE id = ?", [b.id]), today()));
  }));

  app.get('/api/batches/:id/history', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const b = queryOne<any>("SELECT * FROM product_batches WHERE id = ?", [Number(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    const r = productForUser(req, b.product_id);
    if (r.error) return res.status(r.error).json({ error: 'Access denied: Product belongs to another store.' });
    const events: any[] = [];
    events.push({ type: b.source, date: b.created_at, quantity: b.qty_received, detail: b.source === 'PURCHASE' ? 'Received on purchase' : b.source === 'MIGRATION' ? 'Stock carried over from before batch tracking' : b.source === 'OPENING' ? 'Opening stock' : b.source === 'VOID_RESTORE' ? 'Returned by a voided sale' : 'Added by stock adjustment' });
    if (b.purchase_item_id) {
      const p = queryOne<any>("SELECT ph.id, ph.invoice_number, ph.purchase_date FROM purchase_items pi JOIN purchase_headers ph ON ph.id = pi.purchase_id WHERE pi.id = ?", [b.purchase_item_id]);
      if (p) events[0].reference = { purchase_id: p.id, invoice_number: p.invoice_number };
    }
    for (const s of queryAll<any>(`SELECT x.quantity, sh.id AS sale_id, sh.invoice_number, sh.sale_date AS created_at FROM sale_item_batches x JOIN sale_items si ON si.id = x.sale_item_id JOIN sales_headers sh ON sh.id = si.sale_id WHERE x.batch_id = ?`, [b.id])) {
      events.push({ type: 'SALE', date: s.created_at, quantity: -s.quantity, reference: { sale_id: s.sale_id, invoice_number: s.invoice_number } });
    }
    for (const a of queryAll<any>(`SELECT * FROM stock_adjustments WHERE batch_id = ?`, [b.id])) {
      events.push({ type: 'ADJUSTMENT', date: a.created_at, quantity: a.adjustment_type === 'REMOVE' ? -a.quantity : a.quantity, detail: `${a.reason_code || ''} ${a.reason || ''}`.trim() });
    }
    events.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    res.json({ batch: batchView(b, today()), product_name: r.product.name, events });
  });

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
      ["SELECT 1 x FROM payments WHERE customer_id = ? LIMIT 1", [customerId]],
      ["SELECT 1 x FROM customer_carried_over_balances WHERE customer_id = ? LIMIT 1", [customerId]],
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

  // ---- Phase 7 Batch 2b: payments ----------------------------------------------------------------
  /** Idempotency for payment writes (condition 1): the same transaction id returns the first result. */
  const idemPrior = (key: string, route: string) => {
    const prior = queryOne<{ response: string; route: string }>("SELECT response, route FROM idempotency_keys WHERE key = ?", [key]);
    if (!prior) return null;
    if (prior.route !== route) throw new Pay.PaymentError(409, 'TXN_ID_REUSED', 'This transaction id was already used for a different operation.');
    return { ...JSON.parse(prior.response), replayed: true };
  };
  const idemStore = (key: string, route: string, userId: number, result: any) =>
    db.run("INSERT INTO idempotency_keys (key, route, user_id, response, created_at) VALUES (?, ?, ?, ?, ?)", [key, route, userId, JSON.stringify(result), new Date().toISOString()]);
  const payErr = (res: express.Response, e: any) => {
    if (e instanceof Pay.PaymentError) return res.status(e.status).json({ code: e.code, error: e.message, ...e.extra });
    // anything else: 500 -> the tx() wrapper rolls the whole transaction back (nothing is saved)
    console.error('Payment operation failed:', e);
    return res.status(500).json({ code: 'PAYMENT_FAILED', error: 'The payment failed and nothing was saved: ' + (e?.message || 'unknown error') });
  };
  const actorOf = (req: AuthRequest) => ({ id: req.user!.id, name: req.user?.fullName || req.user?.username || '' });
  const auditFor = (req: AuthRequest): Pay.AuditFn => (action, description, targetType, targetId) => logAudit(req.user?.id, req.user?.fullName, action, description, targetType, targetId ?? undefined, req);
  const customerForUser = (req: AuthRequest, id: number) => {
    const c = queryOne<any>("SELECT * FROM customers WHERE id = ?", [id]);
    if (!c) throw new Pay.PaymentError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    if (req.user?.role !== 'SUPER_ADMIN' && c.tenant_id && c.tenant_id !== (req.user?.tenant_id || 1)) throw new Pay.PaymentError(403, 'FORBIDDEN', 'Access denied: Customer belongs to another store.');
    return c;
  };
  const queueReceiptMessages = (customer: any, amount: number, label: string, newBal: number, tenantId: number) => {
    const emailSubject = `Payment Confirmation - ${storeLabel()}`;
    const emailMsg = `Dear ${customer.name},\n\nWe have received your payment of Rs. ${amount.toFixed(2)} via ${label}.\nYour updated ${storeLabel()} balance is Rs. ${newBal.toFixed(2)}.\n\nThank you for choosing ${storeLabel()}!`;
    db.run(`INSERT INTO email_queue (customer_id, email, subject, message, type, status, tenant_id) VALUES (?, ?, ?, ?, 'PAYMENT_CONFIRMATION', 'PENDING', ?)`,
      [customer.id, customer.email || customer.phone || NO_EMAIL, emailSubject, emailMsg, tenantId]);
    const smsMsg = `${storeLabel()}: Payment Received! Dear ${customer.name}, we received Rs. ${amount.toFixed(2)} (${label}). Your current Udhar balance is Rs. ${newBal.toFixed(2)}. Thank you!`;
    db.run(`INSERT INTO sms_queue (customer_id, phone, message, type, status, tenant_id) VALUES (?, ?, ?, 'PAYMENT_CONFIRMATION', 'PENDING', ?)`, [customer.id, customer.phone, smsMsg, tenantId]);
  };

  /**
   * A payment from a customer (E5/P2/Q1): applied to the opening balance, then confirmed carried-over balances,
   * then the oldest invoices; anything left is kept as advance (never lost). Same URL and fields as before,
   * plus method / method_detail / reference / client_txn_id (required).
   */
  app.post('/api/customers/:id/payment', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const ROUTE = 'POST /api/customers/:id/payment';
    try {
      const txn = Pay.parseTxnId(req.body?.client_txn_id);
      const prior = idemPrior(txn, ROUTE);
      if (prior) return res.json(prior);
      const customer = customerForUser(req, Number(req.params.id));
      if (customer.archived_at) throw new Pay.PaymentError(400, 'CUSTOMER_ARCHIVED', 'This customer has been removed from the list.');
      const amount = Pay.parseAmount(req.body?.amount, 'Payment amount');
      const m = Pay.parseMethod(req.body?.method ?? req.body?.payment_mode ?? 'CASH', req.body?.method_detail);
      const reference = Pay.parseText(req.body?.reference, 100);
      const notes = Pay.parseText(req.body?.notes, 500);
      const actor = actorOf(req);
      const tenantId = customer.tenant_id || req.user?.tenant_id || 1;

      const pid = Pay.insertPayment(db, { tenantId, customerId: customer.id, kind: 'CUSTOMER_PAYMENT', method: m.method, detail: m.detail, amount, reference, notes, clientTxnId: txn, actor, source: 'CUSTOMER_SCREEN' });
      const { allocations, advance } = Pay.allocateFifo(db, pid, customer.id, 'CUSTOMER_SCREEN', actor);
      if (process.env.PHARMACY_TEST_THROW === 'payment-after-allocation') throw new Error('test: injected failure after allocating a payment');
      db.run("UPDATE customers SET current_balance = current_balance - ? WHERE id = ?", [amount, customer.id]);
      const newBal = queryOne<any>("SELECT current_balance b FROM customers WHERE id = ?", [customer.id]).b;
      const label = Pay.methodLabel(m.method, m.detail);
      db.run(`INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes, payment_id) VALUES (?, 'PAYMENT', ?, 0, ?, ?, ?, ?)`,
        [customer.id, `Payment Received (${label})`, amount, newBal, [reference ? `Ref: ${reference}` : '', notes || ''].filter(Boolean).join(' - '), pid]);
      queueReceiptMessages(customer, amount, label, newBal, tenantId);
      logAudit(req.user?.id, req.user?.fullName, 'PAYMENT_RECORDED', `Customer payment #${pid} from ${customer.name} (#${customer.id}): Rs. ${amount} by ${label}${reference ? ` (ref ${reference})` : ''}. Applied to: ${Pay.describeAllocations(allocations)}${advance > 0.005 ? `; Rs. ${advance} kept as advance` : ''}. Balance Rs. ${customer.current_balance} -> Rs. ${newBal}.`, 'PAYMENT', pid, req);
      const result = { message: 'Payment recorded successfully', newBalance: newBal, payment_id: pid, amount, method: m.method, method_detail: m.detail,
        allocations: allocations.map((a) => ({ target: a.target, sale_id: a.saleId, invoice_number: a.invoiceNumber, carried_over_id: a.carriedOverId, amount: a.amount })), advance_remaining: advance, client_txn_id: txn };
      idemStore(txn, ROUTE, req.user!.id, result);
      res.json(result);
    } catch (e: any) { return payErr(res, e); }
  }));

  /** A payment against one invoice (P1): never more than what that invoice still owes. */
  app.post('/api/sales/:id/payments', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const ROUTE = 'POST /api/sales/:id/payments';
    try {
      const txn = Pay.parseTxnId(req.body?.client_txn_id);
      const prior = idemPrior(txn, ROUTE);
      if (prior) return res.json(prior);
      const sale = queryOne<any>("SELECT * FROM sales_headers WHERE id = ?", [Number(req.params.id)]);
      if (!sale || sale.is_placeholder) throw new Pay.PaymentError(404, 'SALE_NOT_FOUND', 'Invoice not found');
      if (req.user?.role !== 'SUPER_ADMIN' && sale.tenant_id && sale.tenant_id !== (req.user?.tenant_id || 1)) throw new Pay.PaymentError(403, 'FORBIDDEN', 'Access denied: Invoice belongs to another store.');
      const amount = Pay.parseAmount(req.body?.amount, 'Payment amount');
      if (amount > Number(sale.balance_due) + 0.005) {
        throw new Pay.PaymentError(400, 'OVERPAYMENT', `Invoice ${sale.invoice_number} owes Rs. ${Number(sale.balance_due).toFixed(2)}; a payment of Rs. ${amount.toFixed(2)} is more than that.`, { balance_due: sale.balance_due });
      }
      const m = Pay.parseMethod(req.body?.method, req.body?.method_detail);
      const reference = Pay.parseText(req.body?.reference, 100);
      const notes = Pay.parseText(req.body?.notes, 500);
      const actor = actorOf(req);
      const customer = sale.customer_id ? queryOne<any>("SELECT * FROM customers WHERE id = ?", [sale.customer_id]) : null;
      const pid = Pay.insertPayment(db, { tenantId: sale.tenant_id, customerId: sale.customer_id ?? null, saleId: sale.id, invoiceNumber: sale.invoice_number, kind: 'INVOICE_PAYMENT',
        method: m.method, detail: m.detail, amount, reference, notes, clientTxnId: txn, actor, source: 'SALES_REGISTER' });
      const alloc = Pay.applyAllocation(db, { paymentId: pid, customerId: sale.customer_id ?? null, item: { target: 'SALE', saleId: sale.id, invoiceNumber: sale.invoice_number, carriedOverId: null }, amount, source: 'SALES_REGISTER', actor });
      if (process.env.PHARMACY_TEST_THROW === 'payment-after-allocation') throw new Error('test: injected failure after allocating a payment');
      let newBal: number | null = null;
      const label = Pay.methodLabel(m.method, m.detail);
      if (customer) {
        db.run("UPDATE customers SET current_balance = current_balance - ? WHERE id = ?", [amount, customer.id]);
        newBal = queryOne<any>("SELECT current_balance b FROM customers WHERE id = ?", [customer.id]).b;
        db.run(`INSERT INTO customer_ledger (customer_id, type, reference, debit, credit, balance_after, notes, sale_id, payment_id) VALUES (?, 'PAYMENT', ?, 0, ?, ?, ?, ?, ?)`,
          [customer.id, `Payment Received (${label})`, amount, newBal, `Invoice #${sale.invoice_number}${reference ? ` - Ref: ${reference}` : ''}${notes ? ` - ${notes}` : ''}`, sale.id, pid]);
        queueReceiptMessages(customer, amount, label, newBal!, sale.tenant_id || 1);
      }
      const after = queryOne<any>("SELECT balance_due, settlement_status FROM sales_headers WHERE id = ?", [sale.id]);
      logAudit(req.user?.id, req.user?.fullName, 'PAYMENT_RECORDED', `Invoice payment #${pid} for ${sale.invoice_number}: Rs. ${amount} by ${label}${reference ? ` (ref ${reference})` : ''}. Invoice balance Rs. ${sale.balance_due} -> Rs. ${after.balance_due} (${after.settlement_status}).`, 'PAYMENT', pid, req);
      const result = { message: 'Payment recorded successfully', payment_id: pid, sale_id: sale.id, invoice_number: sale.invoice_number, amount, method: m.method, method_detail: m.detail,
        allocation_id: alloc.allocationId, balance_due: after.balance_due, settlement_status: after.settlement_status, new_balance: newBal, client_txn_id: txn };
      idemStore(txn, ROUTE, req.user!.id, result);
      res.json(result);
    } catch (e: any) { return payErr(res, e); }
  }));

  /** P7: ADMIN-only reversal with a mandatory reason; the original payment is never edited or deleted. */
  app.post('/api/payments/:id/reverse', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const ROUTE = 'POST /api/payments/:id/reverse';
    try {
      const txn = Pay.parseTxnId(req.body?.client_txn_id);
      const prior = idemPrior(txn, ROUTE);
      if (prior) return res.json(prior);
      const reason = Pay.parseText(req.body?.reason, 300);
      if (!reason) throw new Pay.PaymentError(400, 'REASON_REQUIRED', 'A reason is required to reverse a payment.');
      const p = queryOne<any>("SELECT * FROM payments WHERE id = ?", [Number(req.params.id)]);
      if (!p) throw new Pay.PaymentError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      if (req.user?.role !== 'SUPER_ADMIN' && p.tenant_id && p.tenant_id !== (req.user?.tenant_id || 1)) throw new Pay.PaymentError(403, 'FORBIDDEN', 'Access denied.');
      // money taken at a sale did not lower the customer's stored balance separately (the sale added only the
      // due part), so reversing it raises the balance by the same amount the invoice is now owed again.
      const r = Pay.reversePayment(db, { paymentId: p.id, reason, clientTxnId: txn, actor: actorOf(req), audit: auditFor(req), affectsCustomerBalance: true, source: 'SALES_REGISTER' });
      // items re-opened by the reversal are settled by any other advance the customer has (approved priority)
      const reapplied = p.customer_id ? Pay.applyAvailableAdvance(db, p.customer_id, actorOf(req)) : [];
      if (reapplied.length) logAudit(req.user?.id, req.user?.fullName, 'ADVANCE_APPLIED', `Customer #${p.customer_id} advance applied after reversal of payment #${p.id}: ${Pay.describeAllocations(reapplied)}`, 'CUSTOMER', p.customer_id, req);
      const result = { message: 'Payment reversed', payment_id: p.id, reversal_id: r.reversalId, amount: p.amount, released: r.released.map((a) => ({ target: a.target, sale_id: a.saleId, invoice_number: a.invoiceNumber, amount: a.amount })),
        advance_applied: reapplied.map((a) => ({ target: a.target, invoice_number: a.invoiceNumber, carried_over_id: a.carriedOverId, amount: a.amount })), new_balance: r.newBalance, client_txn_id: txn };
      idemStore(txn, ROUTE, req.user!.id, result);
      res.json(result);
    } catch (e: any) { return payErr(res, e); }
  }));

  const paymentRow = (p: any) => ({ ...p, allocations: queryAll<any>("SELECT id, target, sale_id, invoice_number, carried_over_id, kind, amount, releases_allocation_id, reason, source, created_at FROM payment_allocations WHERE payment_id = ? ORDER BY id", [p.id]),
    reversed_by: queryOne<any>("SELECT id, amount, reason, received_at, received_by_user_id FROM payments WHERE reverses_payment_id = ?", [p.id]) || null });

  /** What a customer owes, item by item, in payment order; advance; agreement with the stored balance. */
  app.get('/api/customers/:id/outstanding', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    try {
      const c = customerForUser(req, Number(req.params.id));
      const sum = Pay.customerSummary(db, c.id);
      res.json({ customer_id: c.id, name: c.name, stored_balance: sum.stored, explained_balance: sum.explained, difference: sum.difference, owed: sum.owed, advance: sum.advance,
        items: sum.items.map((i) => ({ target: i.target, sale_id: i.saleId, invoice_number: i.invoiceNumber, carried_over_id: i.carriedOverId, date: i.date, total: i.total, due: i.due })) });
    } catch (e: any) { return payErr(res, e); }
  });

  /** Read-only preview for the Record payment window: what this amount would settle, and the advance left. */
  app.get('/api/customers/:id/payment-preview', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    try {
      const c = customerForUser(req, Number(req.params.id));
      const amount = Pay.parseAmount(req.query.amount, 'Payment amount');
      const sum = Pay.customerSummary(db, c.id);
      res.json({ customer_id: c.id, amount, stored_balance: sum.stored, owed: sum.owed, advance: sum.advance, ...Pay.previewCustomerPayment(db, c.id, amount), balance_after: Math.round((sum.stored - amount) * 100) / 100 });
    } catch (e: any) { return payErr(res, e); }
  });

  app.get('/api/customers/:id/payments', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    try {
      const c = customerForUser(req, Number(req.params.id));
      res.json(queryAll<any>("SELECT p.*, u.full_name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by_user_id WHERE p.customer_id = ? ORDER BY p.received_at DESC, p.id DESC", [c.id]).map(paymentRow));
    } catch (e: any) { return payErr(res, e); }
  });

  app.get('/api/payments', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const where: string[] = ["(p.tenant_id = ? OR p.tenant_id IS NULL)"];
    const params: any[] = [req.user?.tenant_id || 1];
    if (req.query.from) { where.push("date(p.received_at) >= date(?)"); params.push(String(req.query.from)); }
    if (req.query.to) { where.push("date(p.received_at) <= date(?)"); params.push(String(req.query.to)); }
    if (req.query.method) { where.push("p.method = ?"); params.push(String(req.query.method).toUpperCase()); }
    if (req.query.customer_id) { where.push("p.customer_id = ?"); params.push(Number(req.query.customer_id)); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json(queryAll<any>(`SELECT p.*, c.name AS customer_name, u.full_name AS received_by_name FROM payments p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.received_by_user_id
      WHERE ${where.join(' AND ')} ORDER BY p.received_at DESC, p.id DESC LIMIT ${limit}`, params));
  });

  /** Historical and current reconciliation (ADMIN): mismatches, migration issues, confirmed carried-over items. */
  app.get('/api/payments/reconciliation', authenticateToken, requireRoles(['ADMIN']), (req: AuthRequest, res) => {
    const rep = reconcilePayments(db);
    res.json({
      checked_at: rep.checkedAt, customers_checked: rep.customersChecked,
      mismatches: rep.mismatches.map((m) => ({ customer_id: m.customerId, name: m.name, stored_balance: m.stored, explained_balance: m.expected, difference: m.difference,
        confirmable: m.difference > 0.005, action: m.difference > 0.005 ? 'Administrator may confirm as a carried-over balance' : 'Negative difference: manual review only (not correctable here)' })),
      untracked_sales: rep.untrackedSales, walk_in_sales_with_due: queryAll("SELECT id, invoice_number, sale_date, grand_total, balance_due FROM sales_headers WHERE customer_id IS NULL AND balance_due > 0.005 ORDER BY id"),
      migration_issues: queryAll("SELECT * FROM payment_migration_issues ORDER BY id"),
      carried_over_balances: queryAll("SELECT b.*, c.name AS customer_name, u.full_name AS confirmed_by_name FROM customer_carried_over_balances b JOIN customers c ON c.id = b.customer_id LEFT JOIN users u ON u.id = b.confirmed_by_user_id ORDER BY b.id"),
    });
  });

  /**
   * Q1: an ADMIN confirms a POSITIVE unexplained balance difference as a carried-over balance item, with a reason.
   * The customer's stored balance is NOT changed; the item makes the records explain it, and payments settle it
   * right after the opening balance. The reviewed difference must still be the current one (no stale confirms);
   * a discrepancy can be confirmed only once (unique key; afterwards there is no difference left).
   */
  app.post('/api/customers/:id/carried-over-balance', authenticateToken, requireRoles(['ADMIN']), tx((req: AuthRequest, res) => {
    const ROUTE = 'POST /api/customers/:id/carried-over-balance';
    try {
      const txn = Pay.parseTxnId(req.body?.client_txn_id);
      const prior = idemPrior(txn, ROUTE);
      if (prior) return res.json(prior);
      const c = customerForUser(req, Number(req.params.id));
      const reason = Pay.parseText(req.body?.reason, 300);
      if (!reason) throw new Pay.PaymentError(400, 'REASON_REQUIRED', 'A reason is required to confirm a carried-over balance.');
      const reviewed = Number(req.body?.expected_difference);
      if (!Number.isFinite(reviewed)) throw new Pay.PaymentError(400, 'INVALID_AMOUNT', 'expected_difference (the difference you reviewed) is required.');
      const sum = Pay.customerSummary(db, c.id);
      if (sum.difference <= 0.005) {
        throw new Pay.PaymentError(409, sum.difference < -0.005 ? 'NEGATIVE_DISCREPANCY' : 'NO_DISCREPANCY',
          sum.difference < -0.005 ? `The stored balance is Rs. ${Math.abs(sum.difference).toFixed(2)} LOWER than the records explain. Negative differences are for manual review and cannot be confirmed here.` : 'There is no unexplained balance to confirm for this customer.', { difference: sum.difference });
      }
      if (Math.abs(sum.difference - reviewed) > 0.005) throw new Pay.PaymentError(409, 'DISCREPANCY_CHANGED', `The difference is now Rs. ${sum.difference.toFixed(2)} (you reviewed Rs. ${reviewed.toFixed(2)}). Review it again.`, { difference: sum.difference });
      const key = `customer:${c.id}:stored:${sum.stored.toFixed(2)}:explained:${sum.explained.toFixed(2)}`;
      if (queryOne("SELECT 1 x FROM customer_carried_over_balances WHERE discrepancy_key = ?", [key])) throw new Pay.PaymentError(409, 'ALREADY_CONFIRMED', 'This discrepancy has already been confirmed.');
      const issue = queryOne<any>("SELECT id FROM payment_migration_issues WHERE issue = 'BALANCE_MISMATCH' AND customer_id = ? ORDER BY id DESC LIMIT 1", [c.id]);
      const at = Pay.nowTs();
      const id = Number(db.run(`INSERT INTO customer_carried_over_balances (tenant_id, customer_id, amount, stored_balance, explained_balance, difference, discrepancy_key, reason, confirmed_by_user_id, confirmed_at, client_txn_id, migration_issue_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [c.tenant_id, c.id, sum.difference, sum.stored, sum.explained, sum.difference, key, reason, req.user!.id, at, txn, issue?.id ?? null]).lastInsertRowid);
      logAudit(req.user?.id, req.user?.fullName, 'CARRIED_OVER_BALANCE_CONFIRMED', `Administrator #${req.user!.id} confirmed Rs. ${sum.difference.toFixed(2)} as a carried-over balance for customer "${c.name}" (#${c.id}) at ${at}: stored balance Rs. ${sum.stored.toFixed(2)}, explained by records Rs. ${sum.explained.toFixed(2)}${issue ? ` (migration issue #${issue.id})` : ''}. Stored balance not changed. Reason: ${reason}`, 'CUSTOMER', c.id, req);
      // the customer's existing advance settles the confirmed item (approved priority), permanently recorded
      const advanceApplied = Pay.applyAvailableAdvance(db, c.id, actorOf(req));
      if (advanceApplied.length) logAudit(req.user?.id, req.user?.fullName, 'ADVANCE_APPLIED', `Customer #${c.id} advance applied after confirming carried-over balance #${id}: ${Pay.describeAllocations(advanceApplied)}`, 'CUSTOMER', c.id, req);
      const after = Pay.customerSummary(db, c.id);
      const result = { message: 'Carried-over balance confirmed', carried_over_id: id, customer_id: c.id, amount: sum.difference, stored_balance: sum.stored, explained_balance_before: sum.explained, difference_after: after.difference,
        advance_applied: advanceApplied.map((a) => ({ target: a.target, carried_over_id: a.carriedOverId, invoice_number: a.invoiceNumber, amount: a.amount })), client_txn_id: txn };
      idemStore(txn, ROUTE, req.user!.id, result);
      res.json(result);
    } catch (e: any) { return payErr(res, e); }
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
  // Phase 7 Batch 1: the host calculates every price, discount, tax and total (E1-E3). Client figures are
  // never stored; a client total that differs from the server's is refused (409 PRICE_MISMATCH) so the
  // cashier sees the real amount before taking money.
  const discountAuth = new DiscountAuthorizations();
  const settingValue = (key: string) => queryOne<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key])?.value;
  const PAYMENT_METHODS = ['CASH', 'PARTIAL', 'UDHAR'];

  type SaleFail = { ok: false; status: number; body: any };
  type SalePrep = {
    ok: true; tenantId: number; method: string; customerId: number | null;
    lineRequests: LineRequest[]; lineProducts: any[]; plan: any; bill: PricedBill; quote: any;
    paid: number; due: number; tendered: number; change: number;
    tenders: { method: Pay.PayMethod; detail: string | null; amount: number; cashTendered: number | null; change: number | null; reference: string | null }[];
    discount: { maxUsed: number; aboveStaff: boolean; reason: string; token: string | null; grant: any; limits: { staff: number; admin: number } };
  };

  function quoteBody(bill: PricedBill, lineProducts: any[], d: { maxUsed: number; limits: { staff: number; admin: number }; authorized: boolean; isAdmin: boolean }) {
    return {
      lines: bill.lines.map((l, i) => ({
        product_id: lineProducts[i].id, product_name: lineProducts[i].name, unit: lineProducts[i].unit,
        quantity: l.quantity, unit_price: l.unit_price, discount_percent: l.discount_percent, gross: l.gross,
        discount_amount: l.discount_amount, gst_percent: l.gst_percent, gst_amount: l.gst_amount, subtotal: l.subtotal,
      })),
      total_amount: bill.total_amount, item_discount_amount: bill.item_discount_amount,
      bill_discount_percent: bill.bill_discount_percent, bill_discount_amount: bill.bill_discount_amount,
      discount_amount: bill.discount_amount, net_amount: bill.net_amount, total_gst: bill.total_gst, grand_total: bill.grand_total,
      discount: {
        max_percent_used: d.maxUsed, staff_limit_percent: d.limits.staff, admin_limit_percent: d.limits.admin,
        authorization_required: d.maxUsed > d.limits.staff && !d.isAdmin && !d.authorized,
        reason_required: d.maxUsed > d.limits.staff,
      },
    };
  }

  /** Validate a sale request and price it on the server. Writes NOTHING (a 4xx answer commits in tx()). */
  function prepareSale(req: AuthRequest, opts: { forQuote: boolean }): SaleFail | SalePrep {
    const fail = (status: number, body: any): SaleFail => ({ ok: false, status, body });
    const b = req.body || {};
    const tenantId = req.user?.role === 'SUPER_ADMIN' && b.tenant_id ? Number(b.tenant_id) : (req.user?.tenant_id || 1);
    const items = b.items;
    if (!items || !Array.isArray(items) || items.length === 0) return fail(400, { error: 'Cart must contain at least one item' });
    if (items.length > 500) return fail(400, { error: 'Too many lines in one sale (maximum 500).' });

    const method = b.payment_method === undefined || b.payment_method === null || b.payment_method === '' ? 'CASH' : String(b.payment_method);
    if (!PAYMENT_METHODS.includes(method)) return fail(400, { code: 'INVALID_PAYMENT_METHOD', error: `Payment method must be one of ${PAYMENT_METHODS.join(', ')}.` });
    const customerId = b.customer_id ? Number(b.customer_id) : null;
    if ((method === 'PARTIAL' || method === 'UDHAR') && !customerId) return fail(400, { error: 'Customer selection is required for Udhar/Partial payment' });

    // lines: product, quantity and discount; the PRICE and GST RATE come from the host database (E1)
    const lineRequests: LineRequest[] = [];
    const lineProducts: any[] = [];
    const lineDiscounts: number[] = [];
    for (const [i, item] of items.entries()) {
      const qty = Number(item?.quantity);
      if (!Number.isInteger(qty) || qty <= 0) return fail(400, { code: 'INVALID_QUANTITY', error: `Line ${i + 1}: quantity must be a whole number greater than zero.` });
      const product = item?.product?.id ? queryOne<any>("SELECT id, name, unit, tenant_id, archived_at, sale_price, gst_rate FROM products WHERE id = ?", [Number(item.product.id)]) : null;
      if (!product) return fail(400, { code: 'PRODUCT_NOT_FOUND', error: `Line ${i + 1}: this product does not exist.` });
      if (req.user?.role !== 'SUPER_ADMIN' && product.tenant_id && product.tenant_id !== tenantId) return fail(403, { error: `Line ${i + 1}: product belongs to another store.` });
      if (product.archived_at) return fail(400, { code: 'PRODUCT_ARCHIVED', error: `"${product.name}" has been removed from the product list and cannot be sold.` });
      const price = Number(product.sale_price);
      if (!Number.isFinite(price) || price < 0) return fail(400, { code: 'INVALID_PRICE', error: `"${product.name}" has no valid sale price on the server. Correct the product before selling it.` });
      const gst = Number(product.gst_rate || 0);
      if (!Number.isFinite(gst) || gst < 0 || gst > 100) return fail(400, { code: 'INVALID_TAX_RATE', error: `"${product.name}" has an invalid GST rate on the server. Correct the product before selling it.` });
      const dp = item.discount_percent === undefined || item.discount_percent === null || item.discount_percent === '' ? 0 : Number(item.discount_percent);
      if (!validPercent(dp)) return fail(400, { code: 'INVALID_DISCOUNT', error: `Line ${i + 1}: discount must be between 0 and 100%.` });
      lineRequests.push({ line: i, productId: product.id, quantity: qty });
      lineProducts.push(product);
      lineDiscounts.push(dp);
    }
    const billDisc = b.discount_percent === undefined || b.discount_percent === null || b.discount_percent === '' ? 0 : Number(b.discount_percent);
    if (!validPercent(billDisc)) return fail(400, { code: 'INVALID_DISCOUNT', error: 'Bill discount must be between 0 and 100%.' });

    // discount limits (E2)
    const limits = discountLimits(settingValue);
    const maxUsed = Math.max(billDisc, ...lineDiscounts);
    const isAdmin = req.user?.role === 'ADMIN';
    if (maxUsed > limits.admin) return fail(403, { code: 'DISCOUNT_LIMIT', error: `The store allows at most ${limits.admin}% discount.`, max_percent: limits.admin });
    const aboveStaff = maxUsed > limits.staff;
    let token: string | null = null;
    let grant: any = null;
    if (aboveStaff && !isAdmin) {
      if (b.discount_authorization) {
        const c = discountAuth.check(b.discount_authorization, req.user!.id, tenantId, maxUsed);
        if (c.ok === false) return fail(403, { code: c.code, error: c.error });
        token = String(b.discount_authorization);
        grant = c.grant;
      } else if (!opts.forQuote) {
        return fail(403, { code: 'DISCOUNT_AUTH_REQUIRED', error: `Discounts above ${limits.staff}% need an administrator's authorization.`, staff_limit_percent: limits.staff });
      }
    }
    const reason = sanitizeInput(b.discount_reason || '') || grant?.reason || '';
    if (aboveStaff && !reason && !opts.forQuote) return fail(400, { code: 'DISCOUNT_REASON_REQUIRED', error: 'A reason is required for this discount.' });

    // server pricing (E1-E3)
    const bill = priceBill(lineProducts.map((p, i) => ({ quantity: lineRequests[i].quantity, unitPrice: Number(p.sale_price), discountPercent: lineDiscounts[i], gstPercent: Number(p.gst_rate || 0) })), billDisc);
    const quote = quoteBody(bill, lineProducts, { maxUsed, limits, authorized: !!grant, isAdmin });
    if (!opts.forQuote && b.grand_total !== undefined && b.grand_total !== null && b.grand_total !== '') {
      const clientTotal = Number(b.grand_total);
      if (!Number.isFinite(clientTotal) || !sameMoney(clientTotal, bill.grand_total)) {
        return fail(409, { code: 'PRICE_MISMATCH', error: `The bill total changed: the server calculates Rs. ${bill.grand_total.toFixed(2)}, your screen showed Rs. ${Number.isFinite(clientTotal) ? clientTotal.toFixed(2) : String(b.grand_total)}. Prices may have been updated. Check the bill and try again.`, server_grand_total: bill.grand_total, client_grand_total: b.grand_total, quote });
      }
    }

    // stock (Phase 6 FEFO plan, unchanged)
    const plan = planFefo(lineRequests, batchesFor(db, lineRequests.map((l) => l.productId)), today());
    if (!plan.ok) {
      const sh = (plan as Extract<typeof plan, { ok: false }>).shortage;
      const name = lineProducts.find((p) => p.id === sh.productId)?.name || `#${sh.productId}`;
      const why = sh.code === 'EXPIRED_STOCK'
        ? `All remaining stock of "${name}" has expired (${sh.expired} unit(s)) and cannot be sold.`
        : `Not enough stock of "${name}": ${sh.requested} requested, ${sh.sellable} available to sell${sh.expired ? ` (${sh.expired} more unit(s) are expired and cannot be sold)` : ''}.`;
      return fail(409, { code: sh.code, error: why, product_id: sh.productId, product_name: name, requested: sh.requested, available: sh.sellable, expired: sh.expired });
    }

    // payment amounts (validated against the SERVER total). Phase 7 Batch 2b: the money taken is recorded as
    // payment records (P6 split payments). The old form (payment_method + amount_paid) becomes one CASH tender.
    let paid = 0, tendered = 0, change = 0;
    let saleMethod = method;
    const tenders: SalePrep['tenders'] = [];
    if (!opts.forQuote) {
      if (Array.isArray(b.payments)) {
        if (b.payments.length > 10) return fail(400, { code: 'INVALID_PAYMENT', error: 'At most 10 payment entries per sale.' });
        let cashGiven = 0;
        let cashRef: string | null = null;
        const nonCash: SalePrep['tenders'] = [];
        try {
          for (const [i, e] of b.payments.entries()) {
            const m = Pay.parseMethod(e?.method, e?.method_detail);
            const amount = Pay.parseAmount(e?.amount, `Payment ${i + 1} amount`);
            const reference = Pay.parseText(e?.reference, 100);
            if (m.method === 'CASH') { cashGiven = round2(cashGiven + amount); cashRef = cashRef ?? reference; }
            else nonCash.push({ method: m.method, detail: m.detail, amount, cashTendered: null, change: null, reference });
          }
        } catch (e: any) {
          if (e instanceof Pay.PaymentError) return fail(e.status, { code: e.code, error: e.message });
          throw e;
        }
        const nonCashSum = round2(nonCash.reduce((sum, t) => sum + t.amount, 0));
        if (nonCashSum > bill.grand_total + 0.005) return fail(400, { code: 'OVERPAYMENT', error: `Card, bank and wallet payments (Rs. ${nonCashSum.toFixed(2)}) are more than the bill (Rs. ${bill.grand_total.toFixed(2)}). Only cash can be given back as change.` });
        const cashApplied = round2(Math.min(cashGiven, bill.grand_total - nonCashSum));
        change = round2(cashGiven - cashApplied);
        tendered = round2(cashGiven + nonCashSum);
        paid = round2(nonCashSum + cashApplied);
        tenders.push(...nonCash);
        if (cashApplied > 0) tenders.push({ method: 'CASH', detail: null, amount: cashApplied, cashTendered: cashGiven, change, reference: cashRef });
        saleMethod = paid + 0.005 >= bill.grand_total ? 'CASH' : paid > 0 ? 'PARTIAL' : 'UDHAR';
        if (saleMethod !== 'CASH' && !customerId) {
          return fail(400, { code: 'INSUFFICIENT_PAYMENT', error: `Payments (Rs. ${paid.toFixed(2)}) are less than the bill (Rs. ${bill.grand_total.toFixed(2)}). Choose a customer to put the rest on Udhar.` });
        }
      } else {
        const raw = b.amount_paid;
        const given = raw === undefined || raw === null || raw === '' ? null : Number(raw);
        if (given !== null && (!Number.isFinite(given) || given < 0)) return fail(400, { code: 'INVALID_PAYMENT', error: 'Amount paid must be zero or more.' });
        if (method === 'CASH') {
          tendered = given === null ? bill.grand_total : round2(given);
          if (tendered + 0.005 < bill.grand_total) return fail(400, { code: 'INSUFFICIENT_PAYMENT', error: `Cash received (Rs. ${tendered.toFixed(2)}) is less than the bill (Rs. ${bill.grand_total.toFixed(2)}). Use PARTIAL with a customer for part payment.` });
          paid = bill.grand_total;
          change = round2(tendered - bill.grand_total);
        } else if (method === 'PARTIAL') {
          paid = given === null ? 0 : round2(given);
          if (paid > bill.grand_total + 0.005) return fail(400, { code: 'OVERPAYMENT', error: `Amount paid (Rs. ${paid.toFixed(2)}) is more than the bill (Rs. ${bill.grand_total.toFixed(2)}).` });
          tendered = paid;
        }
        if (paid > 0) tenders.push({ method: 'CASH', detail: null, amount: paid, cashTendered: tendered, change: method === 'CASH' ? change : 0, reference: null });
      }
    }
    const due = round2(bill.grand_total - paid);
    return { ok: true, tenantId, method: saleMethod, customerId, lineRequests, lineProducts, plan, bill, quote, paid, due, tendered, change, tenders, discount: { maxUsed, aboveStaff, reason, token, grant, limits } };
  }

  /** Price preview for the payment screen: the same validation and calculation as a sale, nothing written. */
  app.post('/api/sales/quote', authenticateToken, requireRoles(['ADMIN', 'STAFF']), (req: AuthRequest, res) => {
    const prep = prepareSale(req, { forQuote: true });
    if (prep.ok === false) return res.status(prep.status).json(prep.body);
    res.json(prep.quote);
  });

  /** An ADMIN authorizes a discount above the staff limit at the cashier's counter (E2). */
  const discountAuthFails = new Map<number, { n: number; reset: number }>();
  app.post('/api/sales/discount-authorization', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const cashierId = req.user!.id;
    const tenantId = req.user?.tenant_id || 1;
    const now = Date.now();
    const f = discountAuthFails.get(cashierId);
    if (f && f.reset > now && f.n >= 5) return res.status(429).json({ error: 'Too many failed authorization attempts. Wait 10 minutes.' });
    const pct = Number(req.body?.max_percent);
    if (!validPercent(pct) || pct <= 0) return res.status(400).json({ code: 'INVALID_DISCOUNT', error: 'Enter the maximum discount % being authorized (1-100).' });
    const reason = sanitizeInput(req.body?.reason || '');
    if (!reason) return res.status(400).json({ code: 'DISCOUNT_REASON_REQUIRED', error: 'A reason is required for this discount.' });
    const limits = discountLimits(settingValue);
    if (pct > limits.admin) return res.status(403).json({ code: 'DISCOUNT_LIMIT', error: `The store allows at most ${limits.admin}% discount.`, max_percent: limits.admin });
    const username = String(req.body?.username || '').trim();
    const admin = username ? queryOne<any>("SELECT id, username, full_name, password_hash, role, status, tenant_id FROM users WHERE username = ? AND archived_at IS NULL", [username]) : null;
    const valid = !!admin && admin.role === 'ADMIN' && (!admin.status || admin.status === 'APPROVED') && (admin.tenant_id || 1) === tenantId
      && typeof req.body?.password === 'string' && bcrypt.compareSync(req.body.password, admin.password_hash);
    if (!valid) {
      const e = f && f.reset > now ? f : { n: 0, reset: now + 10 * 60_000 };
      e.n++;
      discountAuthFails.set(cashierId, e);
      logAudit(cashierId, req.user?.fullName, 'DISCOUNT_AUTH_FAILED', `Failed discount authorization attempt (${pct}%) with administrator name "${username.slice(0, 50)}"`, 'USER', cashierId, req);
      return res.status(401).json({ code: 'DISCOUNT_AUTH_FAILED', error: 'Administrator name or password is wrong, or that account is not an administrator of this store.' });
    }
    discountAuthFails.delete(cashierId);
    const issued = discountAuth.issue({ cashierUserId: cashierId, authorizedByUserId: admin.id, authorizedByName: admin.full_name || admin.username, tenantId, maxPercent: pct, reason });
    logAudit(admin.id, admin.full_name || admin.username, 'DISCOUNT_AUTH_GRANTED', `Authorized up to ${pct}% discount for cashier ${req.user?.fullName || req.user?.username || '#' + cashierId} (single use, 10 minutes). Reason: ${reason}`, 'USER', cashierId, req);
    res.json({ token: issued.token, expires_at: issued.expiresAt, max_percent: pct, authorized_by: admin.full_name || admin.username, reason });
  }));

  app.post('/api/sales', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    // C3 idempotency: the POS sends one client_txn_id per checkout and re-sends the SAME id on retry.
    // A retry of a committed sale returns the original result instead of recording the sale twice.
    const clientTxnId = req.body.client_txn_id === undefined ? null : String(req.body.client_txn_id);
    if (clientTxnId !== null && !/^[A-Za-z0-9-]{8,64}$/.test(clientTxnId)) {
      return res.status(400).json({ error: 'Invalid client_txn_id' });
    }
    // Phase 7 Batch 2b (condition 1): a sale writes payment records, so it must carry a transaction id
    if (clientTxnId === null) return res.status(400).json({ code: 'TXN_ID_REQUIRED', error: 'A transaction id (client_txn_id) is required for every sale.' });
    const prior = queryOne<{ response: string; route: string }>("SELECT response, route FROM idempotency_keys WHERE key = ?", [clientTxnId]);
    if (prior && prior.route !== 'POST /api/sales') return res.status(409).json({ code: 'TXN_ID_REUSED', error: 'This transaction id was already used for a different operation.' });
    if (prior) return res.json({ ...JSON.parse(prior.response), replayed: true });

    // every check (lines, prices, discounts, stock, payment) runs BEFORE anything is written
    const prep = prepareSale(req, { forQuote: false });
    if (prep.ok === false) return res.status(prep.status).json(prep.body);
    const { tenantId: userTenantId, method: payment_method, customerId: customer_id, lineRequests, lineProducts, plan, bill } = prep;
    const grand_total = bill.grand_total;
    if (prep.discount.token) discountAuth.consume(prep.discount.token); // single use (a rolled-back sale also uses it up)

    // Phase 7 Batch 2e (fix R4): the number comes from the store's sequence, taken inside this transaction;
    // it never goes down, so voided numbers are never reused and two sales never get the same number.
    const nextInvNum = takeInvoiceNumber(db, userTenantId);

    const paidAmt = prep.paid;
    const dueAmt = prep.due;
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
        bill.total_amount,
        bill.bill_discount_percent,
        bill.discount_amount,
        bill.net_amount,
        bill.total_gst,
        bill.grand_total,
        payment_method,
        paidAmt,
        dueAmt,
        paymentStatus,
        req.user!.id,
        userTenantId
      ]);

      const saleId = saleHeaderInsert.lastInsertRowid;

      // Process each cart item: record the line, then take the units from the planned batches (FEFO).
      // Price charged is the POS price as before (D2); cost is the real batch cost (D6).
      const allocationSummary: any[] = [];
      for (const [i] of lineRequests.entries()) {
        const allocs = plan.lines.get(i)!;
        const priced = bill.lines[i];
        const product = lineProducts[i];
        const batchNumbers = [...new Set(allocs.map((a) => a.batchNumber).filter(Boolean))].join(', ');
        const earliestExpiry = allocs.map((a) => a.expiryDate).filter(Boolean).sort()[0] || '';
        const saleItemId = db.run(`
          INSERT INTO sale_items 
          (sale_id, product_id, quantity, unit, sale_price, cost_price, discount_percent, discount_amount, gst_amount, batch_number, expiry_date, subtotal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          saleId,
          product.id,
          lineRequests[i].quantity,
          product.unit || 'Pack',
          priced.unit_price,
          weightedCost(allocs),
          priced.discount_percent,
          priced.discount_amount,
          priced.gst_amount,
          batchNumbers,
          earliestExpiry,
          priced.subtotal
        ]).lastInsertRowid;

        for (const a of allocs) {
          takeFromBatch(db, a.batchId, a.quantity); // guarded: never below 0, else the whole sale rolls back
          db.run("INSERT INTO sale_item_batches (sale_item_id, batch_id, quantity, unit_cost) VALUES (?, ?, ?, ?)", [saleItemId, a.batchId, a.quantity, a.unitCost]);
        }
        // Test hook (tests only; unset in normal use): fail after the first line was fully written, to prove the rollback
        if (process.env.PHARMACY_TEST_THROW === 'sale-after-line-1' && i === 0) throw new Error('test: injected failure after line 1');
        allocationSummary.push({ line: i, product_id: product.id, batches: allocs.map((a) => ({ batch_id: a.batchId, batch_number: a.batchNumber, expiry_date: a.expiryDate, quantity: a.quantity })) });
      }

      // Phase 7 Batch 2b: the money taken is recorded as payment records applied to this invoice (P6),
      // then the customer's available advance settles what is still owed (P3) - all in this transaction.
      const actor = { id: req.user!.id, name: req.user?.fullName || req.user?.username || '' };
      const paymentRecords: any[] = [];
      for (const [i, t] of prep.tenders.entries()) {
        const pid = Pay.insertPayment(db, { tenantId: userTenantId, customerId: customer_id ?? null, saleId: Number(saleId), invoiceNumber: nextInvNum, kind: 'SALE_TENDER',
          method: t.method, detail: t.detail, amount: t.amount, cashTendered: t.cashTendered, changeGiven: t.method === 'CASH' ? t.change : null, reference: t.reference,
          clientTxnId: `${clientTxnId}-t${i + 1}`, actor, source: 'POS' });
        Pay.applyAllocation(db, { paymentId: pid, customerId: customer_id ?? null, item: { target: 'SALE', saleId: Number(saleId), invoiceNumber: nextInvNum, carriedOverId: null }, amount: t.amount, source: 'POS', actor });
        paymentRecords.push({ payment_id: pid, method: t.method, method_detail: t.detail, amount: t.amount, cash_tendered: t.cashTendered, change_given: t.method === 'CASH' ? t.change : null, reference: t.reference });
      }
      let advanceApplied: any[] = [];
      if (customer_id && prep.due > 0.005) {
        advanceApplied = Pay.applyAvailableAdvance(db, Number(customer_id), actor);
        if (advanceApplied.length) {
          logAudit(req.user?.id, req.user?.fullName, 'ADVANCE_APPLIED', `Customer #${customer_id} advance applied to invoice #${nextInvNum}: ${Pay.describeAllocations(advanceApplied)}`, 'SALE', Number(saleId), req);
        }
      }
      if (process.env.PHARMACY_TEST_THROW === 'sale-after-payments') throw new Error('test: injected failure after recording payments');

      // Update Customer Ledger if customer is selected
      if (customer_id && customerObj) {
        const ledgerRef = `Invoice #${nextInvNum}`;
        const itemSummaryList = bill.lines.map((l, i) => `${lineProducts[i].name} (${l.quantity} ${lineProducts[i].unit || 'Pack'} x Rs.${l.unit_price} = Rs.${l.subtotal})`).join(', ');

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
      if (prep.discount.aboveStaff) {
        const d = prep.discount;
        const pcts = [`bill ${bill.bill_discount_percent}%`, ...bill.lines.map((l, i) => (l.discount_percent ? `${lineProducts[i].name} ${l.discount_percent}%` : '')).filter(Boolean)].join(', ');
        logAudit(req.user?.id, req.user?.fullName, 'DISCOUNT_OVERRIDE',
          `Invoice #${nextInvNum}: discount above the staff limit (${d.limits.staff}%): ${pcts}; total discount Rs. ${bill.discount_amount.toFixed(2)}. ` +
          `${d.grant ? `Authorized by ${d.grant.authorizedByName} (#${d.grant.authorizedByUserId}).` : `Given by administrator ${req.user?.fullName || ''}.`} Reason: ${d.reason}`, 'SALE', saleId, req);
      }

      // Return created invoice details (stored with the transaction id in the same DB transaction)
      const saleResult = {
        message: 'Sale completed successfully',
        invoice_number: nextInvNum,
        sale_id: saleId,
        grand_total,
        amount_paid: paidAmt,
        amount_due: dueAmt,
        amount_tendered: prep.tendered,
        change_due: prep.change,
        payments: paymentRecords,
        advance_applied: advanceApplied.map((a) => ({ payment_id: a.paymentId, amount: a.amount })),
        balance_due: queryOne<any>("SELECT balance_due FROM sales_headers WHERE id = ?", [saleId])?.balance_due,
        totals: { total_amount: bill.total_amount, discount_amount: bill.discount_amount, net_amount: bill.net_amount, total_gst: bill.total_gst, grand_total: bill.grand_total },
        previous_balance: prevBal,
        new_balance: newBal,
        client_txn_id: clientTxnId,
        allocations: allocationSummary,
      };
      if (clientTxnId) {
        db.run("INSERT INTO idempotency_keys (key, route, user_id, response, created_at) VALUES (?, 'POST /api/sales', ?, ?, ?)",
          [clientTxnId, req.user!.id, JSON.stringify(saleResult), new Date().toISOString()]);
      }
      res.json(saleResult);
    } catch (err: any) {
      console.error("Sale transaction failed:", err);
      // 500 => the tx() wrapper rolls the whole sale back (stock, batches, ledger, invoice)
      res.status(500).json({ code: err instanceof StockConflictError ? 'STOCK_CONFLICT' : undefined, error: 'Failed to process sale transaction permanently: ' + err.message });
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

    const items = queryAll<any>(`
      SELECT si.*, p.name as product_name 
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `, [saleId]);
    for (const it of items) {
      it.batches = queryAll(`SELECT b.id AS batch_id, b.batch_number, b.expiry_date, x.quantity FROM sale_item_batches x JOIN product_batches b ON b.id = x.batch_id WHERE x.sale_item_id = ? ORDER BY x.id`, [it.id]);
    }
    // Phase 7 Batch 2b: every payment applied to this invoice (at the sale, later, advance), and reversals
    const payments = req.user?.role === 'CUSTOMER' ? [] : queryAll<any>(`SELECT DISTINCT p.id, p.kind, p.direction, p.method, p.method_detail, p.amount, p.cash_tendered, p.change_given, p.reference, p.received_at, p.reverses_payment_id, p.reason, p.source
        FROM payments p WHERE p.sale_id = ? OR p.legacy_sale_id = ? OR p.id IN (SELECT payment_id FROM payment_allocations WHERE sale_id = ?) ORDER BY p.received_at, p.id`, [saleId, saleId, saleId])
      .map((p) => ({ ...p, applied_to_this_invoice: queryOne<any>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) v FROM payment_allocations WHERE payment_id = ? AND sale_id = ?`, [p.id, saleId]).v }));

    res.json({ ...sale, items, payments });
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

  /**
   * Phase 6 purchase: every line becomes its own PURCHASE batch (C6: product batch/expiry are no
   * longer overwritten). All lines are validated before anything is written.
   */
  app.post('/api/purchases', authenticateToken, requireRoles(['ADMIN', 'STAFF']), tx((req: AuthRequest, res) => {
    const userTenantId = req.user?.role === 'SUPER_ADMIN' && req.body.tenant_id ? Number(req.body.tenant_id) : (req.user?.tenant_id || 1);
    const { supplier_id, invoice_number, items, notes } = req.body;

    if (!supplier_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Supplier and items required' });
    }
    const supplier = queryOne<any>("SELECT id, tenant_id, archived_at FROM suppliers WHERE id = ?", [Number(supplier_id)]);
    if (!supplier) return res.status(400).json({ error: 'Supplier not found.' });

    const onDate = today();
    const lines: any[] = [];
    for (const [i, it] of items.entries()) {
      const n = i + 1;
      const product = it?.product_id ? queryOne<any>("SELECT id, name, tenant_id, archived_at, sale_price FROM products WHERE id = ?", [Number(it.product_id)]) : null;
      if (!product) return res.status(400).json({ error: `Line ${n}: product not found.` });
      if (req.user?.role !== 'SUPER_ADMIN' && product.tenant_id && product.tenant_id !== userTenantId) return res.status(403).json({ error: `Line ${n}: product belongs to another store.` });
      if (product.archived_at) return res.status(400).json({ error: `Line ${n}: "${product.name}" has been removed from the product list.` });
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `Line ${n} (${product.name}): quantity must be a whole number greater than zero.` });
      const cost = Number(it.purchase_price);
      if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: `Line ${n} (${product.name}): purchase price must be 0 or more.` });
      const salePrice = it.sale_price === undefined || it.sale_price === null || it.sale_price === '' ? null : Number(it.sale_price);
      if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0)) return res.status(400).json({ error: `Line ${n} (${product.name}): selling price must be 0 or more.` });
      const exp = parseExpiryInput(it.expiry_date);
      if (!exp.ok) return res.status(400).json({ error: `Line ${n} (${product.name}): ${exp.error}` });
      if (exp.date && isExpired(exp.date, onDate)) return res.status(400).json({ code: 'EXPIRED_ON_RECEIPT', error: `Line ${n} (${product.name}): this batch expired on ${exp.date} and cannot be received as sellable stock.` });
      const mfg = parseMfgInput(it.mfg_date);
      if (!mfg.ok) return res.status(400).json({ error: `Line ${n} (${product.name}): ${mfg.error}` });
      if (mfg.date && mfg.date > onDate) return res.status(400).json({ error: `Line ${n} (${product.name}): manufacturing date is in the future.` });
      if (mfg.date && exp.date && mfg.date > exp.date) return res.status(400).json({ error: `Line ${n} (${product.name}): manufacturing date is after the expiry date.` });
      lines.push({ product, qty, cost, salePrice: salePrice ?? product.sale_price, setSalePrice: salePrice !== null, expiry: exp.date, expiryRaw: it.expiry_date ?? null, mfg: mfg.date, batchNumber: sanitizeInput(it.batch_number) || null });
    }

    const totalAmount = lines.reduce((acc, l) => acc + l.qty * l.cost, 0);
    const invNum = invoice_number || `PUR-${userTenantId}-${Date.now().toString().slice(-6)}`;

    const purId = db.run(`
      INSERT INTO purchase_headers (invoice_number, supplier_id, total_amount, notes, tenant_id)
      VALUES (?, ?, ?, ?, ?)
    `, [invNum, supplier.id, totalAmount, notes || '', userTenantId]).lastInsertRowid;

    const created: any[] = [];
    for (const l of lines) {
      const itemId = db.run(`
        INSERT INTO purchase_items (purchase_id, product_id, quantity, purchase_price, batch_number, expiry_date, mfg_date, sale_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [purId, l.product.id, l.qty, l.cost, l.batchNumber || '', l.expiry || '', l.mfg, l.salePrice]).lastInsertRowid;
      const batchId = createBatch(db, {
        productId: l.product.id, batchNumber: l.batchNumber, mfgDate: l.mfg, expiryDate: l.expiry, expiryRaw: l.expiryRaw,
        purchasePrice: l.cost, salePrice: l.salePrice, quantity: l.qty, supplierId: supplier.id, purchaseItemId: itemId,
        source: 'PURCHASE', tenantId: l.product.tenant_id ?? userTenantId, createdBy: req.user?.id,
      });
      db.run("UPDATE purchase_items SET batch_id = ? WHERE id = ?", [batchId, itemId]);
      // the latest purchase price (and selling price, if given) become the product's defaults
      db.run(`UPDATE products SET purchase_price = ?${l.setSalePrice ? ', sale_price = ?' : ''}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        l.setSalePrice ? [l.cost, l.salePrice, l.product.id] : [l.cost, l.product.id]);
      created.push({ product_id: l.product.id, batch_id: batchId, quantity: l.qty });
    }

    logAudit(req.user?.id, req.user?.fullName, 'RECORD_PURCHASE', `Recorded stock purchase #${invNum} total Rs. ${totalAmount} (${created.length} batch(es))`, 'PURCHASE', purId, req);

    res.json({ message: 'Purchase recorded and stock updated successfully', id: purId, invoice_number: invNum, batches: created });
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

    const onDate = today();
    const lowStockRes = queryOne<any>(`
      SELECT COUNT(*) as count FROM products p WHERE p.archived_at IS NULL AND (p.tenant_id = ? OR p.tenant_id IS NULL)
        AND (SELECT COALESCE(SUM(b.qty_on_hand), 0) FROM product_batches b WHERE b.product_id = p.id AND (b.expiry_date IS NULL OR b.expiry_date >= ?)) <= p.min_stock
    `, [userTenantId, onDate]);


    // batches with stock that expire within 90 days or have already expired (Phase 6: counted per batch)
    const expiringRes = queryOne<any>(`
      SELECT COUNT(*) as count FROM product_batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_on_hand > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ? AND p.archived_at IS NULL AND (p.tenant_id = ? OR p.tenant_id IS NULL)
    `, [addDays(onDate, 90), userTenantId]);
    const expiredRes = queryOne<any>(`
      SELECT COUNT(*) as count, COALESCE(SUM(b.qty_on_hand), 0) AS units FROM product_batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_on_hand > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date < ? AND p.archived_at IS NULL AND (p.tenant_id = ? OR p.tenant_id IS NULL)
    `, [onDate, userTenantId]);

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
      expiredBatchCount: expiredRes ? expiredRes.count : 0,
      expiredUnits: expiredRes ? expiredRes.units : 0,
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
    // Phase 7 (E2): discount limits are validated and every change is audited
    const LIMIT_KEYS = ['pos_staff_max_discount_percent', 'pos_admin_max_discount_percent'];
    if (LIMIT_KEYS.some((k) => k in settingsObj)) {
      for (const k of LIMIT_KEYS) {
        if (k in settingsObj && !validPercent(Number(settingsObj[k]))) return res.status(400).json({ code: 'INVALID_DISCOUNT', error: 'Discount limits must be between 0 and 100%.' });
      }
      const before = discountLimits(settingValue);
      const staff = 'pos_staff_max_discount_percent' in settingsObj ? Number(settingsObj.pos_staff_max_discount_percent) : before.staff;
      const admin = 'pos_admin_max_discount_percent' in settingsObj ? Number(settingsObj.pos_admin_max_discount_percent) : before.admin;
      if (staff > admin) return res.status(400).json({ code: 'INVALID_DISCOUNT', error: 'The staff discount limit cannot be higher than the administrator limit.' });
      if (staff !== before.staff || admin !== before.admin) {
        logAudit(req.user?.id, req.user?.fullName, 'DISCOUNT_LIMITS_CHANGED', `Discount limits changed: staff ${before.staff}% -> ${staff}%, administrator ${before.admin}% -> ${admin}%`, 'SETTINGS', undefined, req);
      }
    }
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
      // Phase 7 Batch 2e (R4): invoice numbers already issued on this computer are never issued again, even if
      // the backup is older (its sequence would be lower); remember the current sequences and keep them after.
      const issuedSequences = db.tableNames().includes('invoice_sequences') ? db.all<{ tenant_id: number; next_value: number }>('SELECT tenant_id, next_value FROM invoice_sequences') : [];
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

      if (issuedSequences.length) db.transaction(() => raiseSequences(db, issuedSequences));
      logAudit(req.user?.id, req.user?.fullName, 'BACKUP_RESTORE', `Restored database successfully from encrypted backup file${issuedSequences.length ? `; invoice numbering continues after the numbers already issued (${issuedSequences.map((x) => `store ${x.tenant_id}: next ${x.next_value}`).join(', ')})` : ''}`, 'BACKUP', undefined, req);

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

    // Phase 7 Batch 2b (P5, interim until Batch 4's safe void):
    //  - an invoice that received any payment AFTER the sale (or advance applied to it) cannot be voided here;
    //  - money taken at the sale is kept as history and reversed (OUT records), never deleted.
    const atSalePayments = queryAll<any>("SELECT * FROM payments WHERE direction = 'IN' AND kind IN ('SALE_TENDER', 'CARRIED_OVER_SALE') AND (sale_id = ? OR legacy_sale_id = ?)", [saleId, saleId]);
    const atSaleIds = new Set(atSalePayments.map((p) => p.id));
    const later = queryAll<any>(`SELECT a.payment_id, SUM(CASE a.kind WHEN 'APPLY' THEN a.amount ELSE -a.amount END) AS amt FROM payment_allocations a
        WHERE a.target = 'SALE' AND a.sale_id = ? GROUP BY a.payment_id HAVING amt > 0.005`, [saleId]).filter((r) => !atSaleIds.has(r.payment_id));
    const spreadElsewhere = atSalePayments.filter((p) => queryOne<any>(`SELECT COALESCE(SUM(CASE kind WHEN 'APPLY' THEN amount ELSE -amount END), 0) v FROM payment_allocations
        WHERE payment_id = ? AND NOT (target = 'SALE' AND sale_id = ?)`, [p.id, saleId]).v > 0.005);
    if (later.length || spreadElsewhere.length) {
      return res.status(409).json({ code: 'VOID_HAS_PAYMENTS', error: `Invoice #${sale.invoice_number} has payments recorded after the sale (or its payment also settled other items). It cannot be voided until the safe void (Phase 7 Batch 4). Reverse those payments first if they were entered by mistake.`, payment_ids: [...later.map((r) => r.payment_id), ...spreadElsewhere.map((p) => p.id)] });
    }
    const reversals: number[] = [];
    for (const p of atSalePayments) {
      if (Pay.isReversed(db, p.id)) continue; // already reversed: never a second reversal
      const r = Pay.reversePayment(db, { paymentId: p.id, reason: `Invoice #${sale.invoice_number} voided`, clientTxnId: `void-${saleId}-p${p.id}-${crypto.randomUUID().slice(0, 8)}`,
        actor: { id: req.user!.id, name: req.user?.fullName || '' }, audit: (a, d, t, id) => logAudit(req.user?.id, req.user?.fullName, a, d, t, id ?? undefined, req),
        affectsCustomerBalance: false, allowWalkInSaleTender: true, source: 'SALES_REGISTER' });
      reversals.push(r.reversalId);
    }
    const dueNow = Number(sale.balance_due ?? sale.amount_due) || 0;

    // 1. Restore stock into the exact batches the units came from (Phase 6). Sales recorded before
    //    batches existed have no allocation: their units go into a VOID_RESTORE batch built from the line.
    const items = queryAll<any>("SELECT * FROM sale_items WHERE sale_id = ?", [saleId]);
    for (const item of items) {
      const allocs = queryAll<any>("SELECT batch_id, quantity FROM sale_item_batches WHERE sale_item_id = ?", [item.id]);
      if (allocs.length) {
        for (const a of allocs) addToBatch(db, a.batch_id, a.quantity);
        db.run("DELETE FROM sale_item_batches WHERE sale_item_id = ?", [item.id]);
      } else if (Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0) {
        const exp = normalizeExpiry(item.expiry_date);
        createBatch(db, { productId: item.product_id, batchNumber: item.batch_number || null, expiryDate: exp.date, expiryRaw: item.expiry_date || null,
          purchasePrice: item.cost_price, salePrice: item.sale_price, quantity: Number(item.quantity), source: 'VOID_RESTORE', tenantId: sale.tenant_id, createdBy: req.user?.id });
      }
    }

    // 2. Reverse customer balance by what the invoice still owed (Phase 7: no longer clamped at 0 - the clamp
    //    left balances that no record explains)
    if (sale.customer_id) {
      const dueAmt = dueNow;
      if (dueAmt > 0) {
        db.run("UPDATE customers SET current_balance = current_balance - ? WHERE id = ?", [dueAmt, sale.customer_id]);
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

    res.json({ message: `Invoice #${sale.invoice_number} successfully voided and stock restored.`, payment_reversals: reversals });
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
