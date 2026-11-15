/**
 * Phase 9A.3: the backup engine and worker work when bundled the way the desktop build bundles them (esbuild, CJS,
 * node22, better-sqlite3 external, the import.meta.url shim), run by PLAIN Node without the TypeScript loader.
 * The engine finds the worker as backup-worker.cjs next to its own bundle. If `npm run build:desktop` has produced
 * dist-electron/backup-worker.cjs, that exact file is exercised too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

const run = promisify(execFile);
const PROJECT = path.resolve(__dirname, '..', '..');
const BUILT_WORKER = path.join(PROJECT, 'dist-electron', 'backup-worker.cjs');
let dir: string;
let dataDir: string;
let dbFile: string;

/** the options scripts/build-electron.mjs uses for its Node bundles */
const common = {
  bundle: true, platform: 'node' as const, format: 'cjs' as const, target: 'node22', logLevel: 'silent' as const, legalComments: 'none' as const,
  define: { 'import.meta.url': '__bt_import_meta_url' },
  banner: { js: "const __bt_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  external: ['better-sqlite3'],
};

beforeAll(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bundle-')));
  await build({ ...common, entryPoints: [path.join(PROJECT, 'server/backup/engine.ts')], outfile: path.join(dir, 'engine.cjs') });
  await build({ ...common, entryPoints: [path.join(PROJECT, 'server/backup/worker.ts')], outfile: path.join(dir, 'backup-worker.cjs') });
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  dbFile = path.join(dataDir, 'pharmacy.sqlite');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1); CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO products (name) VALUES ('a'), ('b');");
  db.close();
}, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** run a script with plain node (no --import tsx); better-sqlite3 resolves from the project's node_modules */
async function plainNode(script: string): Promise<any> {
  const { stdout } = await run(process.execPath, ['-e', script], { env: { ...process.env, NODE_PATH: path.join(PROJECT, 'node_modules'), NODE_OPTIONS: '' }, timeout: 120_000 });
  return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('bundled backup engine and worker', () => {
  it('the bundles contain no TypeScript-loader dependency', () => {
    for (const f of ['engine.cjs', 'backup-worker.cjs']) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text).toContain('better-sqlite3');
      expect(text).not.toMatch(/require\(["']tsx/);
    }
  });

  it('plain Node creates and verifies a backup with the bundled engine; the worker is found as backup-worker.cjs', async () => {
    const script = `
      const e = require(${JSON.stringify(path.join(dir, 'engine.cjs'))});
      (async () => {
        const entry = e.defaultWorkerEntry();
        const r = await e.createBackup({ dataDir: ${JSON.stringify(dataDir)}, dbFile: ${JSON.stringify(dbFile)}, secret: 'Bundle-Pass 1', kind: 'manual', appVersion: '1.0.0', kdf: { N: 32768, r: 8, p: 1 } });
        const v = await e.verifyBackupFile(r.path, 'Bundle-Pass 1');
        console.log(JSON.stringify({ entry, name: r.name, rows: r.rowCounts, verified: v.manifest.plaintextSha256 === r.plaintextSha256, execArgv: process.execArgv.filter((a) => a !== '-e' && !a.includes('createBackup')) }));
      })().catch((err) => { console.log(JSON.stringify({ error: err.code || String(err) })); });`;
    const out = await plainNode(script);
    expect(out.error).toBeUndefined();
    expect(out.entry).toEqual({ file: path.join(dir, 'backup-worker.cjs'), execArgv: [] });
    expect(out.execArgv.some((a: string) => a === '--import' || a.includes('tsx'))).toBe(false); // no TypeScript loader
    expect(out.rows).toEqual({ products: 2, users: 1 });
    expect(out.verified).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'backups', 'encrypted'))).toEqual([out.name]);
  }, 120_000);

  it.skipIf(!fs.existsSync(BUILT_WORKER))('the worker produced by `npm run build:desktop` (dist-electron/backup-worker.cjs) runs a real backup', async () => {
    const script = `
      const e = require(${JSON.stringify(path.join(dir, 'engine.cjs'))});
      e.createBackup({ dataDir: ${JSON.stringify(dataDir)}, dbFile: ${JSON.stringify(dbFile)}, secret: 'Bundle-Pass 1', kind: 'scheduled', appVersion: '1.0.0', kdf: { N: 32768, r: 8, p: 1 },
        workerEntry: { file: ${JSON.stringify(BUILT_WORKER)}, execArgv: [] } })
        .then((r) => console.log(JSON.stringify({ name: r.name, rows: r.rowCounts })), (err) => console.log(JSON.stringify({ error: err.code || String(err) })));`;
    const out = await plainNode(script);
    expect(out.error).toBeUndefined();
    expect(out.name).toMatch(/^scheduled-/);
    expect(out.rows).toEqual({ products: 2, users: 1 });
  }, 120_000);
});
