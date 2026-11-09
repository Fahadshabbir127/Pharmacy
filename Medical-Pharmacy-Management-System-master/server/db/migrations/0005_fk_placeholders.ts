/**
 * 0005 FK placeholders (FK1).
 *
 * Older versions deleted products, customers, stores, ... that invoices and
 * ledgers still referenced. For every such missing parent this migration
 * inserts an ARCHIVED placeholder row WITH THE SAME ID, so every existing
 * reference resolves again. Nothing is deleted or re-pointed; no child row
 * is modified. Placeholders are hidden from all active lists and carry
 * zero amounts/stock, so totals and reports do not change.
 *
 * Covered: every declared FK (PRAGMA foreign_key_check) plus the undeclared
 * tenant_id -> tenants links (application-enforced, see docs/FK_AUDIT_REPORT.md).
 * If a violation remains that it cannot resolve, it throws and the whole
 * migration rolls back (the runner then stops startup and reports).
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

const NOW = () => new Date().toISOString();
const REASON = 'Placeholder for a record deleted by an earlier version (kept so history stays complete)';
const TENANT_TABLES = ['users', 'products', 'sales_headers', 'customers', 'categories', 'suppliers', 'purchase_headers', 'stock_adjustments', 'settings', 'audit_logs', 'email_queue', 'sms_queue'];

/** A bcrypt hash of 32 random bytes: a valid hash nobody can log in with. */
export function unusablePasswordHash(): string {
  return bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
}

/** Hidden user that placeholder headers point to when their creator is unknown. */
function systemUserId(db: DbAdapter): number {
  const row = db.get<{ id: number }>("SELECT id FROM users WHERE username = '__system_deleted_records__'");
  if (row) return row.id;
  return db.run(
    `INSERT INTO users (username, password_hash, role, full_name, status, archived_at, archive_reason, is_placeholder)
     VALUES ('__system_deleted_records__', ?, 'STAFF', '[System: deleted records]', 'ARCHIVED', ?, ?, 1)`,
    [unusablePasswordHash(), NOW(), REASON],
  ).lastInsertRowid;
}

function systemSupplierId(db: DbAdapter): number {
  const row = db.get<{ id: number }>("SELECT id FROM suppliers WHERE name = '[System: deleted supplier]' AND is_placeholder = 1");
  if (row) return row.id;
  return db.run(`INSERT INTO suppliers (name, archived_at, archive_reason, is_placeholder) VALUES ('[System: deleted supplier]', ?, ?, 1)`, [NOW(), REASON]).lastInsertRowid;
}

/** Insert a placeholder parent row with the given id. Returns false if the table is not handled. */
export function insertPlaceholder(db: DbAdapter, parent: string, id: number, tenantId: number | null): boolean {
  const meta = [NOW(), REASON];
  switch (parent) {
    case 'products':
      db.run(`INSERT INTO products (id, name, unit, purchase_price, sale_price, min_stock, stock, tenant_id, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, 'Unit', 0, 0, 0, 0, ?, ?, ?, 1)`, [id, `[Deleted product #${id}]`, tenantId, ...meta]);
      return true;
    case 'customers':
      db.run(`INSERT INTO customers (id, name, phone, opening_balance, current_balance, tenant_id, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, ?, 0, 0, ?, ?, ?, 1)`, [id, `[Deleted customer #${id}]`, `deleted-customer-${id}`, tenantId, ...meta]);
      return true;
    case 'suppliers':
      db.run(`INSERT INTO suppliers (id, name, tenant_id, archived_at, archive_reason, is_placeholder) VALUES (?, ?, ?, ?, ?, 1)`,
        [id, `[Deleted supplier #${id}]`, tenantId, ...meta]);
      return true;
    case 'categories':
      db.run(`INSERT INTO categories (id, name, tenant_id, archived_at, archive_reason, is_placeholder) VALUES (?, ?, ?, ?, ?, 1)`,
        [id, `[Deleted category #${id}]`, tenantId, ...meta]);
      return true;
    case 'users':
      db.run(`INSERT INTO users (id, username, password_hash, role, full_name, status, tenant_id, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, ?, 'STAFF', ?, 'ARCHIVED', ?, ?, ?, 1)`,
        [id, `__deleted_user_${id}__`, unusablePasswordHash(), `[Deleted user #${id}]`, tenantId, ...meta]);
      return true;
    case 'sales_headers':
      // zero amounts and an epoch date: never counted in today/month/year figures
      db.run(`INSERT INTO sales_headers (id, invoice_number, customer_id, sale_date, total_amount, net_amount, grand_total, payment_method,
                amount_paid, amount_due, payment_status, created_by_user_id, tenant_id, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, NULL, '1970-01-01 00:00:00', 0, 0, 0, 'CASH', 0, 0, 'PAID', ?, ?, ?, ?, 1)`,
        [id, `DELETED-INV-${id}`, systemUserId(db), tenantId, ...meta]);
      return true;
    case 'purchase_headers':
      db.run(`INSERT INTO purchase_headers (id, invoice_number, supplier_id, purchase_date, total_amount, notes, tenant_id, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, ?, '1970-01-01 00:00:00', 0, 'Placeholder', ?, ?, ?, 1)`,
        [id, `DELETED-PUR-${id}`, systemSupplierId(db), tenantId, ...meta]);
      return true;
    case 'tenants':
      db.run(`INSERT INTO tenants (id, name, owner_name, owner_email, status, archived_at, archive_reason, is_placeholder)
              VALUES (?, ?, '-', ?, 'DELETED', ?, ?, 1)`, [id, `[Deleted store #${id}]`, `deleted-store-${id}@invalid.local`, ...meta]);
      return true;
    default:
      return false;
  }
}

/** Best-effort tenant for a placeholder: the tenant of the child row that references it. */
function childTenant(db: DbAdapter, table: string, rowid: number): number | null {
  const cols = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
  if (cols.includes('tenant_id')) return db.get<{ t: number | null }>(`SELECT tenant_id t FROM "${table}" WHERE rowid = ?`, [rowid])?.t ?? null;
  if (table === 'sale_items') return db.get<{ t: number | null }>('SELECT h.tenant_id t FROM sale_items i JOIN sales_headers h ON h.id = i.sale_id WHERE i.rowid = ?', [rowid])?.t ?? null;
  if (table === 'purchase_items') return db.get<{ t: number | null }>('SELECT h.tenant_id t FROM purchase_items i JOIN purchase_headers h ON h.id = i.purchase_id WHERE i.rowid = ?', [rowid])?.t ?? null;
  return null;
}

export interface PlaceholderReport { parent: string; id: number }

export function resolveOrphans(db: DbAdapter): PlaceholderReport[] {
  const created: PlaceholderReport[] = [];
  for (let pass = 0; pass < 6; pass++) {
    let progress = false;
    // undeclared tenant links first: placeholder rows below inherit those tenant ids
    for (const t of TENANT_TABLES) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name);
      if (!cols.includes('tenant_id')) continue;
      const missing = db.all<{ id: number }>(`SELECT DISTINCT tenant_id id FROM "${t}" WHERE tenant_id IS NOT NULL AND tenant_id NOT IN (SELECT id FROM tenants)`);
      for (const { id } of missing) {
        insertPlaceholder(db, 'tenants', id, null);
        created.push({ parent: 'tenants', id });
        progress = true;
      }
    }
    const violations = db.all<{ table: string; rowid: number; parent: string; fkid: number }>('PRAGMA foreign_key_check');
    if (!violations.length && !progress) return created;
    for (const v of violations) {
      const fk = db.all<{ id: number; from: string; to: string | null }>(`PRAGMA foreign_key_list("${v.table}")`).find((f) => f.id === v.fkid);
      if (!fk) throw new Error(`cannot resolve FK ${v.fkid} of ${v.table}`);
      const missingId = db.get<{ v: number }>(`SELECT "${fk.from}" v FROM "${v.table}" WHERE rowid = ?`, [v.rowid])?.v;
      if (missingId === undefined || missingId === null) continue;
      if (db.get(`SELECT 1 x FROM "${v.parent}" WHERE ${fk.to ? `"${fk.to}"` : 'rowid'} = ?`, [missingId])) continue; // created earlier in this pass
      if (!insertPlaceholder(db, v.parent, Number(missingId), childTenant(db, v.table, v.rowid))) {
        throw new Error(`no placeholder rule for missing ${v.parent} #${missingId} referenced by ${v.table}`);
      }
      created.push({ parent: v.parent, id: Number(missingId) });
      progress = true;
    }
  }
  const left = db.all('PRAGMA foreign_key_check');
  if (left.length) throw new Error(`${left.length} foreign key violation(s) remain after creating placeholders`);
  return created;
}

export const fkPlaceholders: Migration = {
  version: 5,
  name: 'fk_placeholders',
  up(db: DbAdapter) {
    resolveOrphans(db);
  },
};
