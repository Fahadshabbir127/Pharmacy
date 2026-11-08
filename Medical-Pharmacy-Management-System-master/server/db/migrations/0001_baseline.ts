/**
 * 0001 baseline: the schema exactly as the original application created and
 * patched it on every start (server.ts @ ec90af3, lines 68-357), moved here
 * verbatim except:
 *   - the 17-statement CREATE block uses db.exec (better-sqlite3 run() takes one statement)
 *   - queryOne(...) -> db.get(...)
 * It is idempotent, so it is safe on empty databases and on every legacy
 * variant (including the oldest users table with a role CHECK constraint).
 * Data-changing startup steps (tenant backfill, seeding, ...) are NOT here;
 * they remain startup tasks in server.ts until their approved removal.
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

export const baseline: Migration = {
  version: 1,
  name: 'baseline_legacy_schema',
  up(db: DbAdapter) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        status TEXT DEFAULT 'APPROVED',
        customer_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        address TEXT
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        purchase_price REAL NOT NULL,
        sale_price REAL NOT NULL,
        min_stock INTEGER NOT NULL DEFAULT 10,
        stock INTEGER NOT NULL DEFAULT 0,
        batch_number TEXT,
        expiry_date TEXT,
        category_id INTEGER,
        hsn_code TEXT,
        gst_rate REAL DEFAULT 0,
        rack_location TEXT,
        supplier_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
      );

      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        address TEXT,
        opening_balance REAL DEFAULT 0,
        current_balance REAL DEFAULT 0,
        login_id TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS customer_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL CHECK(type IN ('SALE', 'PAYMENT', 'ADJUSTMENT')),
        reference TEXT,
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        balance_after REAL DEFAULT 0,
        notes TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );

      CREATE TABLE IF NOT EXISTS sales_headers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT UNIQUE NOT NULL,
        customer_id INTEGER,
        sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_amount REAL NOT NULL,
        discount_percent REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        net_amount REAL NOT NULL,
        total_gst REAL DEFAULT 0,
        grand_total REAL NOT NULL,
        payment_method TEXT NOT NULL CHECK(payment_method IN ('CASH', 'PARTIAL', 'UDHAR')),
        amount_paid REAL NOT NULL,
        amount_due REAL NOT NULL,
        payment_status TEXT NOT NULL CHECK(payment_status IN ('PAID', 'PARTIAL', 'UNPAID')),
        created_by_user_id INTEGER NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (created_by_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        unit TEXT NOT NULL,
        sale_price REAL NOT NULL,
        cost_price REAL NOT NULL,
        discount_percent REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        gst_amount REAL DEFAULT 0,
        batch_number TEXT,
        expiry_date TEXT,
        subtotal REAL NOT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales_headers(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS purchase_headers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT UNIQUE NOT NULL,
        supplier_id INTEGER NOT NULL,
        purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_amount REAL NOT NULL,
        notes TEXT,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
      );

      CREATE TABLE IF NOT EXISTS purchase_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        purchase_price REAL NOT NULL,
        batch_number TEXT,
        expiry_date TEXT,
        FOREIGN KEY (purchase_id) REFERENCES purchase_headers(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('ADD', 'REMOVE')),
        quantity INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS email_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('UDHAR_REMINDER', 'PAYMENT_CONFIRMATION', 'WELCOME', 'ACCOUNT_APPROVED')),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SENT', 'FAILED')),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );

      CREATE TABLE IF NOT EXISTS sms_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('UDHAR_REMINDER', 'PAYMENT_CONFIRMATION', 'WELCOME')),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SENT', 'FAILED')),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        action_type TEXT NOT NULL,
        description TEXT NOT NULL,
        target_type TEXT,
        target_id INTEGER,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS otp_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        otp_code TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        is_verified INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        owner_email TEXT NOT NULL UNIQUE,
        phone TEXT,
        address TEXT,
        city TEXT DEFAULT 'Lahore',
        country TEXT DEFAULT 'Pakistan',
        currency TEXT DEFAULT 'PKR',
        status TEXT DEFAULT 'ACTIVE',
        plan TEXT DEFAULT 'PRO',
        max_users INTEGER DEFAULT 10,
        max_products INTEGER DEFAULT 5000,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    try { db.run("ALTER TABLE users ADD COLUMN email TEXT"); } catch (e) {}
    try { db.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'APPROVED'"); } catch (e) {}
    try { db.run("ALTER TABLE users ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE users ADD COLUMN allowed_services TEXT"); } catch (e) {}
    try { db.run("ALTER TABLE products ADD COLUMN barcode TEXT"); } catch (e) {}
    try { db.run("ALTER TABLE products ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE sales_headers ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE customers ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE categories ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE suppliers ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE purchase_headers ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE stock_adjustments ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE settings ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE customer_ledger ADD COLUMN sale_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE tenants ADD COLUMN allowed_services TEXT DEFAULT 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL'"); } catch (e) {}
    try { db.run("ALTER TABLE audit_logs ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE audit_logs ADD COLUMN user_agent TEXT"); } catch (e) {}
    try { db.run("ALTER TABLE email_queue ADD COLUMN tenant_id INTEGER"); } catch (e) {}
    try { db.run("ALTER TABLE sms_queue ADD COLUMN tenant_id INTEGER"); } catch (e) {}

    try {
      db.run("ALTER TABLE users ADD COLUMN email TEXT");
    } catch (e) {}
    try {
      db.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'APPROVED'");
    } catch (e) {}
    
    // Rebuild users table if old constraint exists
    try {
      const tableSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
      if (tableSql && tableSql.sql && tableSql.sql.includes("CHECK(role IN")) {
        db.run(`
          CREATE TABLE users_migration (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            full_name TEXT NOT NULL,
            phone TEXT,
            customer_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            email TEXT,
            status TEXT DEFAULT 'APPROVED',
            tenant_id INTEGER
          );
        `);
        db.run(`INSERT OR IGNORE INTO users_migration (id, username, password_hash, role, full_name, phone, customer_id, created_at, email, status, tenant_id)
                SELECT id, username, password_hash, role, full_name, phone, customer_id, created_at, email, status, tenant_id FROM users;`);
        db.run("DROP TABLE users;");
        db.run("ALTER TABLE users_migration RENAME TO users;");
      }
    } catch (e) {
      console.error("Migration warning for users table:", e);
    }
  },
};
