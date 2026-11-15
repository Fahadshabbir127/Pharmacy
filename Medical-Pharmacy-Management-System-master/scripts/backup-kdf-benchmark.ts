/**
 * Phase 9A.1: scrypt benchmark for choosing the .btbackup production default (run on the pharmacy's Windows PC).
 *
 *   npx tsx scripts/backup-kdf-benchmark.ts            (Windows PowerShell: npx.cmd tsx scripts/backup-kdf-benchmark.ts)
 *   npx tsx scripts/backup-kdf-benchmark.ts --runs 5   (more runs per setting; default 3)
 *   npx tsx scripts/backup-kdf-benchmark.ts --json     (machine-readable output only)
 *
 * For each candidate in KDF_CANDIDATES it derives the backup keys with a random throw-away password and salt
 * (nothing is printed except timings and memory), and reports the scrypt memory requirement, the time per
 * derivation (min / median / max) and the peak process memory seen. It reads and writes no files and does not touch
 * any database. Close other heavy programs first; the numbers are only meaningful on the machine that will make and
 * restore backups.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { deriveKeys, KDF_CANDIDATES, scryptMemoryBytes, type ScryptParams } from '../server/backup/kdf';

const args = process.argv.slice(2);
const runsArg = args.indexOf('--runs');
const runs = runsArg >= 0 ? Math.max(1, Math.min(20, Number(args[runsArg + 1]) || 3)) : 3;
const json = args.includes('--json');
const MiB = 1024 * 1024;

interface Result { N: string; r: number; p: number; scryptMemoryMiB: number; runs: number; minMs: number; medianMs: number; maxMs: number; peakRssMiB: number }

async function measure(params: ScryptParams): Promise<Result> {
  const times: number[] = [];
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  try {
    for (let i = 0; i < runs; i++) {
      const secret = crypto.randomBytes(18).toString('base64'); // throw-away; never printed
      const salt = crypto.randomBytes(32);
      const t0 = process.hrtime.bigint();
      const keys = await deriveKeys(secret, salt, params);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      keys.wipe();
      peak = Math.max(peak, process.memoryUsage().rss);
    }
  } finally {
    clearInterval(sampler);
  }
  times.sort((a, b) => a - b);
  return {
    N: `2^${Math.log2(params.N)}`, r: params.r, p: params.p,
    scryptMemoryMiB: scryptMemoryBytes(params) / MiB,
    runs, minMs: Math.round(times[0]), medianMs: Math.round(times[Math.floor(times.length / 2)]), maxMs: Math.round(times[times.length - 1]),
    peakRssMiB: Math.round(peak / MiB),
  };
}

async function main() {
  const system = {
    platform: `${os.platform()} ${os.release()} (${os.arch()})`, node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / MiB), freeMemoryMiB: Math.round(os.freemem() / MiB),
  };
  if (!json) {
    console.log('BrainTech backup KDF benchmark (scrypt, Node.js built-in)');
    for (const [k, v] of Object.entries(system)) console.log(`  ${k}: ${v}`);
    console.log(`  runs per setting: ${runs}\n`);
  }
  const results: Result[] = [];
  for (const c of KDF_CANDIDATES) {
    if (!json) process.stdout.write(`  measuring N=2^${Math.log2(c.N)}, r=${c.r}, p=${c.p} ... `);
    const r = await measure(c);
    results.push(r);
    if (!json) console.log(`${r.medianMs} ms`);
  }
  if (json) { console.log(JSON.stringify({ system, results }, null, 2)); return; }
  console.log('');
  console.table(results);
  console.log('Each backup and each restore runs this once. Send this output for review; no default is chosen automatically.');
}

main().catch((e) => { console.error(`benchmark failed: ${e?.code ?? e?.name ?? 'error'}`); process.exitCode = 1; });
