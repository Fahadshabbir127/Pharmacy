/**
 * Phase 9A.3 test helper (child process): keeps committing rows to a live database through its OWN connection while
 * a backup runs (as the server would). argv[2] = database path. Sends {type:'ready', count} after the first commits,
 * {type:'count', count} on {type:'count'}, and stops with {type:'stopped', count} on {type:'stop'}.
 */
import Database from 'better-sqlite3';

const db = new Database(process.argv[2]);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
const insert = db.prepare("INSERT INTO products (name, stock) VALUES (?, 1)");
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
let n = 0;
let ready = false;
const timer = setInterval(() => {
  db.transaction(() => { for (let i = 0; i < 20; i++) insert.run(`writer-${n++}`); })();
  if (!ready && n >= 100) { ready = true; process.send?.({ type: 'ready', count: count() }); }
}, 2);
process.on('message', (m: any) => {
  if (m?.type === 'count') process.send?.({ type: 'count', count: count() });
  if (m?.type === 'stop') {
    clearInterval(timer);
    const c = count();
    db.close();
    process.send?.({ type: 'stopped', count: c });
    setTimeout(() => process.exit(0), 10);
  }
});
