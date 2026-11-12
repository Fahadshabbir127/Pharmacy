/**
 * Runtime configuration shared by the backend and (for the pure helpers) the Electron main process.
 */
import net from 'node:net';
import os from 'node:os';

/** Bumped whenever the HTTP API changes incompatibly; host and clients must match. */
export const API_PROTOCOL = 3; // 3 = Phase 7: server-calculated sale totals (409 PRICE_MISMATCH, discount authorization). 2 = Phase 6 batches

export const APP_VERSION = process.env.PHARMACY_APP_VERSION || '1.0.0';

export type ServerMode = 'legacy' | 'standalone' | 'host';

export function serverMode(): ServerMode {
  const m = process.env.PHARMACY_MODE;
  return m === 'standalone' || m === 'host' ? m : 'legacy';
}

/** Strip the IPv4-mapped IPv6 prefix (::ffff:192.168.1.5 -> 192.168.1.5). */
export function normalizeAddress(addr: string | undefined | null): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopback(addr: string | undefined | null): boolean {
  const a = normalizeAddress(addr);
  return a === '::1' || a === 'localhost' || /^127\./.test(a);
}

/** Private LAN ranges a pharmacy network uses (RFC 1918, IPv4 link-local, IPv6 ULA / link-local). */
export function isPrivateLan(addr: string | undefined | null): boolean {
  const a = normalizeAddress(addr);
  if (isLoopback(a)) return true;
  if (net.isIPv4(a)) {
    const [p1, p2] = a.split('.').map(Number);
    return p1 === 10 || (p1 === 172 && p2 >= 16 && p2 <= 31) || (p1 === 192 && p2 === 168) || (p1 === 169 && p2 === 254);
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80:');
  }
  return false;
}

/** Non-internal IPv4 addresses of this computer (shown on the host screen, used in the certificate). */
export function localIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
