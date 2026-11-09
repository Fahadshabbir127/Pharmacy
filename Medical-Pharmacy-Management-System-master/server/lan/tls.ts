/**
 * Per-installation TLS certificate (self-signed). Trust is NOT based on a CA or the
 * host name: clients pin the SHA-256 fingerprint they verified during pairing, so a
 * DHCP address change does not break trust and a different certificate is always refused.
 */
import crypto from 'node:crypto';
import forge from 'node-forge';

export interface TlsMaterial {
  certPem: string;
  keyPem: string;
  fingerprint: string; // sha256 of the DER certificate, lowercase hex
  notAfter: string;
}

/** SHA-256 over the DER encoding, lowercase hex without separators. */
export function certificateFingerprint(certPemOrDer: string | Buffer): string {
  const der = Buffer.isBuffer(certPemOrDer) ? certPemOrDer : Buffer.from(new crypto.X509Certificate(certPemOrDer).raw);
  return crypto.createHash('sha256').update(der).digest('hex');
}

/** Short, human-comparable form shown on host and client screens (e.g. "3F2A-91C0-...-7B1D"). */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 20).toUpperCase().match(/.{1,4}/g)!.join('-');
}

export function generateCertificate(opts: { commonName: string; hostnames?: string[]; ips?: string[]; validDays?: number }): TlsMaterial {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getTime() + (opts.validDays ?? 5 * 365) * 86_400_000);
  const attrs = [{ name: 'commonName', value: opts.commonName }, { name: 'organizationName', value: 'BrainTech Pharmacy AI (local installation)' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const altNames = [
    ...['localhost', ...(opts.hostnames ?? [])].map((value) => ({ type: 2, value })),
    ...['127.0.0.1', ...(opts.ips ?? [])].map((ip) => ({ type: 7, ip })),
  ];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return {
    certPem,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: certificateFingerprint(certPem),
    notAfter: cert.validity.notAfter.toISOString(),
  };
}
