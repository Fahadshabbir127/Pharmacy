/**
 * Per-installation JWT signing secret (C8).
 * The original app fell back to a secret published in its source code, so anyone could
 * forge tokens. Now: JWT_SECRET from the environment if set, otherwise a random 64-byte
 * secret stored in the data directory (created once, owner-only file permissions).
 * Changing the secret invalidates existing sessions: users simply sign in again.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadOrCreateJwtSecret(dataDir: string): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const file = path.join(dataDir, 'jwt.secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(file)) {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 64) return s;
  }
  const secret = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
