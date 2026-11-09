# Foreign-Key Audit Report (Phase 3)

| | |
|---|---|
| Tool | `npm run audit:fk -- <db files>` (`scripts/fk-audit.ts`) |
| Mode | Read-only. It audits a temporary `VACUUM INTO` copy and never writes the audited file (a test checks the file is byte-identical afterwards). |
| Inputs | The 7 synthetic legacy databases produced by the **original** application (see `TESTING_REPORT.md`). No real customer database has been provided. |
| Tests | `tests/unit/fk-audit.test.ts` (11 tests) |
| Status | **FK1–FK5 approved and implemented** (see §5). `foreign_keys` is **ON** in the running app once a database passes `foreign_key_check`. |

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

## 5. Implementation (approved FK1–FK5)

### FK1: placeholders (migration `0005_fk_placeholders`)

For every missing parent row, the migration inserts an **archived placeholder with the same id**, so existing references resolve again. No child row is modified, re-pointed or deleted. This covers every declared FK, plus `tenant_id → tenants`.

| Missing | Placeholder | Amounts |
|---|---|---|
| product | `[Deleted product #N]` | stock 0, prices 0 |
| customer | `[Deleted customer #N]` (phone `deleted-customer-N`) | balance 0 |
| supplier / category | `[Deleted supplier #N]` / `[Deleted category #N]` | n/a |
| user | `[Deleted user #N]`, status ARCHIVED | n/a |
| sales header | `DELETED-INV-N` | all totals 0, date 1970-01-01 (never counted in today/month/year figures) |
| purchase header | `DELETED-PUR-N` | total 0 |
| store | `[Deleted store #N]`, status DELETED | n/a |

Every placeholder has `is_placeholder = 1` and `archived_at` set, so it is hidden from every active list (condition 1). Original invoice lines, amounts and ledger rows are unchanged; the line simply shows the placeholder name.

**Verified on copies of all seven old-format databases** (`tests/unit/migrations.test.ts`, `tests/unit/fk-audit.test.ts`):
- every original row is still present, and the only new rows are archived placeholders;
- stock, balance, sales and ledger totals are identical;
- `PRAGMA foreign_key_check` is **empty** afterwards;
- enforcement is **ON**.

The orphans and multi-tenant databases get exactly the placeholders listed in §2.

### FK2/FK3: archive instead of delete (migration `0004_archive_support` + routes)

| Delete action | Archived when | Otherwise |
|---|---|---|
| Product | it has sales, purchase or adjustment rows | hard delete (as before) |
| Customer (balance must still be ≤ 0, as before) | it has invoices or ledger rows. Portal login also archived. | hard delete (as before, now audited) |
| Supplier | purchases or products reference it | hard delete |
| User | they created sales or stock adjustments. Status ARCHIVED, sign-in and existing tokens rejected. | hard delete |
| Store (tenant) | **always archived**: status DELETED, all its users blocked, **no data deleted** | n/a |

Further details:
- **Where archived records still appear.** Every audit entry records who archived what. Archived records still appear on invoices, ledgers, purchase details, top-products, sales history and audit logs.
- **Where they are hidden.** They are hidden from: inventory/POS search, customer, supplier, category and user lists, the super-admin store list, and dashboard product/customer counts.
- **A new record can reuse an archived record's phone, username or owner email.** The archived row's value is renamed to `value~archived-<id>` and the original is kept in `archived_key`. Only archived rows are ever changed this way.
- **Legacy defect fixed: deleting a user no longer reassigns their history.** The old "delete user" re-assigned all of that user's sales and stock adjustments to user #1, which falsified who made each sale. History now stays with the real user.
- **Legacy defect fixed: system emails no longer use a fake customer ID.** Super-admin messages and SMTP tests used `customer_id = 1`, and purchase-order emails used the *supplier's id* as a customer id. They now use one hidden `[System messages]` record.

### FK4: relationships enforced by the application, not the schema

| Relationship | Why not a schema FK | How it is enforced |
|---|---|---|
| `<table>.tenant_id → tenants.id` (users, products, sales_headers, customers, categories, suppliers, purchase_headers, stock_adjustments, settings, audit_logs, email_queue, sms_queue) | SQLite cannot add an FK to an existing column. It needs a full rebuild of the busiest tables (sales, products, customers, audit). Old databases also contain `tenant_id NULL` rows that the current code treats as "visible to the store", which a strict FK would not change. Rebuilding these tables now is a high-risk change for little gain. | Every query filters by the caller's tenant. Store removal is now an archive, so tenant ids never disappear. Migration 0005 creates placeholder stores for ids already missing. `scripts/fk-audit.ts` checks these links. |
| `customer_ledger.sale_id → sales_headers.id` | Informational link added later by ALTER; voids (`DELETE /api/sales/:id`) remove the header but intentionally keep the ledger history | Ledger lookup tolerates a missing sale (shows no items). Phase 7 soft-void keeps headers, so the link stays valid. |
| `users.customer_id → customers.id` | Added by ALTER; same table-rebuild cost | Customer delete now archives the customer and its portal user together |

Database integrity is not weakened: every relationship that was declared is now enforced, and the undeclared ones are checked by the audit tool and protected by the archive rules.

### FK5: enforcement

`openDatabase()` runs the migrations with enforcement off (old databases may contain orphans), then runs `PRAGMA foreign_key_check`. If anything is still broken, **startup stops and reports the rows; nothing is auto-repaired**. Otherwise it sets `foreign_keys = ON` for the session.

A database that gains a new broken reference later is refused at the next start, with the rows listed (tested).
