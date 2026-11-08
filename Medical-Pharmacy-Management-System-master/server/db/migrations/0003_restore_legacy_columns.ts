/**
 * 0003 restore legacy columns.
 *
 * The legacy users-table rebuild (in 0001, copied verbatim from the original
 * app) recreates `users` without `allowed_services`, after the ALTER statements
 * had added it. The original app only recovered because it re-ran every ALTER
 * on the next start; migrations run once, so this step adds back any column the
 * original app's ALTER list expects and the database lacks. Adding a nullable
 * column never changes existing rows.
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

/** Every column the original app added with ALTER TABLE ... ADD COLUMN (server.ts @ ec90af3, lines 284-302, 324-329). */
export const LEGACY_ALTER_COLUMNS: [table: string, column: string, decl: string][] = [
  ['users', 'email', 'TEXT'],
  ['users', 'status', "TEXT DEFAULT 'APPROVED'"],
  ['users', 'tenant_id', 'INTEGER'],
  ['users', 'allowed_services', 'TEXT'],
  ['products', 'barcode', 'TEXT'],
  ['products', 'tenant_id', 'INTEGER'],
  ['sales_headers', 'tenant_id', 'INTEGER'],
  ['customers', 'tenant_id', 'INTEGER'],
  ['categories', 'tenant_id', 'INTEGER'],
  ['suppliers', 'tenant_id', 'INTEGER'],
  ['purchase_headers', 'tenant_id', 'INTEGER'],
  ['stock_adjustments', 'tenant_id', 'INTEGER'],
  ['settings', 'tenant_id', 'INTEGER'],
  ['customer_ledger', 'sale_id', 'INTEGER'],
  ['tenants', 'allowed_services', "TEXT DEFAULT 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL'"],
  ['audit_logs', 'tenant_id', 'INTEGER'],
  ['audit_logs', 'user_agent', 'TEXT'],
  ['email_queue', 'tenant_id', 'INTEGER'],
  ['sms_queue', 'tenant_id', 'INTEGER'],
];

export const restoreLegacyColumns: Migration = {
  version: 3,
  name: 'restore_legacy_columns',
  up(db: DbAdapter) {
    for (const [table, column, decl] of LEGACY_ALTER_COLUMNS) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
      if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
    }
  },
};
