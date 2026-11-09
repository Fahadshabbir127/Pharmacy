/**
 * 0004 archive support (FK2/FK3).
 *
 * Records with history are archived instead of deleted. Archived rows stay in
 * their tables (so invoices, ledgers, reports and audit logs keep resolving)
 * but are hidden from active lists. Only nullable columns are added.
 *
 *   archived_at      when it was archived (NULL = active)
 *   archived_by      user id that archived it (no FK on purpose: the user may itself be archived)
 *   archive_reason   free text
 *   is_placeholder   1 = created by migration 0005 to stand in for a row an older version deleted
 *   archived_key     original value of a UNIQUE column that was renamed to free it for a new record
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

export const ARCHIVABLE_TABLES = ['products', 'customers', 'suppliers', 'categories', 'users', 'tenants', 'sales_headers', 'purchase_headers'];

export const archiveSupport: Migration = {
  version: 4,
  name: 'archive_support',
  up(db: DbAdapter) {
    for (const t of ARCHIVABLE_TABLES) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name);
      const add = (col: string, decl: string) => { if (!cols.includes(col)) db.exec(`ALTER TABLE "${t}" ADD COLUMN "${col}" ${decl}`); };
      add('archived_at', 'TEXT');
      add('archived_by', 'INTEGER');
      add('archive_reason', 'TEXT');
      add('is_placeholder', 'INTEGER NOT NULL DEFAULT 0');
      add('archived_key', 'TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_products_active ON products(tenant_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(tenant_id, archived_at);
    `);
  },
};
