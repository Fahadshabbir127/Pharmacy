# Database Layer Migration: sql.js → better-sqlite3 (Phase 3)

## Result

All 288 database call sites in `server.ts` now go through `server/db/adapter.ts` (better-sqlite3).

The whole sql.js layer is gone from production code:
- the in-memory database;
- whole-file rewrites;
- the 56 `saveDatabase()` calls;
- manual `BEGIN`/`COMMIT`/`ROLLBACK`.

sql.js remains only as a dev dependency, used by tests to build and read old-format files.

## Behaviour differences found and how each was handled

Each difference was confirmed by running both libraries side by side.

| Case | sql.js (old) | better-sqlite3 | Decision |
|---|---|---|---|
| `"double-quoted"` string literal | accepted | error | Audited: **none** in the code (schema-aware check) |
| `undefined` parameter | **error** | silently NULL | Adapter **rejects** it (keeps the old behaviour; prevents silent NULLs) |
| boolean parameter | stored 1/0 | error | Adapter converts to 1/0 (keeps the old behaviour) |
| too few parameters | missing → NULL | error | Audited: **none**. All 272 static calls match exactly; all 14 runtime-built queries were reviewed by hand. |
| too many parameters | error | error | same |
| several statements in `run()` | all executed | error | 1 site (the 17-table `CREATE` block) moved to `exec()` |
| `foreign_keys` default | OFF | **ON** | Forced **OFF** until the FK fixes are approved (see `FK_AUDIT_REPORT.md`) |
| reading the file while running | whole DB in the file after each save | recent data may be in `-wal` | Backups use `serialize()` / the online backup API, never a file copy |

## Tools (re-runnable)

- **`npm run audit:db-callsites`** (`scripts/audit-db-callsites.ts`) parses `server.ts` with the TypeScript compiler. For every database call it reports placeholder vs. parameter counts, double-quoted words that are not real table/column names, and multi-statement SQL. It is proven against a sample with planted defects. Current result: **288 call sites, 0 problems**.
- **`scripts/wrap-write-routes.ts`** is the codemod that wrapped every synchronous route that writes, directly or via `logAudit`/`resolveCategoryId`/`resolveSupplierId`, in `tx(...)`. It wrapped **49 routes** and printed a per-route list (wrap / read / skip).

## Transactions

`tx(handler)` (`server/db/transactionalRoute.ts`, 7 unit tests) makes one request one transaction:
- **throw** → rollback, HTTP 500;
- **handler answers ≥ 500** → rollback;
- **4xx** → commit, so audit rows for failed logins and blocked access are kept;
- **the response is held until COMMIT succeeds**, so a client never sees success for an uncommitted write.

This fixes partial purchases (R3) and makes every multi-step write atomic: customer create, payments, user and store changes, voids, settings, queues. Each route's audit entry is now committed together with its change.

The two async routes (MySQL dump, restore) are handled explicitly.

## Startup, migrations, restore

| | Before | Now |
|---|---|---|
| Opening | Whole file loaded into memory | Read-only integrity check first, then better-sqlite3 with WAL, `synchronous=FULL`, `busy_timeout=5000` |
| Damaged DB | Renamed, then a **silent fresh demo database** | **Startup stops** with an explanation; the file is untouched (test-proven) |
| Schema changes | ~20 `ALTER`s with ignored errors on every start | Versioned migrations: `0001` baseline (old code, verbatim), `0002` lookup indexes, `0003` restore legacy columns |
| Migration safety | none | Integrity check, **verified pre-migration backup**, per-migration transaction, row-count guard, refuses databases from a newer app version |
| Restore | Overwrote the live file, no copy, header check only | Integrity check on a temp file, **refuses non-pharmacy/empty files**, keeps a **pre-restore safety copy**, rolls back automatically if the restored file will not open |
| Shutdown | Process killed | `SIGTERM`/`SIGINT` stop the HTTP server and close the DB (WAL checkpoint) |
| Crash | Writes since the last save could be lost | Committed = durable (crash test: 25/25 acknowledged sales survived `SIGKILL`) |

## Legacy defect found during this phase

On the oldest schema (role CHECK constraint), the original app's users-table rebuild recreates `users` **without `allowed_services`**, after the `ALTER`s had just added it. The original app only recovered on its next start. Running the baseline once would have made that permanent. Migration `0003` therefore re-adds any missing legacy column, and a test asserts the full column set on every fixture.

## Still unchanged on purpose (later approved phases)

These were kept so this phase changes the storage engine and transactions only, not features:
- startup data tasks (`tenant_id` backfill, demo seeding, super-admin accounts, admin rename, invented barcodes): C4 / C11;
- the daily "backup" cron is still only a checkpoint: Phase 9;
- `foreign_keys` OFF: FK1–FK5.
