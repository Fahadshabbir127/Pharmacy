/**
 * Test helper: runs the backend as a real child process in an isolated temp
 * working directory, so the server's `process.cwd()/data` database never
 * touches the repository or any real pharmacy data.
 *
 * The legacy server hardcodes port 3000, so tests run sequentially
 * (see vitest.config.ts: fileParallelism=false).
 */
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const CURRENT_SERVER = path.join(PROJECT_ROOT, 'server.ts');
export const ORIGINAL_SERVER = path.join(PROJECT_ROOT, 'tests', 'legacy', 'server.original.ts');
// Run node directly with the tsx loader (one process). The `tsx` CLI runs the script in a
// child process, so killing the CLI with SIGKILL would orphan the real server.
const TSX_LOADER = pathToFileURL(createRequire(__filename).resolve('tsx')).href;

export const PORT = 3000;

// Every spawned server is tracked and hard-killed when the test worker exits, so a test that
// times out can never leave a server holding the port for the next test file.
const live = new Set<ChildProcess>();
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch { /* already gone */ } } });
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export interface RunningServer {
  workDir: string;
  dbFile: string;
  logs: () => string;
  stop: () => Promise<void>;
  /** Hard kill (SIGKILL): simulates a crash or power cut - no shutdown code runs. */
  kill: () => Promise<void>;
}

export function makeTempDir(prefix = 'pharmacy-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function waitForServer(proc: ChildProcess, logs: () => string, timeoutMs = 45000, tlsPin?: string): Promise<void> {
  const start = Date.now();
  let lastCheck = 'no check completed';
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Server exited early with code ${proc.exitCode ?? proc.signalCode}\n${logs()}`);
    }
    try {
      if (tlsPin) {
        const { pinnedJson } = await import('../../server/lan/pinnedClient');
        const status = (await pinnedJson(`https://127.0.0.1:${PORT}/api/health`, tlsPin)).status;
        if (status === 200) return;
        lastCheck = `HTTP ${status}`;
      } else {
        const res = await fetch(`${BASE_URL}/api/auth/me`);
        if (res.status === 401) return; // routes registered, auth middleware active
        lastCheck = `HTTP ${res.status}`;
      }
    } catch (e: any) {
      lastCheck = e?.cause?.code || e?.code || e?.message || String(e); // not listening yet (normally ECONNREFUSED)
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready within ${timeoutMs} ms (server process ${proc.pid} still running; last readiness check: ${lastCheck})\n${logs()}`);
}

/**
 * Start a server.
 * @param opts.workDir   existing working dir (reuse to test persistence); a new temp dir otherwise
 * @param opts.entry     server entry file (defaults to the current server.ts)
 * @param opts.seedDb    path of a database file to COPY into workDir/data before start
 */
/**
 * @param opts.tlsPin  the server is started with TLS (cert files in env); readiness is checked over pinned HTTPS
 */
export async function startServer(opts: { workDir?: string; entry?: string; seedDb?: string; env?: Record<string, string>; tlsPin?: string } = {}): Promise<RunningServer> {
  if (await portInUse(PORT)) {
    throw new Error(`Port ${PORT} is already in use; stop the other server before running tests.`);
  }
  const workDir = opts.workDir ?? makeTempDir();
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'khushi_pharmacy.sqlite');
  if (opts.seedDb) fs.copyFileSync(opts.seedDb, dbFile);

  let output = '';
  const proc = spawn(process.execPath, ['--import', TSX_LOADER, opts.entry ?? CURRENT_SERVER], {
    cwd: workDir,
    // PHARMACY_TEST_LEGACY_SEED: load the original demo seed (known demo logins) - tests only, never in the app
    // PHARMACY_TEST_TODAY: a fixed pharmacy date, so the demo seed's expiry dates (some in 2026) do not make
    // tests change outcome as the real calendar moves on. Expiry tests set their own date explicitly.
    env: { ...process.env, NODE_ENV: 'production', PHARMACY_TEST_LEGACY_SEED: '1', PHARMACY_TEST_TODAY: '2026-06-01', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(proc);
  // Record the exit once, when it happens. stop()/kill() must not rely on `exitCode` alone: a process ended by a
  // signal has exitCode === null (always so on Windows, where kill('SIGTERM') terminates at once), and a new
  // once('exit') listener added after the process has gone never fires.
  let hasExited = false;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => { hasExited = true; live.delete(proc); resolve(); }));
  proc.stdout!.on('data', (d) => { output += d.toString(); });
  proc.stderr!.on('data', (d) => { output += d.toString(); });
  const logs = () => output;

  try {
    await waitForServer(proc, logs, 45000, opts.tlsPin);
  } catch (e) {
    proc.kill('SIGKILL');
    await exited; // never leave a half-started server behind holding the port
    throw e;
  }

  const waitPortFree = async () => {
    for (let i = 0; i < 40 && (await portInUse(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
  };
  return {
    workDir,
    dbFile,
    logs,
    kill: async () => {
      if (!hasExited) {
        proc.kill('SIGKILL');
        await exited;
      }
      await waitPortFree();
    },
    stop: async () => {
      if (!hasExited) {
        proc.kill('SIGTERM');
        const fallback = setTimeout(() => { if (!hasExited) proc.kill('SIGKILL'); }, 5000);
        await exited;
        clearTimeout(fallback);
      }
      // wait until the port is released so the next test can bind it
      await waitPortFree();
    },
  };
}

/** Minimal JSON API client for tests. */
export class Api {
  token: string | null = null;

  async call<T = any>(method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${BASE_URL}/api${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  get<T = any>(e: string) { return this.call<T>('GET', e); }
  post<T = any>(e: string, b?: unknown) { return this.call<T>('POST', e, b ?? {}); }
  put<T = any>(e: string, b?: unknown) { return this.call<T>('PUT', e, b ?? {}); }
  del<T = any>(e: string) { return this.call<T>('DELETE', e); }

  async login(username: string, password: string): Promise<any> {
    const r = await this.post('/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    return r.body.user;
  }
}

/** Build the cart item shape the POS (BillingScreen) sends to POST /api/sales. */
export function cartItem(product: any, quantity: number, opts: { unit_price?: number; discount_percent?: number } = {}) {
  const unit_price = opts.unit_price ?? product.sale_price;
  const discount_percent = opts.discount_percent ?? 0;
  const gross = unit_price * quantity;
  const discount_amount = +(gross * discount_percent / 100).toFixed(2);
  const gst_amount = +((gross - discount_amount) * (product.gst_rate || 0) / 100).toFixed(2);
  return {
    product,
    quantity,
    unit_price,
    discount_percent,
    discount_amount,
    gst_amount,
    subtotal: +(gross - discount_amount + gst_amount).toFixed(2),
  };
}

export function salePayload(items: any[], extra: Record<string, unknown> = {}) {
  const total_amount = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const discount_amount = items.reduce((s, i) => s + i.discount_amount, 0);
  const total_gst = items.reduce((s, i) => s + i.gst_amount, 0);
  const grand_total = +(total_amount - discount_amount + total_gst).toFixed(2);
  return {
    items,
    total_amount,
    discount_percent: 0,
    discount_amount,
    net_amount: total_amount - discount_amount,
    total_gst,
    grand_total,
    payment_method: 'CASH',
    amount_paid: grand_total,
    // Phase 7 Batch 2b: every sale carries a transaction id (a new one per payload unless the test sets one)
    client_txn_id: crypto.randomUUID(),
    ...extra,
  };
}
