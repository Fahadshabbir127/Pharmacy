/**
 * Foreign-key audit (read-only, works on a temporary COPY).
 *
 * Reports:
 *   1. PRAGMA foreign_key_check  - violations of the relationships declared in the schema
 *   2. undeclared relationships  - tenant_id columns, customer_ledger.sale_id, users.customer_id
 *   3. enforcement impact        - what would start failing if PRAGMA foreign_keys=ON today
 * Nothing is fixed. Usage:
 *   npx tsx scripts/fk-audit.ts <db-file> [more files...] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface FkFinding {
  kind: 'declared' | 'undeclared';
  table: string;
  column: string;
  parent: string;
  orphanRows: number;
  sampleRowids: number[];
}

export interface FkAuditResult {
  file: string;
  integrity: string[];
  findings: FkFinding[];
  declaredForeignKeys: { table: string; column: string; parent: string; parentColumn: string }[];
}

const UNDECLARED: { table: string; column: string; parent: string; parentColumn: string }[] = [
  { table: 'customer_ledger', column: 'sale_id', parent: 'sales_headers', parentColumn: 'id' },
  { table: 'users', column: 'customer_id', parent: 'customers', parentColumn: 'id' },
  ...['users', 'products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers', 'stock_adjustments', 'settings', 'audit_logs', 'email_queue', 'sms_queue']
    .map((t) => ({ table: t, column: 'tenant_id', parent: 'tenants', parentColumn: 'id' })),
];

export function auditDatabase(file: string): FkAuditResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-audit-'));
  const copy = path.join(tmpDir, 'copy.sqlite');
  {
    const src = new Database(file, { readonly: true, fileMustExist: true });
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); // self-contained copy, includes WAL content
    src.close();
  }
  const db = new Database(copy, { readonly: true });
  try {
    const integrity = (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check).filter((m) => m !== 'ok');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);

    const declaredForeignKeys = tables.flatMap((t) =>
      (db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[]).map((f) => ({ table: t, column: f.from, parent: f.table, parentColumn: f.to })),
    );

    const grouped = new Map<string, FkFinding>();
    for (const v of db.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string; fkid: number }[]) {
      const fk = (db.prepare(`PRAGMA foreign_key_list("${v.table}")`).all() as any[]).find((f) => f.id === v.fkid);
      const key = `${v.table}.${fk?.from}->${v.parent}`;
      const g = grouped.get(key) ?? { kind: 'declared' as const, table: v.table, column: fk?.from ?? '?', parent: v.parent, orphanRows: 0, sampleRowids: [] };
      g.orphanRows++;
      if (g.sampleRowids.length < 10) g.sampleRowids.push(v.rowid);
      grouped.set(key, g);
    }

    for (const u of UNDECLARED) {
      if (!tables.includes(u.table) || !cols(u.table).includes(u.column) || !tables.includes(u.parent)) continue;
      const rows = db.prepare(
        `SELECT c.rowid AS rowid FROM "${u.table}" c WHERE c."${u.column}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${u.parent}" p WHERE p."${u.parentColumn}" = c."${u.column}")`,
      ).all() as { rowid: number }[];
      if (rows.length) {
        grouped.set(`${u.table}.${u.column}->${u.parent}`, {
          kind: 'undeclared', table: u.table, column: u.column, parent: u.parent, orphanRows: rows.length, sampleRowids: rows.slice(0, 10).map((r) => r.rowid),
        });
      }
    }
    return { file, integrity, findings: [...grouped.values()], declaredForeignKeys };
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && /fk-audit\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args.splice(jsonIdx, 2)[1] : null;
  const results = args.map(auditDatabase);
  for (const r of results) {
    console.log(`\n${path.basename(r.file)}  integrity: ${r.integrity.length ? r.integrity.join('; ') : 'ok'}`);
    if (!r.findings.length) console.log('  no orphaned references');
    for (const f of r.findings) console.log(`  [${f.kind}] ${f.table}.${f.column} -> ${f.parent}: ${f.orphanRows} orphan row(s) (rowids ${f.sampleRowids.join(', ')})`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
}
