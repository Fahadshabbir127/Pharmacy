/**
 * Static audit of every database call site in server.ts.
 *
 * For each call to db.run / db.exec / db.all / db.get / queryAll / queryOne / db.prepare
 * it reports: line, method, whether the SQL is static, placeholder count vs. parameter
 * count, double-quoted string literals (rejected by better-sqlite3, accepted by sql.js),
 * and multiple statements in one string.
 *
 * Usage: npx tsx scripts/audit-db-callsites.ts [file] [--json]
 * Exit code 1 if any definite problem is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const file = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'server.ts');
const asJson = process.argv.includes('--json');
const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);

const DB_METHODS = new Set(['run', 'exec', 'all', 'get', 'prepare', 'transaction']);
const HELPERS = new Set(['queryAll', 'queryOne']);

export interface CallSite {
  line: number;
  method: string;
  sqlKind: 'static' | 'dynamic' | 'variable';
  sql: string;
  placeholders: number | null;
  params: number | 'dynamic' | 'none';
  doubleQuotedLiterals: string[];
  statements: number | null;
  problems: string[];
}

/** Scan SQL text, skipping single-quoted literals and comments. */
function scanSql(sql: string) {
  let placeholders = 0;
  const dq: string[] = [];
  let statements = 0;
  let sawToken = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") { // single-quoted literal ('' escapes)
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) { if (sql[i] === "'" ) i++; i++; }
      sawToken = true;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const word = sql.slice(i + 1, end === -1 ? undefined : end);
      // "${...}" substitutions are table names from sqlite_master; every other word is checked against the schema later
      if (!word.includes('${')) dq.push(word);
      i = end === -1 ? sql.length : end;
      sawToken = true;
      continue;
    }
    if (c === '?') placeholders++;
    if (c === ';') { if (sawToken) statements++; sawToken = false; continue; }
    if (!/\s/.test(c)) sawToken = true;
  }
  if (sawToken) statements++;
  return { placeholders, dq, statements };
}

/**
 * Double-quoted words are only allowed when they are real table/column names.
 * The schema is read from a legacy fixture database (npm run fixtures:legacy).
 */
const KNOWN_IDENTIFIERS = new Set<string>();
{
  const schemaDb = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tests', '.fixtures', 'legacy', 'after-restart.sqlite');
  if (fs.existsSync(schemaDb)) {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(schemaDb, { readonly: true, fileMustExist: true });
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
      KNOWN_IDENTIFIERS.add(name);
      for (const c of db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]) KNOWN_IDENTIFIERS.add(c.name);
    }
    db.close();
  } else {
    console.error('note: legacy fixtures missing; every double-quoted word will be reported');
  }
}

function sqlText(node: ts.Expression): { kind: CallSite['sqlKind']; text: string } {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'static', text: node.text };
  if (ts.isTemplateExpression(node)) {
    let t = node.head.text;
    for (const span of node.templateSpans) t += '${' + span.expression.getText() + '}' + span.literal.text;
    return { kind: 'dynamic', text: t };
  }
  return { kind: 'variable', text: node.getText() };
}

const sites: CallSite[] = [];

function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    let method: string | null = null;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'db' && DB_METHODS.has(callee.name.text)) {
      method = `db.${callee.name.text}`;
    } else if (ts.isIdentifier(callee) && HELPERS.has(callee.text)) {
      method = callee.text;
    }
    if (method && method !== 'db.transaction' && node.arguments.length > 0) {
      const { kind, text } = sqlText(node.arguments[0]);
      const scan = kind === 'variable' ? null : scanSql(text);
      const p = node.arguments[1];
      const params: CallSite['params'] = !p ? 'none' : ts.isArrayLiteralExpression(p) && !p.elements.some(ts.isSpreadElement) ? p.elements.length : 'dynamic';
      const problems: string[] = [];
      if (scan) {
        const dq = scan.dq.filter((w) => !KNOWN_IDENTIFIERS.has(w));
        if (dq.length) problems.push(`double-quoted literal(s): ${dq.map((w) => `"${w}"`).join(', ')}`);
        if (scan.statements > 1 && method !== 'db.exec') problems.push(`${scan.statements} statements in one ${method} call`);
        const expected = params === 'none' ? 0 : params;
        if (kind === 'static' && typeof expected === 'number' && expected !== scan.placeholders) {
          problems.push(`placeholder/param mismatch: ${scan.placeholders} '?' vs ${expected} params`);
        }
      }
      sites.push({
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        method,
        sqlKind: kind,
        sql: text.replace(/\s+/g, ' ').trim().slice(0, 140),
        placeholders: scan ? scan.placeholders : null,
        params,
        doubleQuotedLiterals: scan ? scan.dq : [],
        statements: scan ? scan.statements : null,
        problems,
      });
    }
  }
  ts.forEachChild(node, visit);
}
visit(src);

const problems = sites.filter((s) => s.problems.length);
if (asJson) {
  console.log(JSON.stringify({ file: path.basename(file), total: sites.length, problems: problems.length, sites }, null, 2));
} else {
  const by = (m: string) => sites.filter((s) => s.method === m).length;
  console.log(`${path.basename(file)}: ${sites.length} DB call sites (${[...new Set(sites.map((s) => s.method))].map((m) => `${m}=${by(m)}`).join(', ')})`);
  console.log(`dynamic SQL (template with substitutions): ${sites.filter((s) => s.sqlKind === 'dynamic').length}; SQL from variables: ${sites.filter((s) => s.sqlKind === 'variable').length}`);
  for (const s of problems) console.log(`  L${s.line} ${s.method}: ${s.problems.join('; ')}\n      ${s.sql}`);
  console.log(problems.length ? `${problems.length} call site(s) need changes` : 'no static problems found');
}
process.exitCode = problems.length ? 1 : 0;
