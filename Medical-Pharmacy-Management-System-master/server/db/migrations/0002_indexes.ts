/**
 * 0002 indexes: lookup indexes for the hot paths (barcode scan, product search,
 * sales history/reports, invoice detail, customer ledger, purchases, audit log).
 * Only non-unique indexes: they cannot fail on existing data and change no results.
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

export const indexes: Migration = {
  version: 2,
  name: 'lookup_indexes',
  up(db: DbAdapter) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
      CREATE INDEX IF NOT EXISTS idx_products_tenant_name ON products(tenant_id, name);
      CREATE INDEX IF NOT EXISTS idx_sales_headers_tenant_date ON sales_headers(tenant_id, sale_date);
      CREATE INDEX IF NOT EXISTS idx_sales_headers_customer ON sales_headers(customer_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, id);
      CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);
    `);
  },
};
