/**
 * The per-installation TLS certificate of a standalone/host computer.
 * cert.pem is public; the private key is stored encrypted with safeStorage (DPAPI on Windows)
 * as key.enc, or as key.pem with owner-only permissions where encryption is unavailable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCertificate, certificateFingerprint } from '../server/lan/tls';
import { localIPv4Addresses } from '../server/config';
import { paths, protect, unprotect, log } from './store';

export interface LocalCert { cert: string; key: string; fingerprint: string }

export async function ensureLocalCertificate(): Promise<LocalCert> {
  const dir = paths.certs();
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'cert.pem');
  const encFile = path.join(dir, 'key.enc');
  const plainFile = path.join(dir, 'key.pem');
  if (fs.existsSync(certFile) && (fs.existsSync(encFile) || fs.existsSync(plainFile))) {
    const cert = fs.readFileSync(certFile, 'utf8');
    const key = fs.existsSync(encFile) ? await unprotect({ enc: fs.readFileSync(encFile, 'utf8') }) : fs.readFileSync(plainFile, 'utf8');
    if (key) return { cert, key, fingerprint: certificateFingerprint(cert) };
    log('tls', 'stored private key could not be decrypted (different Windows account or machine?); generating a new certificate - LAN clients must re-pair');
  }
  return renewLocalCertificate();
}

export async function renewLocalCertificate(): Promise<LocalCert> {
  const dir = paths.certs();
  const c = generateCertificate({ commonName: os.hostname(), hostnames: [os.hostname()], ips: localIPv4Addresses() });
  for (const f of ['cert.pem', 'key.enc', 'key.pem']) fs.rmSync(path.join(dir, f), { force: true });
  const p = await protect(c.keyPem);
  if (p.enc) fs.writeFileSync(path.join(dir, 'key.enc'), p.enc, { mode: 0o600 });
  else fs.writeFileSync(path.join(dir, 'key.pem'), c.keyPem, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'cert.pem'), c.certPem);
  log('tls', `new certificate generated, fingerprint ${c.fingerprint.slice(0, 16)}..., key ${p.enc ? 'encrypted (safeStorage)' : 'stored with owner-only permissions (safeStorage unavailable)'}`);
  return { cert: c.certPem, key: c.keyPem, fingerprint: c.fingerprint };
}
