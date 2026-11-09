/**
 * LAN guard for /api.
 *
 *  - loopback requests: allowed (this computer's own app; standalone mode only listens on loopback)
 *  - any other request in non-host modes: refused
 *  - host mode: only private-LAN addresses, and (except /api/health and /api/pair/*) only
 *    paired clients presenting a valid, unrevoked X-BrainTech-Client token
 */
import type { Request, Response, NextFunction } from 'express';
import type { DbAdapter } from '../db/adapter';
import { isLoopback, isPrivateLan, normalizeAddress, ServerMode } from '../config';
import { hashToken } from './pairing';

export const CLIENT_HEADER = 'x-braintech-client';
const OPEN_PATHS = [/^\/api\/health$/, /^\/api\/pair\/(start|complete)$/];

export function lanGuard(opts: { mode: () => ServerMode; db: () => DbAdapter }) {
  const lastSeenWrite = new Map<number, number>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeAddress(req.socket.remoteAddress);
    if (isLoopback(ip)) return next();
    const mode = opts.mode();
    if (mode === 'legacy') return next(); // original behaviour for tests/dev; the desktop app never runs in this mode
    if (mode !== 'host') return res.status(403).json({ error: 'This computer does not accept network connections (standalone mode).' });
    if (!isPrivateLan(ip)) return res.status(403).json({ error: 'Only computers on the local network may connect.' });
    if (OPEN_PATHS.some((r) => r.test(req.path))) return next();
    const token = req.get(CLIENT_HEADER);
    const client = token
      ? opts.db().get<{ id: number; revoked_at: string | null }>('SELECT id, revoked_at FROM paired_clients WHERE token_hash = ?', [hashToken(token)])
      : undefined;
    if (!client || client.revoked_at) {
      return res.status(401).json({ error: 'This computer is not paired with the pharmacy server (or its pairing was revoked). Pair it again from the connection settings.', code: 'NOT_PAIRED' });
    }
    const now = Date.now();
    if ((lastSeenWrite.get(client.id) ?? 0) < now - 15_000) {
      lastSeenWrite.set(client.id, now);
      opts.db().run('UPDATE paired_clients SET last_seen_at = ?, last_ip = ? WHERE id = ?', [new Date(now).toISOString(), ip, client.id]);
    }
    (req as any).pairedClientId = client.id;
    next();
  };
}
