/**
 * Runs the Express backend as an Electron utilityProcess (Electron's bundled Node; no Node.js
 * installation needed on the customer PC) and restarts it if it crashes.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, utilityProcess, UtilityProcess } from 'electron';
import { paths, log } from './store';
import type { LocalCert } from './certs';

export interface BackendInfo { port: number; fingerprint: string; localToken: string }

type Listener = (event: { type: 'started' | 'exited' | 'restarting' | 'failed'; detail?: string }) => void;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export class BackendSupervisor {
  private child: UtilityProcess | null = null;
  private stopping = false;
  private crashes: number[] = [];
  private listeners: Listener[] = [];
  info: BackendInfo | null = null;

  constructor(private readonly opts: { mode: 'standalone' | 'host'; hostPort: number; cert: LocalCert }) {}

  onEvent(l: Listener) { this.listeners.push(l); }
  private emit(e: Parameters<Listener>[0]) { for (const l of this.listeners) l(e); }

  async start(): Promise<BackendInfo> {
    this.stopping = false;
    const port = this.opts.mode === 'host' ? this.opts.hostPort : await freePort();
    const localToken = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(paths.logs(), { recursive: true });
    const out = fs.createWriteStream(path.join(paths.logs(), 'backend.log'), { flags: 'a' });

    const child = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
      serviceName: 'BrainTech Pharmacy backend',
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PHARMACY_MODE: this.opts.mode,
        PHARMACY_PORT: String(port),
        PHARMACY_BIND: this.opts.mode === 'host' ? '0.0.0.0' : '127.0.0.1',
        PHARMACY_DATA_DIR: paths.data(),
        PHARMACY_DB_FILENAME: 'pharmacy.sqlite',
        PHARMACY_APP_VERSION: app.getVersion(),
        PHARMACY_TEST_LEGACY_SEED: '', // never in the desktop app
      },
    });
    this.child = child;
    child.stdout?.on('data', (d) => out.write(d));
    child.stderr?.on('data', (d) => out.write(d));

    const listening = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The pharmacy backend did not start within 60 seconds. See logs/backend.log.')), 60_000);
      child.on('message', (m: any) => {
        if (m?.type === 'listening') { clearTimeout(timer); resolve(m.port); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`The pharmacy backend stopped during startup (exit code ${code}). See logs/backend.log - a damaged database or failed upgrade stops startup on purpose.`)); });
    });
    child.postMessage({ tls: { cert: this.opts.cert.cert, key: this.opts.cert.key }, localToken });

    const actualPort = await listening;
    this.info = { port: actualPort, fingerprint: this.opts.cert.fingerprint, localToken };
    log('backend', `started (${this.opts.mode}) on port ${actualPort}`);
    this.emit({ type: 'started' });

    child.once('exit', (code) => {
      out.end();
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      log('backend', `exited unexpectedly with code ${code}`);
      this.emit({ type: 'exited', detail: String(code) });
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => t > now - 120_000), now];
      if (this.crashes.length >= 5) {
        this.emit({ type: 'failed', detail: 'The pharmacy backend crashed 5 times in 2 minutes and was not restarted. See logs/backend.log.' });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
      this.emit({ type: 'restarting', detail: `${delay}` });
      setTimeout(() => { if (!this.stopping) this.start().catch((e) => this.emit({ type: 'failed', detail: e.message })); }, delay);
    });
    return this.info;
  }

  /** Graceful stop: the backend closes its HTTP server and the database (WAL checkpoint). */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve(); }, 8000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      child.postMessage({ type: 'shutdown' });
    });
    this.child = null;
  }
}
