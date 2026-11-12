/**
 * Synthetic legacy database generator.
 *
 * Every fixture is produced by running the FROZEN ORIGINAL backend
 * (tests/legacy/server.original.ts, sha256 pinned in 06-legacy-fixtures.test.ts)
 * through scripted API flows, so the files have exactly the shape real
 * customer databases created by the old application have.
 *
 * Output: <outDir>/<name>.sqlite + <outDir>/manifest.json
 * Nothing here ever reads or writes a real pharmacy database.
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { startServer, Api, ORIGINAL_SERVER, makeTempDir, cartItem, salePayload } from '../helpers/server';
import { openReadOnly, rowCounts, integrityCheck, foreignKeyViolations, one, all } from '../helpers/db';

export interface FixtureManifestEntry {
  file: string;
  description: string;
  rowCounts: Record<string, number>;
  invariants: { productStockSum: number; customerBalanceSum: number; salesGrandTotalSum: number; ledgerRows: number };
  integrity: string[];
  foreignKeyViolations: { table: string; parent: string; count: number }[];
  nullTenantRows: Record<string, number>;
}

const prodById = async (api: Api, id: number) => (await api.get('/inventory')).body.find((p: any) => p.id === id);

async function summarize(file: string, description: string): Promise<FixtureManifestEntry> {
  const db = await openReadOnly(file);
  const fk = foreignKeyViolations(db);
  const grouped = new Map<string, number>();
  for (const v of fk) {
    const k = `${v.table}->${v.parent}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  const nullTenantRows: Record<string, number> = {};
  for (const t of ['users', 'products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers', 'stock_adjustments', 'settings']) {
    const cols = all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);
    if (cols.includes('tenant_id')) nullTenantRows[t] = one<{ n: number }>(db, `SELECT COUNT(*) n FROM ${t} WHERE tenant_id IS NULL`)!.n;
  }
  const num = (sql: string) => Number(one<{ v: number }>(db, sql)?.v ?? 0);
  const entry: FixtureManifestEntry = {
    file: path.basename(file),
    description,
    rowCounts: rowCounts(db),
    invariants: {
      productStockSum: num('SELECT COALESCE(SUM(stock),0) v FROM products'),
      customerBalanceSum: +num('SELECT COALESCE(SUM(current_balance),0) v FROM customers').toFixed(2),
      salesGrandTotalSum: +num('SELECT COALESCE(SUM(grand_total),0) v FROM sales_headers').toFixed(2),
      ledgerRows: num('SELECT COUNT(*) v FROM customer_ledger'),
    },
    integrity: integrityCheck(db),
    foreignKeyViolations: [...grouped.entries()].map(([k, count]) => {
      const [table, parent] = k.split('->');
      return { table, parent, count };
    }),
    nullTenantRows,
  };
  db.close();
  return entry;
}

async function withOriginal<T>(workDir: string | undefined, fn: (admin: Api) => Promise<T>, seedDb?: string) {
  const srv = await startServer({ entry: ORIGINAL_SERVER, workDir, seedDb });
  try {
    const admin = new Api();
    await admin.login('admin', 'admin123');
    const out = await fn(admin);
    return { srv, out };
  } finally {
    await srv.stop();
  }
}

/** A database in the oldest schema the original code still migrates: role CHECK constraint, no tenant/email/status/barcode columns. */
async function buildPreTenantSchema(file: string) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN','STAFF','CUSTOMER')), full_name TEXT NOT NULL, phone TEXT, customer_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, company TEXT, address TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL, purchase_price REAL NOT NULL,
      sale_price REAL NOT NULL, min_stock INTEGER NOT NULL DEFAULT 10, stock INTEGER NOT NULL DEFAULT 0, batch_number TEXT, expiry_date TEXT,
      category_id INTEGER, hsn_code TEXT, gst_rate REAL DEFAULT 0, rack_location TEXT, supplier_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, address TEXT,
      opening_balance REAL DEFAULT 0, current_balance REAL DEFAULT 0, login_id TEXT UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE customer_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL CHECK(type IN ('SALE','PAYMENT','ADJUSTMENT')), reference TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0,
      balance_after REAL DEFAULT 0, notes TEXT);
    CREATE TABLE sales_headers (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT UNIQUE NOT NULL, customer_id INTEGER,
      sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, total_amount REAL NOT NULL, discount_percent REAL DEFAULT 0, discount_amount REAL DEFAULT 0,
      net_amount REAL NOT NULL, total_gst REAL DEFAULT 0, grand_total REAL NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('CASH','PARTIAL','UDHAR')), amount_paid REAL NOT NULL, amount_due REAL NOT NULL,
      payment_status TEXT NOT NULL CHECK(payment_status IN ('PAID','PARTIAL','UNPAID')), created_by_user_id INTEGER NOT NULL);
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL,
      unit TEXT NOT NULL, sale_price REAL NOT NULL, cost_price REAL NOT NULL, discount_percent REAL DEFAULT 0, discount_amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0, batch_number TEXT, expiry_date TEXT, subtotal REAL NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  const hash = '$2b$10$abcdefghijklmnopqrstuuJ1h0hKq1M7nJ9fF8bN0p1Yx8Hc5w4nK'; // not a real password
  db.run("INSERT INTO users (username,password_hash,role,full_name,phone) VALUES ('owner_old',?, 'ADMIN','Old Owner','0300')", [hash]);
  db.run("INSERT INTO users (username,password_hash,role,full_name,phone) VALUES ('clerk_old',?, 'STAFF','Old Clerk','0301')", [hash]);
  db.run("INSERT INTO categories (name) VALUES ('Tablets'),('Syrups')");
  db.run("INSERT INTO suppliers (name) VALUES ('Old Supplier')");
  db.run(`INSERT INTO products (name,unit,purchase_price,sale_price,stock,batch_number,expiry_date,category_id,supplier_id)
          VALUES ('Old Med A','Pack',10,15,40,'OA-1','2027-01-01',1,1),('Old Med B','Bottle',20,30,0,'OB-1','2026-06-01',2,1)`);
  db.run("INSERT INTO customers (name,phone,current_balance,login_id) VALUES ('Old Customer','03009999999',150,'03009999999')");
  db.run(`INSERT INTO sales_headers (invoice_number,customer_id,total_amount,net_amount,grand_total,payment_method,amount_paid,amount_due,payment_status,created_by_user_id)
          VALUES ('INV-1001',1,150,150,150,'UDHAR',0,150,'UNPAID',1)`);
  db.run("INSERT INTO sale_items (sale_id,product_id,quantity,unit,sale_price,cost_price,subtotal) VALUES (1,1,10,'Pack',15,10,150)");
  db.run("INSERT INTO customer_ledger (customer_id,type,reference,debit,credit,balance_after) VALUES (1,'SALE','Invoice #INV-1001',150,0,150)");
  db.run("INSERT INTO settings (key,value) VALUES ('store_name','Old Pharmacy'),('address','Old Street')");
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

export async function generateFixtures(outDir: string, log: (m: string) => void = () => {}): Promise<Record<string, FixtureManifestEntry>> {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest: Record<string, FixtureManifestEntry> = {};
  const save = async (name: string, src: string, description: string) => {
    const dest = path.join(outDir, `${name}.sqlite`);
    fs.copyFileSync(src, dest);
    manifest[name] = await summarize(dest, description);
    log(`  ${name}: ${JSON.stringify(manifest[name].invariants)}`);
  };

  // 1. first boot only
  {
    const { srv } = await withOriginal(undefined, async () => {});
    await save('fresh-first-boot', srv.dbFile, 'Original app, first start only (seed rows have tenant_id NULL, no barcodes).');
  }

  // 2. first boot + restart
  {
    const work = makeTempDir();
    await withOriginal(work, async () => {});
    const { srv } = await withOriginal(work, async () => {});
    await save('after-restart', srv.dbFile, 'Original app started twice (tenant_id backfilled, invented barcodes).');
  }

  // 3. a busy single store
  {
    const work = makeTempDir();
    await withOriginal(work, async () => {});
    const { srv } = await withOriginal(work, async (admin) => {
      await admin.post('/suppliers', { name: 'Fixture Supplier', phone: '0321' });
      for (let i = 0; i < 15; i++) {
        await admin.post('/inventory', { name: `Fixture Med ${i}`, unit: 'Pack', purchase_price: 10 + i, sale_price: 15 + i, stock: 20 + i, batch_number: `FX-${i}`, expiry_date: `2027-0${(i % 9) + 1}-15`, barcode: i % 3 === 0 ? '' : `69${String(1000000000 + i)}` });
      }
      for (let i = 0; i < 8; i++) await admin.post('/customers', { name: `Fixture Customer ${i}`, phone: `0333${String(1000000 + i)}`, opening_balance: i * 50 });
      const customers = (await admin.get('/customers')).body;
      for (let i = 0; i < 40; i++) {
        const p = await prodById(admin, (i % 12) + 1);
        const c = customers[i % customers.length];
        const method = i % 5 === 0 ? 'UDHAR' : i % 7 === 0 ? 'PARTIAL' : 'CASH';
        const items = [cartItem(p, 1 + (i % 3), { discount_percent: i % 4 === 0 ? 5 : 0 })];
        const payload = salePayload(items, method === 'CASH' ? {} : { payment_method: method, customer_id: c.id, amount_paid: method === 'PARTIAL' ? 50 : 0 });
        await admin.post('/sales', payload);
      }
      for (let i = 0; i < 5; i++) await admin.post('/purchases', { supplier_id: 1, items: [{ product_id: i + 1, quantity: 30, purchase_price: 100 + i, batch_number: `PB-${i}`, expiry_date: '2028-06-30' }] });
      await admin.post('/inventory/adjust', { product_id: 3, adjustment_type: 'REMOVE', quantity: 2, reason: 'Damaged' });
      await admin.post('/inventory/adjust', { product_id: 4, adjustment_type: 'ADD', quantity: 5, reason: 'Count correction' });
      await admin.post(`/customers/${customers[0].id}/payment`, { amount: 100, payment_mode: 'Cash' });
      const hist = (await admin.get('/sales/history')).body;
      await admin.del(`/sales/${hist[hist.length - 1].id}`); // a void (hard delete) of the newest
      await admin.post('/email/process', {});
    });
    await save('busy-store', srv.dbFile, 'Single store: 40 sales (cash/udhar/partial), purchases, adjustments, payments, one void.');
  }

  // 4. multi-tenant
  {
    const work = makeTempDir();
    await withOriginal(work, async () => {});
    const { srv } = await withOriginal(work, async () => {
      const sa = new Api();
      await sa.login('superadmin', 'admin123');
      for (const n of [2, 3]) {
        await sa.post('/superadmin/tenants', { name: `Branch ${n}`, owner_name: `Owner ${n}`, owner_email: `owner${n}@fixture.local`, owner_password: 'Owner123!' });
      }
      const tenants = (await sa.get('/superadmin/tenants')).body as any[];
      for (const t of tenants.filter((x) => x.id !== 1)) {
        const o = new Api();
        o.token = (await sa.post(`/superadmin/tenants/${t.id}/login-as`, {})).body.token;
        const add = await o.post('/inventory', { name: `Branch ${t.id} Med`, unit: 'Pack', purchase_price: 5, sale_price: 9, stock: 50 });
        const p = (await o.get('/inventory')).body.find((x: any) => x.id === add.body.id);
        await o.post('/customers', { name: `Branch ${t.id} Cust`, phone: `0344${t.id}000000` });
        for (let i = 0; i < 3; i++) await o.post('/sales', salePayload([cartItem(p, 2)]));
      }
      const t3 = tenants.find((x) => x.owner_email === 'owner3@fixture.local');
      await sa.del(`/superadmin/tenants/${t3.id}`); // leaves sale_items/ledger orphans
    });
    await save('multi-tenant', srv.dbFile, 'Three stores created by SUPER_ADMIN, one deleted (orphans remain).');
  }

  // 5. orphan-producing deletes
  {
    const work = makeTempDir();
    await withOriginal(work, async () => {});
    const { srv } = await withOriginal(work, async (admin) => {
      const add = await admin.post('/inventory', { name: 'Doomed Med', unit: 'Pack', purchase_price: 5, sale_price: 10, stock: 10 });
      const p = await prodById(admin, add.body.id);
      await admin.post('/sales', salePayload([cartItem(p, 1)], { customer_id: 3 }));
      await admin.del(`/inventory/${p.id}`); // sale_items -> missing product
      await admin.del('/customers/3'); // sales_headers -> missing customer, ledger erased
      await admin.post('/settings/test-smtp', { testEmail: 'x@fixture.local' });
    });
    await save('orphans', srv.dbFile, 'Deleted product with sales history and deleted customer with invoices (FK violations).');
  }

  // 6b. inventory edge cases the original app allowed (input for the Phase 6 batch migration)
  {
    const work = makeTempDir();
    await withOriginal(work, async () => {});
    const { srv } = await withOriginal(work, async (admin) => {
      const p = async (id: number) => (await admin.get('/inventory')).body.find((x: any) => x.id === id);
      const put = async (id: number, patch: Record<string, unknown>) => admin.put(`/inventory/${id}`, { ...(await p(id)), ...patch });
      await put(1, { stock: -3 }); // negative stock typed into the product form
      await put(2, { stock: 7, expiry_date: '12/2027' }); // month/year text
      await put(3, { stock: 5, expiry_date: '05/10/2027' }); // ambiguous day/month
      await put(4, { stock: 9, expiry_date: '' }); // stock without any expiry
      await put(5, { stock: 2.5 }); // fractional stock
      await put(6, { stock: 0 });
      await put(7, { expiry_date: '2027-10' }); // year-month
      const s = await admin.post('/sales', salePayload([cartItem(await p(8), 4)])); // a sale that must stay in history untouched
      if (s.status !== 200) throw new Error('fixture sale failed');
    });
    await save('inventory-edge-cases', srv.dbFile, 'Original app: negative, fractional, zero stock; month/year, ambiguous and blank expiry text; one sale.');
  }

  // 6. pre-tenant (oldest) schema, raw and after the original app migrated it
  {
    const raw = path.join(makeTempDir(), 'pre-tenant.sqlite');
    await buildPreTenantSchema(raw);
    await save('pre-tenant-raw', raw, 'Hand-built oldest schema (role CHECK, no tenant/email/status/barcode) - never opened by the app.');
    const work = makeTempDir();
    // the original app seeds demo data only when users is empty; here users exist, so only migrations run
    const srv = await startServer({ entry: ORIGINAL_SERVER, workDir: work, seedDb: raw });
    await srv.stop();
    await save('pre-tenant-migrated-by-original', srv.dbFile, 'pre-tenant-raw after one start of the original app (its own ad-hoc migrations applied).');
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Try to read the repository's corrupt sample through a COPY. Returns a per-table report; never writes the original. */
export async function salvageReport(originalFile: string): Promise<{ readable: Record<string, number | string>; integrity: string }> {
  const copy = path.join(makeTempDir(), 'sample-copy.sqlite');
  fs.copyFileSync(originalFile, copy);
  const SQL = await initSqlJs();
  const readable: Record<string, number | string> = {};
  let integrity = '';
  try {
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(copy)));
    try {
      integrity = JSON.stringify(db.exec('PRAGMA integrity_check')[0]?.values?.slice(0, 5));
    } catch (e: any) {
      integrity = `error: ${e.message}`;
    }
    let names: string[] = [];
    try {
      names = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((v) => String(v[0]));
    } catch (e: any) {
      readable['<sqlite_master>'] = `error: ${e.message}`;
    }
    for (const n of names) {
      try {
        readable[n] = Number(db.exec(`SELECT COUNT(*) FROM "${n}"`)[0].values[0][0]);
      } catch (e: any) {
        readable[n] = `error: ${e.message}`;
      }
    }
    db.close();
  } catch (e: any) {
    integrity = `cannot open: ${e.message}`;
  }
  return { readable, integrity };
}

/** Generate the fixtures once (they are git-ignored); reuse them when the manifest exists. */
export async function ensureFixtures(outDir: string): Promise<Record<string, FixtureManifestEntry>> {
  const manifestFile = path.join(outDir, 'manifest.json');
  if (fs.existsSync(manifestFile)) return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return generateFixtures(outDir);
}
