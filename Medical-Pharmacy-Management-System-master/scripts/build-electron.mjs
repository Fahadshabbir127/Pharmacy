/**
 * Builds the desktop runtime into dist-electron/:
 *   main.cjs     Electron main process
 *   preload.cjs  sandboxed preload (window.braintech)
 *   server.cjs   Express backend, run by Electron's utilityProcess (no separate Node.js needed)
 *   ui/          setup wizard and connection settings pages
 * The React UI itself is built by `vite build` into dist/.
 * Only `electron` and the native `better-sqlite3` (Node-API prebuilds) stay external.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-electron');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ESM dependencies (e.g. node-cron 4) read import.meta.url; in a CommonJS bundle it must be derived from __filename.
const importMetaShim = {
  define: { 'import.meta.url': '__bt_import_meta_url' },
  banner: { js: "const __bt_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
};
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, logLevel: 'info', legalComments: 'none', ...importMetaShim };

await build({ ...common, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(out, 'main.cjs'), external: ['electron', 'better-sqlite3'] });
// the sandboxed preload may only require 'electron': no shim/banner there
await build({ ...common, define: undefined, banner: undefined, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(out, 'preload.cjs'), external: ['electron'], sourcemap: false });
await build({ ...common, entryPoints: [path.join(root, 'server.ts')], outfile: path.join(out, 'server.cjs'), external: ['better-sqlite3', 'vite'] });

fs.cpSync(path.join(root, 'electron/ui'), path.join(out, 'ui'), { recursive: true });
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.warn('warning: dist/index.html is missing - run `npm run build:web` first');
}
console.log('desktop runtime built in dist-electron/');
