/**
 * LAN discovery over UDP (port 3748). A convenience only: answers are UNTRUSTED until the
 * client pairs (pairing verifies the code and pins the certificate). Manual IP entry always
 * works, because many routers block broadcast/multicast between Wi-Fi clients.
 *
 *   client -> broadcast  {"magic":"BRAINTECH_DISCOVER","v":1,"nonce":"..."}
 *   host   -> client     {"magic":"BRAINTECH_HERE","v":1,"nonce":"...","hostName","port","fingerprintShort","appVersion"}
 * The host answers only requests that come from a private-LAN address.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { isPrivateLan } from '../config';

export const DISCOVERY_PORT = 3748;

export interface HostAnnouncement { hostName: string; port: number; fingerprintShort: string; appVersion: string }
export interface DiscoveredHost extends HostAnnouncement { address: string }

export function startDiscoveryResponder(info: () => HostAnnouncement, opts: { port?: number; bind?: string } = {}): Promise<{ close: () => void; port: number }> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      if (!isPrivateLan(rinfo.address) || msg.length > 512) return;
      let req: any;
      try { req = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (req?.magic !== 'BRAINTECH_DISCOVER' || req.v !== 1 || typeof req.nonce !== 'string' || req.nonce.length > 64) return;
      const answer = Buffer.from(JSON.stringify({ magic: 'BRAINTECH_HERE', v: 1, nonce: req.nonce, ...info() }));
      sock.send(answer, rinfo.port, rinfo.address);
    });
    sock.once('error', reject);
    sock.bind(opts.port ?? DISCOVERY_PORT, opts.bind ?? '0.0.0.0', () => {
      sock.removeListener('error', reject);
      sock.on('error', () => { /* keep serving; a single bad packet must not stop discovery */ });
      resolve({ close: () => sock.close(), port: sock.address().port });
    });
  });
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => (b & mask[k]) | (~mask[k] & 255)).join('.'));
    }
  }
  return [...out];
}

/** Ask the network for hosts; resolves after timeoutMs with every distinct answer. */
export function discoverHosts(opts: { timeoutMs?: number; targets?: string[]; port?: number } = {}): Promise<DiscoveredHost[]> {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(12).toString('hex');
    const found = new Map<string, DiscoveredHost>();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const a = JSON.parse(msg.toString('utf8'));
        if (a?.magic === 'BRAINTECH_HERE' && a.nonce === nonce && Number.isInteger(a.port)) {
          found.set(`${rinfo.address}:${a.port}`, {
            address: rinfo.address, port: a.port, hostName: String(a.hostName).slice(0, 80),
            fingerprintShort: String(a.fingerprintShort).slice(0, 40), appVersion: String(a.appVersion).slice(0, 20),
          });
        }
      } catch { /* ignore junk */ }
    });
    sock.on('error', () => { /* e.g. broadcast not permitted: return what we have */ });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      const payload = Buffer.from(JSON.stringify({ magic: 'BRAINTECH_DISCOVER', v: 1, nonce }));
      for (const t of opts.targets ?? broadcastAddresses()) sock.send(payload, opts.port ?? DISCOVERY_PORT, t, () => { /* ignore send errors */ });
    });
    setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); }, opts.timeoutMs ?? 1500);
  });
}
