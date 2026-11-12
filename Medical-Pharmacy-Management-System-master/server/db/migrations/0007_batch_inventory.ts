/**
 * 0007 batch inventory (Phase 6).
 *
 * New tables
 *   product_batches             one row per received lot; qty_on_hand can never go below 0 (CHECK)
 *   sale_item_batches           which batches each sale line was taken from (FEFO allocation)
 *   inventory_migration_issues  everything this migration could not take over 1:1 (nothing is fixed silently)
 * New columns
 *   purchase_items.batch_id, mfg_date, sale_price
 *   stock_adjustments.batch_id, reason_code
 * Database-level stock protection (triggers)
 *   products.stock is maintained as SUM(product_batches.qty_on_hand) and any direct write that
 *   disagrees with the batches is rejected; a new product cannot be inserted with stock != 0.
 *
 * Existing data
 *   every product with stock > 0 gets ONE 'MIGRATION' batch from its current batch number, expiry,
 *   prices and supplier, so each product's stock is unchanged. Historical purchases and sales are
 *   not modified. Expiry text: YYYY-MM-DD kept, month-only -> last day of month, anything else ->
 *   no expiry + original text kept in expiry_raw + an issue row. Negative stock (possible in the old
 *   app) becomes 0 with the old value recorded as an issue (approved decision D4).
 * The runner wraps this in a transaction after a verified backup; a failure rolls everything back.
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';
import { normalizeExpiry } from '../../inventory/expiry';

export const STOCK_GUARD_MESSAGE = 'STOCK_GUARD: products.stock is derived from product_batches and cannot be set directly';

export const batchInventory: Migration = {
  version: 7,
  name: 'batch_inventory',
  up(db: DbAdapter) {
    db.exec(`
      CREATE TABLE product_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        batch_number TEXT,
        mfg_date TEXT,
        expiry_date TEXT,
        expiry_raw TEXT,
        purchase_price REAL NOT NULL DEFAULT 0,
        sale_price REAL NOT NULL DEFAULT 0,
        qty_received INTEGER NOT NULL DEFAULT 0,
        qty_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
        supplier_id INTEGER REFERENCES suppliers(id),
        purchase_item_id INTEGER REFERENCES purchase_items(id),
        source TEXT NOT NULL CHECK (source IN ('MIGRATION', 'OPENING', 'PURCHASE', 'ADJUSTMENT', 'VOID_RESTORE')),
        tenant_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER,
        updated_at TEXT
      );
      CREATE INDEX idx_batches_product_fefo ON product_batches(product_id, expiry_date, id);
      CREATE INDEX idx_batches_tenant_expiry ON product_batches(tenant_id, expiry_date);

      CREATE TABLE sale_item_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        batch_id INTEGER NOT NULL REFERENCES product_batches(id),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_cost REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sib_sale_item ON sale_item_batches(sale_item_id);
      CREATE INDEX idx_sib_batch ON sale_item_batches(batch_id);

      CREATE TABLE inventory_migration_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        issue TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE purchase_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(id);
      ALTER TABLE purchase_items ADD COLUMN mfg_date TEXT;
      ALTER TABLE purchase_items ADD COLUMN sale_price REAL;
      ALTER TABLE stock_adjustments ADD COLUMN batch_id INTEGER REFERENCES product_batches(id);
      ALTER TABLE stock_adjustments ADD COLUMN reason_code TEXT;
    `);

    // ---- take over existing stock, product by product ----
    const products = db.all<{ id: number; name: string; stock: number; batch_number: string | null; expiry_date: string | null; purchase_price: number; sale_price: number; supplier_id: number | null; tenant_id: number | null }>(
      'SELECT id, name, stock, batch_number, expiry_date, purchase_price, sale_price, supplier_id, tenant_id FROM products ORDER BY id',
    );
    const issue = (productId: number, kind: string, oldV: unknown, newV: unknown, detail: string) => {
      db.run('INSERT INTO inventory_migration_issues (product_id, issue, old_value, new_value, detail) VALUES (?, ?, ?, ?, ?)', [productId, kind, oldV === null || oldV === undefined ? null : String(oldV), newV === null || newV === undefined ? null : String(newV), detail]);
      // stock-value changes are also written to the audit log (decision D4)
      if (kind !== 'EXPIRY_UNRECOGNIZED') {
        const t = db.get<{ tenant_id: number | null }>('SELECT tenant_id FROM products WHERE id = ?', [productId]);
        db.run("INSERT INTO audit_logs (user_id, user_name, action_type, description, target_type, target_id, tenant_id) VALUES (NULL, 'Database upgrade', 'INVENTORY_MIGRATION_ISSUE', ?, 'PRODUCT', ?, ?)",
          [`${kind}: product #${productId} stock ${String(oldV)} -> ${String(newV)}. ${detail}`, productId, t?.tenant_id ?? null]);
      }
    };
    const expected = new Map<number, number>();

    for (const p of products) {
      const raw = Number(p.stock ?? 0);
      let qty = Number.isFinite(raw) ? raw : 0;
      if (!Number.isFinite(raw)) issue(p.id, 'INVALID_STOCK', p.stock, 0, 'Stock value was not a number; migrated as 0');
      if (qty < 0) {
        issue(p.id, 'NEGATIVE_STOCK', qty, 0, 'Negative stock (allowed by the old product form) migrated as 0 (decision D4)');
        qty = 0;
      }
      if (!Number.isInteger(qty)) {
        issue(p.id, 'NON_INTEGER_STOCK', qty, Math.floor(qty), 'Fractional stock rounded down to whole units');
        qty = Math.floor(qty);
      }
      expected.set(p.id, qty);
      if (qty === 0) {
        if (raw !== 0) db.run('UPDATE products SET stock = 0 WHERE id = ?', [p.id]); // triggers do not exist yet
        continue;
      }
      const exp = normalizeExpiry(p.expiry_date);
      if (!exp.recognized) issue(p.id, 'EXPIRY_UNRECOGNIZED', p.expiry_date, null, 'Expiry text could not be read; the batch has no expiry until corrected (original text kept in expiry_raw)');
      const supplierOk = p.supplier_id !== null && !!db.get('SELECT 1 AS x FROM suppliers WHERE id = ?', [p.supplier_id]);
      db.run(
        `INSERT INTO product_batches (product_id, batch_number, expiry_date, expiry_raw, purchase_price, sale_price, qty_received, qty_on_hand, supplier_id, source, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MIGRATION', ?)`,
        [p.id, p.batch_number || null, exp.date, p.expiry_date ?? null, Number(p.purchase_price) || 0, Number(p.sale_price) || 0, qty, qty, supplierOk ? p.supplier_id : null, p.tenant_id],
      );
      if (qty !== raw) db.run('UPDATE products SET stock = ? WHERE id = ?', [qty, p.id]);
    }

    // ---- database-level protection: products.stock always equals the sum of its batches ----
    const sum = (idExpr: string) => `(SELECT COALESCE(SUM(qty_on_hand), 0) FROM product_batches WHERE product_id = ${idExpr})`;
    db.exec(`
      CREATE TRIGGER trg_batches_ai AFTER INSERT ON product_batches BEGIN
        UPDATE products SET stock = ${sum('NEW.product_id')}, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.product_id;
      END;
      CREATE TRIGGER trg_batches_au AFTER UPDATE OF qty_on_hand, product_id ON product_batches BEGIN
        UPDATE products SET stock = ${sum('NEW.product_id')}, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.product_id;
        UPDATE products SET stock = ${sum('OLD.product_id')}, updated_at = CURRENT_TIMESTAMP WHERE id = OLD.product_id AND OLD.product_id <> NEW.product_id;
      END;
      CREATE TRIGGER trg_batches_ad AFTER DELETE ON product_batches BEGIN
        UPDATE products SET stock = ${sum('OLD.product_id')}, updated_at = CURRENT_TIMESTAMP WHERE id = OLD.product_id;
      END;
      CREATE TRIGGER trg_products_stock_guard_update BEFORE UPDATE OF stock ON products
      WHEN NEW.stock IS NOT ${sum('NEW.id')} BEGIN
        SELECT RAISE(ABORT, '${STOCK_GUARD_MESSAGE}');
      END;
      CREATE TRIGGER trg_products_stock_guard_insert BEFORE INSERT ON products
      WHEN COALESCE(NEW.stock, 0) <> 0 BEGIN
        SELECT RAISE(ABORT, '${STOCK_GUARD_MESSAGE}');
      END;
    `);

    // ---- prove nothing changed except the recorded issues ----
    for (const [id, qty] of expected) {
      const now = db.get<{ stock: number; s: number }>(`SELECT stock, ${sum('products.id')} AS s FROM products WHERE id = ?`, [id])!;
      if (now.stock !== qty || now.s !== qty) {
        throw new Error(`batch migration check failed for product #${id}: expected ${qty}, stock ${now.stock}, batches ${now.s}`);
      }
    }
  },
};
