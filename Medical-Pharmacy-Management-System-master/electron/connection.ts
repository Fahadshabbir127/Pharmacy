/**
 * The app:// protocol and the pinned backend connection.
 *
 * Every page the window shows is a file bundled with the installed app, served from
 * app://braintech/. The renderer never loads pages from a host computer, so remote content can
 * never reach the preload API. API calls (app://braintech/api/...) are forwarded here, over HTTPS
 * pinned to the backend's certificate fingerprint, to the local backend or the paired host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BrowserWindow, protocol } from 'electron';
import { pinnedRequest, pinnedJson, PinMismatchError } from '../server/lan/pinnedClient';
import { API_PROTOCOL } from '../server/config';
import { log } from './store';

export const ORIGIN = 'app://braintech';

export interface Target { base: string; fingerprint: string; clientToken?: string; isLocal: boolean }

export type ConnectionStatus = 'NOT_CONFIGURED' | 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'CERT_MISMATCH' | 'VERSION_MISMATCH' | 'BACKEND_RESTARTING' | 'BACKEND_FAILED';
export interface ConnectionState { status: ConnectionStatus; detail?: string; since: string; hostName?: string; isLocal: boolean; serverVersion?: string }

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host', 'content-length']);

export class Connection {
  target: Target | null = null;
  state: ConnectionState = { status: 'NOT_CONFIGURED', since: new Date().toISOString(), isLocal: false };
  inFlightSales = 0;
  private timer: NodeJS.Timeout | null = null;
  private misses = 0;

  constructor(private readonly roots: { renderer: string; ui: string }) {}

  setTarget(t: Target | null, hostName?: string) {
    this.target = t;
    this.misses = 0;
    this.setState(t ? { status: 'CONNECTED', hostName, isLocal: t.isLocal } : { status: 'NOT_CONFIGURED', isLocal: false });
    if (t) void this.heartbeat();
  }

  setState(s: Omit<ConnectionState, 'since'>) {
    const changed = s.status !== this.state.status || s.detail !== this.state.detail;
    this.state = { ...this.state, ...s, since: changed ? new Date().toISOString() : this.state.since };
    if (changed) {
      log('connection', `${s.status}${s.detail ? `: ${s.detail}` : ''}`);
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('braintech:connection-state', this.state);
    }
  }

  startMonitoring(intervalMs = 5000) {
    this.stopMonitoring();
    this.timer = setInterval(() => void this.heartbeat(), intervalMs);
  }
  stopMonitoring() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private headers(): Record<string, string> {
    return this.target?.clientToken ? { 'x-braintech-client': this.target.clientToken } : {};
  }

  async heartbeat(): Promise<void> {
    const t = this.target;
    if (!t) return;
    if (this.state.status === 'BACKEND_RESTARTING' || this.state.status === 'BACKEND_FAILED') return;
    try {
      const r = await pinnedJson(`${t.base}/api/health`, t.fingerprint, { headers: this.headers(), timeoutMs: 3000 });
      if (r.status === 200 && r.body?.apiProtocol !== API_PROTOCOL) {
        this.setState({ status: 'VERSION_MISMATCH', detail: `server version ${r.body?.appVersion} (protocol ${r.body?.apiProtocol}); this computer uses protocol ${API_PROTOCOL}. Install the same version on all computers.`, isLocal: t.isLocal, serverVersion: r.body?.appVersion });
        return;
      }
      this.misses = 0;
      this.setState({ status: r.status === 200 ? 'CONNECTED' : 'DEGRADED', detail: r.status === 200 ? undefined : `health ${r.status}`, isLocal: t.isLocal, serverVersion: r.body?.appVersion });
    } catch (e: any) {
      this.onError(e);
    }
  }

  private onError(e: any) {
    const t = this.target;
    if (e instanceof PinMismatchError) {
      this.setState({ status: 'CERT_MISMATCH', detail: e.message, isLocal: !!t?.isLocal });
      return;
    }
    this.misses++;
    this.setState({ status: this.misses >= 2 ? 'DISCONNECTED' : 'DEGRADED', detail: e?.code || e?.message, isLocal: !!t?.isLocal });
  }

  /** app:// request handler. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host !== 'braintech') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/api/')) return this.proxy(request, url);
    if (url.pathname.startsWith('/__app/')) return this.serveFile(this.roots.ui, url.pathname.slice('/__app/'.length), false);
    return this.serveFile(this.roots.renderer, url.pathname.slice(1), true);
  }

  private serveFile(root: string, rel: string, spaFallback: boolean): Response {
    const safeRel = decodeURIComponent(rel || 'index.html');
    let file = path.resolve(root, safeRel);
    if (!file.startsWith(path.resolve(root) + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (!spaFallback || path.extname(safeRel)) return new Response('Not found', { status: 404 });
      file = path.join(root, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    if (ext === '.html') { headers['Content-Security-Policy'] = CSP; headers['Cache-Control'] = 'no-cache'; }
    return new Response(fs.readFileSync(file), { status: 200, headers });
  }

  private async proxy(request: Request, url: URL): Promise<Response> {
    const t = this.target;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!t) return json(503, { error: 'This computer is not connected to a pharmacy server yet.', code: 'NOT_CONFIGURED' });
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'origin' && k.toLowerCase() !== 'x-braintech-client') headers[k] = v; });
    Object.assign(headers, this.headers());
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? null : Buffer.from(await request.arrayBuffer());
    if (body) headers['content-length'] = String(body.length);
    const isSale = method === 'POST' && url.pathname === '/api/sales';
    if (isSale) this.inFlightSales++;
    try {
      const res = await pinnedRequest(`${t.base}${url.pathname}${url.search}`, t.fingerprint, { method, headers, body, timeoutMs: 30_000 });
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
        for (const item of Array.isArray(v) ? v : [v]) out.append(k, item);
      }
      if (this.state.status !== 'CONNECTED') void this.heartbeat();
      const stream = Readable.toWeb(res) as unknown as ReadableStream;
      return new Response(method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 ? null : stream, { status: res.statusCode || 502, headers: out });
    } catch (e: any) {
      this.onError(e);
      if (e instanceof PinMismatchError) return json(495, { error: e.message, code: 'CERT_MISMATCH' });
      return json(503, {
        error: t.isLocal ? 'The pharmacy backend on this computer is not responding.' : 'The pharmacy server computer cannot be reached. Check that it is switched on and on the same network.',
        code: 'HOST_UNREACHABLE',
        // the request may or may not have reached the server; sales must be confirmed with their transaction id
        outcome: 'UNKNOWN',
      });
    } finally {
      if (isSale) this.inFlightSales--;
    }
  }
}

export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
}
