# Foreign-Key Audit Report (Phase 3)

| | |
|---|---|
| Tool | `npm run audit:fk -- <db files>` (`scripts/fk-audit.ts`) |
| Mode | Read-only. It audits a temporary `VACUUM INTO` copy and never writes the audited file (a test checks the file is byte-identical afterwards). |
| Inputs | The 7 synthetic legacy databases produced by the **original** application (see `TESTING_REPORT.md`). No real customer database has been provided. |
| Tests | `tests/unit/fk-audit.test.ts` (11 tests) |
| Status | **`foreign_keys` stays OFF**, exactly as in the original app. Enabling it needs your approval of the fixes in §4. |

## 1. Relationships

**Declared in the schema:**
- `sale_items → sales_headers, products`
- `sales_headers → customers, users`
- `customer_ledger → customers`
- `purchase_headers → suppliers`
- `purchase_items → purchase_headers, products`
- `products → categories, suppliers`
- `stock_adjustments → products, users`
- `email_queue / sms_queue → customers`

**Used by the code but not declared:** every `tenant_id → tenants`, `customer_ledger.sale_id → sales_headers`, and `users.customer_id → customers`.

## 2. Findings on the legacy databases

| Database | Orphaned references |
|---|---|
| fresh-first-boot, after-restart, busy-store, pre-tenant-raw, pre-tenant-migrated-by-original | none |
| **orphans** (product deleted after it was sold; customer deleted while an invoice existed) | `sale_items.product_id → products`: 1 · `sales_headers.customer_id → customers`: 1 |
| **multi-tenant** (one store deleted by SUPER_ADMIN) | `sale_items.product_id → products`: 3 · `sale_items.sale_id → sales_headers`: 3 · `audit_logs.tenant_id → tenants`: 4 (undeclared) |

**Every orphan comes from one of the original app's own delete actions:**
- delete product;
- delete customer;
- delete store.

Any real pharmacy database where those actions were used will have the same kind of orphans. The SMTP test row (`email_queue.customer_id = 1`) becomes an orphan only in databases where customer #1 has been deleted.

## 3. What would break if enforcement were switched on today

Verified on migrated copies with `foreign_keys = ON`:

| App action | Result with enforcement ON |
|---|---|
| Delete a product that has sales history | **fails** (FOREIGN KEY constraint) |
| Delete a customer who has invoices | **fails** |
| Delete a user who created sales | **fails** |
| Delete a store (tenant) with sales | **fails** |
| Void an invoice (items first, then header) | works |
| Record a sale for a non-existent product (accepted today) | rejected, which is correct |
| Open/read a database that already contains orphans | works; `foreign_key_check` reports them |

Turning enforcement on without changing these delete actions would make existing buttons fail with errors.

## 4. Proposed fixes (need your approval; nothing has been changed)

| # | Proposal | Effect on users | Data risk |
|---|---|---|---|
| FK1 | **Existing orphans:** in a migration, create one *archived placeholder* parent per missing id ("[Deleted product #N]", "[Deleted customer #N]"), flagged `archived = 1`. No rows deleted, no ids changed. | Old invoices show "[Deleted product #N]" instead of losing the line | None: only inserts |
| FK2 | **Delete product / customer / supplier / user:** if the record has history, *archive* it (hidden from lists, kept for invoices and reports) instead of deleting. Hard delete only when nothing references it. | The Delete button still removes the item from everyday lists; history stays complete. This also fixes "invoice lines disappear after deleting a product" and "customer ledger erased". | Removes a data-loss path |
| FK3 | **Delete store (tenant):** archive the store (status `DELETED`, logins disabled) instead of deleting its rows | Store disappears from the super-admin list; data recoverable | Removes a data-loss path |
| FK4 | `tenant_id` and the other undeclared links stay enforced in code, not as schema FKs. Adding them needs full table rebuilds of the busiest tables, which is not worth the risk now. | None | n/a |
| FK5 | After FK1–FK3, enable `PRAGMA foreign_keys = ON` and add `foreign_key_check` to the startup and backup health checks | Bad references become impossible | Startup refuses a database with new orphans and reports them (no auto-repair) |

I recommend FK1–FK5. They would be implemented with Phase 6 (batch inventory), which rebuilds the same tables anyway.
