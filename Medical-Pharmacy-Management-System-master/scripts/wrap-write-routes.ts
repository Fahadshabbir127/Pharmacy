/**
 * One-off, reviewable codemod: wrap every synchronous Express route handler in
 * server.ts that writes to the database (db.run / db.exec, or a call to a
 * function that does) with tx(...), making the whole request one transaction.
 *
 * Usage: npx tsx scripts/wrap-write-routes.ts [--dry]
 * Prints every route it wraps or skips (and why).
 */
import fs from 'node:fs';
import ts from 'typescript';

const FILE = 'server.ts';
const dry = process.argv.includes('--dry');
const text = fs.readFileSync(FILE, 'utf8');
const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.ES2022, true);

const isDbWrite = (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === 'db' && ['run', 'exec'].includes(n.expression.name.text);

// 1. named functions that write (fixed point over calls)
const fnBodies = new Map<string, ts.Node>();
(function collect(n: ts.Node) {
  if (ts.isFunctionDeclaration(n) && n.name && n.body) fnBodies.set(n.name.text, n.body);
  ts.forEachChild(n, collect);
})(sf);
const writers = new Set<string>();
function writes(n: ts.Node): boolean {
  let found = false;
  (function walk(x: ts.Node) {
    if (found) return;
    if (isDbWrite(x)) { found = true; return; }
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && writers.has(x.expression.text)) { found = true; return; }
    ts.forEachChild(x, walk);
  })(n);
  return found;
}
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, body] of fnBodies) {
    if (name === 'initDatabase' || writers.has(name)) continue;
    if (writes(body)) { writers.add(name); changed = true; }
  }
}

// 2. routes
type Edit = { start: number; end: number };
const edits: Edit[] = [];
const report: string[] = [];
(function visit(n: ts.Node) {
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'app' && ['get', 'post', 'put', 'delete'].includes(n.expression.name.text) &&
      n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0])) {
    const route = `${n.expression.name.text.toUpperCase()} ${(n.arguments[0] as ts.StringLiteral).text}`;
    const handler = n.arguments[n.arguments.length - 1];
    if (!(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
      report.push(`skip  ${route}: handler is not an inline function`);
    } else if (handler.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      report.push(`skip  ${route}: async handler${writes(handler) ? ' (WRITES - handled manually)' : ''}`);
    } else if (!writes(handler)) {
      report.push(`read  ${route}`);
    } else {
      edits.push({ start: handler.getStart(sf), end: handler.getEnd() });
      report.push(`wrap  ${route}`);
    }
  }
  ts.forEachChild(n, visit);
})(sf);

console.log(`writer functions: ${[...writers].join(', ') || '(none)'}`);
console.log(report.join('\n'));
console.log(`\n${edits.length} routes to wrap`);

if (!dry) {
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + 'tx(' + out.slice(e.start, e.end) + ')' + out.slice(e.end);
  }
  fs.writeFileSync(FILE, out);
  console.log('server.ts updated');
}
