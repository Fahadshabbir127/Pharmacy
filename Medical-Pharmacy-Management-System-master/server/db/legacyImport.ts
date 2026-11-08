/**
 * Copy-only import of a database file from the old application.
 *
 * The source is opened READ-ONLY, checked, and copied with SQLite's backup API
 * into the new data directory. The source file is never written, moved or
 * renamed. An existing target is never overwritten. The copy is then opened
 * through openDatabase(), which runs migrations with their own verified backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DbAdapter } from './adapter';

export class LegacyImportError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

export interface LegacyImportResult {
  source: string;
  sourceSha256: string;
  target: string;
  rowCounts: Record<string, number>;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function importLegacyDatabase(source: string, target: string): Promise<LegacyImportResult> {
  const src = path.resolve(source);
  const dest = path.resolve(target);
  if (!fs.existsSync(src)) throw new LegacyImportError(`Source database not found: ${src}`);
  if (src === dest) throw new LegacyImportError('Source and target are the same file.');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    throw new LegacyImportError(`A database already exists at ${dest}; it will not be overwritten.`, { target: dest });
  }
  const before = sha256(src);

  let ro: DbAdapter;
  try {
    ro = DbAdapter.open(src, { readonly: true });
  } catch (e: any) {
    throw new LegacyImportError(`Cannot open the source database read-only: ${e.message}`);
  }
  let sourceCounts: Record<string, number>;
  const tmp = `${dest}.importing`;
  try {
    let problems: string[];
    try {
      problems = ro.integrityCheck();
    } catch (e: any) {
      problems = [e.message];
    }
    if (problems.length) throw new LegacyImportError('The source database failed its integrity check; nothing was imported.', { problems });
    sourceCounts = ro.rowCounts();
    if (!('users' in sourceCounts) || !('products' in sourceCounts)) {
      throw new LegacyImportError('The source file is a SQLite database but not a pharmacy database (no users/products tables).');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    await ro.backupTo(tmp);
  } finally {
    ro.close();
  }

  const copy = DbAdapter.open(tmp, { readonly: true });
  try {
    const problems = copy.integrityCheck();
    const counts = copy.rowCounts();
    if (problems.length || JSON.stringify(counts) !== JSON.stringify(sourceCounts)) {
      throw new LegacyImportError('The imported copy does not match the source; nothing was imported.', { problems, counts, sourceCounts });
    }
  } catch (e) {
    copy.close();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  copy.close();
  fs.renameSync(tmp, dest);

  if (sha256(src) !== before) {
    // Should be impossible (read-only handle). Report loudly rather than hide it.
    throw new LegacyImportError('The source file changed during import. Keep the source; the copy is at the target path.', { source: src, target: dest });
  }
  return { source: src, sourceSha256: before, target: dest, rowCounts: sourceCounts };
}
