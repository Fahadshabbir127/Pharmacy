/**
 * Where data lives and how the desktop configuration is stored.
 *
 * Windows: %PROGRAMDATA%\BrainTechPharmacyAI  (machine-wide: data belongs to the pharmacy computer,
 *          not to one Windows user; the installer grants the Users group Modify rights).
 *          Falls back to %LOCALAPPDATA%\BrainTechPharmacyAI when ProgramData is not writable.
 * Others / tests: BRAINTECH_DATA_ROOT, or <userData>/BrainTechPharmacyAI.
 * The installation directory is never used for data.
 *
 * Secrets in config.json (the LAN client token) and the TLS private key are encrypted with
 * Electron safeStorage (DPAPI on Windows) when available.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

export type Mode = 'standalone' | 'host' | 'client';

export interface ClientLink {
  address: string;
  port: number;
  fingerprint: string;
  clientId: string;
  hostName: string;
  clientTokenEnc?: string; // safeStorage-encrypted, base64
  clientTokenPlain?: string; // only when safeStorage is unavailable (documented)
}

export interface DesktopConfig {
  version: 1;
  mode: Mode | null;
  hostPort: number;
  computerName: string;
  client?: ClientLink;
}

const DEFAULT_CONFIG: DesktopConfig = { version: 1, mode: null, hostPort: 3747, computerName: '' };

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

let cachedRoot: string | null = null;
export function dataRoot(): string {
  if (cachedRoot) return cachedRoot;
  const candidates: string[] = [];
  if (process.env.BRAINTECH_DATA_ROOT) candidates.push(path.resolve(process.env.BRAINTECH_DATA_ROOT));
  if (process.platform === 'win32') {
    if (process.env.PROGRAMDATA) candidates.push(path.join(process.env.PROGRAMDATA, 'BrainTechPharmacyAI'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'BrainTechPharmacyAI'));
  }
  candidates.push(path.join(app.getPath('userData'), 'BrainTechPharmacyAI'));
  const exe = path.dirname(app.getPath('exe'));
  for (const c of candidates) {
    if (c.startsWith(exe + path.sep)) continue; // never inside the installation directory
    if (writable(c)) return (cachedRoot = c);
  }
  throw new Error(`No writable data folder found (tried: ${candidates.join(', ')})`);
}

export const paths = {
  data: () => path.join(dataRoot(), 'data'),
  db: () => path.join(dataRoot(), 'data', 'pharmacy.sqlite'),
  backups: () => path.join(dataRoot(), 'data', 'backups'),
  certs: () => path.join(dataRoot(), 'certs'),
  logs: () => path.join(dataRoot(), 'logs'),
  config: () => path.join(dataRoot(), 'config.json'),
};

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, version: 1 };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  fs.mkdirSync(path.dirname(paths.config()), { recursive: true });
  const tmp = `${paths.config()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.config());
}

export async function canEncrypt(): Promise<boolean> {
  try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
}

export async function protect(secret: string): Promise<{ enc?: string; plain?: string }> {
  return (await canEncrypt()) ? { enc: (await safeStorage.encryptStringAsync(secret)).toString('base64') } : { plain: secret };
}

export async function unprotect(p: { enc?: string; plain?: string }): Promise<string | null> {
  if (p.enc) {
    try { return (await safeStorage.decryptStringAsync(Buffer.from(p.enc, 'base64'))).result; } catch { return null; }
  }
  return p.plain ?? null;
}

/** Append-only log with simple size rotation (never logs secrets: callers pass safe messages). */
export function log(category: string, message: string): void {
  try {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const file = path.join(paths.logs(), 'main.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} [${app.getVersion()}] [${category}] ${message}\n`);
  } catch {
    /* logging must never crash the app */
  }
}
