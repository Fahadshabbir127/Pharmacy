# Testing Report

This report contains only results that were actually executed. Anything not executed is listed as such.

---

## Phase 7, Batch 1: server-calculated POS and transaction safety

| | |
|---|---|
| Date | 2026-11-12 |
| Environment | Linux container (no Windows), Node 22.23.4, Electron 45.2.3 under `xvfb-run`, Playwright's Electron driver |
| Commands | `npm run lint`, `npm run audit:db-callsites`, `npm test`, `xvfb-run -a npm run test:e2e` (run twice) |
| Result | **Unit/backend: 20 files, 294 tests, all passing. Desktop end-to-end: 2 files, 26 tests, all passing on two consecutive runs (63.2 s and 61.5 s).** Lint clean; DB call-site audit: no problems. |

Decisions applied: E1 (price from the host's product record), E2 as modified (staff limit default 0 %, administrator limit a store setting up to 100 %, administrator authorization + reason above the staff limit, audited), E3 (round each line to 2 decimals; GST formula unchanged). No database migration in this batch.

### New tests
| File | Tests | Covers |
|---|---|---|
| `tests/unit/pricing-discounts.test.ts` | 11 | Shared formula: plain line; GST after line discount with per-line rounding; bill discount does not reduce GST (legacy rule); agreement with the old POS formula on 3 carts (within rounding); 100 % discount → 0; helpers. Discount limits (defaults, clamping, staff ≤ admin). Authorization grants: bound to cashier and store, maximum %, single use, expiry, malformed tokens. |
| `tests/characterization/11-server-pricing.test.ts` | 11 | Quote and sale priced from the host (tampered client price/GST ignored, GST 17 % with rounding, change returned); price changed on the host → **409 `PRICE_MISMATCH`** with server figures, **nothing written** (sales, lines, ledger, stock, idempotency keys); bill + line discount rule; 9 invalid inputs (discount −1/101/text/150 %, payment method, negative amount, cash below total, PARTIAL overpayment, non-numeric total) all refused with nothing written; CASH/PARTIAL/UDHAR amounts; staff discount without authorization → 403; administrator authorization (wrong password, non-admin authorizer, reason required, too-low %, single use, audited with authorizer and reason); administrator discount needs a reason; store limits validated, ADMIN-only, audited, store maximum binds everyone; lock after 5 wrong passwords; idempotent replay after the grant is used. |

### Legacy tests changed on purpose
| Test | Before | After |
|---|---|---|
| C9/S6 client prices | client unit price, cost and total stored | **Refused with 409 `PRICE_MISMATCH`** when the client total differs; without a client total the sale is priced from the host (Rs. 220 x 5 = 1100) |
| Durability (55-request burst, crash points) | traced each request by a client-supplied price marker (only possible because of C9) | traced by its transaction id, stored in the same transaction as the sale; same checks (no partial rows, no duplicates, acknowledged sales present) |
| Atomicity (mid-sale failure) | malformed line → 500 | malformed lines are 400 before any write; the mid-way failure is injected by a test-only hook (`PHARMACY_TEST_THROW=sale-after-line-1`) after line 1 is fully written → 500, complete rollback |
| Protocol in `09-desktop-backend`, `10-batch-inventory`, standalone E2E | 2 | 3 |

### Desktop end-to-end additions (real UI)
- Standalone: a price changed on the host while the cart is open → the payment screen shows "Prices were updated" and the **server total (Rs. 180.00)**; the sale is charged that amount.
- Standalone: a **staff cashier** gives 10 %; the payment screen requires a reason and an administrator; a wrong password is refused; after authorization the server total (Rs. 279.00) is charged; audit log has the override and the failed attempt.
- Host + client: a price changed on the host while the **client's** cart is open → the client shows and charges the host price; host and client return identical sale records.
- Phase 6 test adjusted: the "another counter sold the last unit" refusal now appears **when the payment screen opens** (the server preview checks stock), before any money is taken; the cart is kept as before.

### Defect found and fixed during Batch 1
| Defect | Found by | Status |
|---|---|---|
| The new price preview also checks stock; a shortage first appeared as a preview error instead of the Phase 6 refusal dialog | Phase 6 E2E regression | Fixed: a stock refusal at preview closes the payment screen with the same dialog, keeps the cart and refreshes stock |
| Legacy (found while implementing): CASH with less money than the bill was stored as a part-paid sale with no customer (the debt was lost); more money than the bill made the amount due negative | review | CASH must cover the bill (change returned, `change_due`); PARTIAL cannot exceed the bill |

### Not executed / limits (Batch 1)
| Area | Status |
|---|---|
| **Windows hardware** | **Not executed for Batch 1.** All results above are Linux. |
| Two physical computers | Host/client E2E ran on one machine over 127.0.0.1 |
| Discount authorizations after a host restart | By design they are kept in memory only and lost on restart (the cashier asks again); not tested on Windows |
| A grant used by a sale that then fails with 500 | The grant is used up (documented); the cashier asks again. Not E2E-tested. |

---

## Phase 6: batch inventory, FEFO, no overselling, expiry rules

| | |
|---|---|
| Date | 2026-11-12 |
| Environment | Linux container (no Windows), Node 22.23.4, Electron 45.2.3 under `xvfb-run`, Playwright's Electron driver |
| Commands | `npm run lint`, `npm run audit:db-callsites`, `npm test`, `xvfb-run -a npm run test:e2e` (run twice) |
| Result | **Unit/backend: 18 files, 272 tests, all passing. Desktop end-to-end: 2 files, 23 tests, all passing on two consecutive runs (58.9 s and 60.1 s).** Lint clean; DB call-site audit: no problems; no stray Electron/backend processes after the runs. |

Approved decisions D1–D7 are implemented as documented: D1 product edit cannot change stock (409 `STOCK_NOT_EDITABLE`); D2 the POS price is charged unchanged, the batch sale price is stored and shown; D3 sellable up to and including the expiry date, month-only expiry = last day of the month; D4 negative legacy stock migrated as 0, recorded in `inventory_migration_issues` and the audit log, reported at startup; D5 batches without expiry are sellable, sold after dated batches, flagged "no expiry"; D6 new sales record the weighted real batch cost; D7 `API_PROTOCOL` = 2.

**Test-only date.** Expiry rules depend on "today". Tests set `PHARMACY_TEST_TODAY=2026-06-01` (backend helper and Electron E2E launcher) so the demo catalogue's 2026 expiry dates cannot change test outcomes as the calendar moves. The backend prints a WARNING at startup whenever the variable is set, and the host status screen shows it (tested). The desktop app never sets it.

### Database-level protection (what stops overselling even if a code path is wrong)
- `product_batches.qty_on_hand` has `CHECK (qty_on_hand >= 0)`: SQLite itself refuses negative stock.
- Triggers keep `products.stock` = sum of its batches; guard triggers **reject any direct write** to `products.stock` (`STOCK_GUARD`). Unit-tested: direct `UPDATE`, `INSERT` with stock ≠ 0, the CHECK constraint, and trigger sync.
- Every batch decrement is guarded (`UPDATE … SET qty_on_hand = qty_on_hand - ? WHERE id = ? AND qty_on_hand >= ?`); if it changes 0 rows the whole sale rolls back.
- The FEFO plan and all validation run **before** the first write (a 4xx answer commits in `tx()`, so nothing may be written before a refusal).

### New and changed tests (`npm test`)

| File | Tests | Covers |
|---|---|---|
| `tests/unit/fefo-expiry.test.ts` (new) | 18 | Expiry normalisation (`YYYY-MM-DD`, `YYYY-MM`, `MM/YYYY`; ambiguous `05/10/2027` not guessed), D3 boundary, FEFO order (expiry, undated last, id), multi-batch split, shared pool for repeated lines, expired skipped, `INSUFFICIENT_STOCK` vs `EXPIRED_STOCK`, weighted cost |
| `tests/unit/batch-migration.test.ts` (new) | 14 | Migration 0007 on all 7 legacy fixtures + the new `inventory-edge-cases` fixture generated by the **original** app: per-product stock and totals unchanged, history untouched, one MIGRATION batch per product with stock, issues recorded (negative, fractional, unreadable expiry) **and D4 audit rows**, FK check clean; guard triggers and CHECK; injected failure rolls back completely; **SIGKILL inside migration 0007** leaves version 6 and the restart migrates cleanly |
| `tests/characterization/10-batch-inventory.test.ts` (new) | 20 | API: FEFO across batches with sale-detail allocations and weighted cost; repeated product lines; D3 (expired yesterday, month-only, today inclusive) and D5; refused sale writes nothing (no header, ledger, stock, idempotency key); invalid quantities and archived product; idempotent replay keeps one allocation; void returns units to the exact batches; void of a pre-batch sale → VOID_RESTORE batch; purchase validation (8 cases, nothing written); purchase batches + links + history; D1; batch corrections (ADMIN only, reason, no quantity edit, audited); per-batch adjustments and history; expiry report and dashboard; product delete with batches. **Concurrency:** 50 simultaneous sales over HTTPS (host mode, 3 paired clients, 2 users) racing for the last 12 units across 2 batches: no 500s, never oversold, stock never below 0, allocations = units sold, FEFO kept, invariant check clean. **Crash:** SIGKILL before COMMIT and after COMMIT of a 2-batch UDHAR sale: batches, allocations, product stock and ledger consistent; the restarted server sells normally. Startup warning and host-status inventory report. |
| `00-startup`, `02-sales`, `03-inventory-purchases-customers`, `08-archiving`, `09-desktop-backend` | updated | See "Legacy tests flipped" below; new tables in the schema list; protocol 2 |
| `06-legacy-fixtures` | updated | 8 fixtures (new `inventory-edge-cases`) |

### Legacy tests flipped on purpose (old defect → fixed behaviour)

| Test | Before | After |
|---|---|---|
| C2/R5 overselling | 200, stock clamped to 0 | **409 `INSUFFICIENT_STOCK`**, nothing recorded |
| C6/R6 purchase | overwrote the product's batch, expiry and cost | **new batch**; the older batch keeps its number, expiry and cost |
| Adjustment REMOVE too much | clamped to 0 but recorded the full quantity | **409 `INSUFFICIENT_BATCH_STOCK`**, nothing recorded; REMOVE requires the batch |
| Ghost product sale (FK5) | 500 from the foreign key | **400 `PRODUCT_NOT_FOUND`** from validation, before any write |
| Purchase with a bad 2nd line (R3), unknown supplier | 500 + rollback | **400**, nothing written |
| C9 cost | client-supplied `cost_price` stored | **cost from the batch** (D6). Client prices/totals are still trusted until Phase 7 (C9) |
| Mid-sale failure (atomicity) | malformed line → 500 | malformed line is now a 400; the mid-way failure is produced by an unstorable value in the 2nd line's INSERT → 500, full rollback (still tested) |

### Desktop end-to-end (`npm run test:e2e`), Phase 6 additions
Standalone app, real UI:
- **Purchase through the Purchases screen** (batch, mfg date, expiry) creates a new PURCHASE batch; the older batch is unchanged.
- **POS sale of 5 spanning two batches**: 3 from the earlier-expiring batch, 2 from the next; the **receipt lists both batches**; sale detail allocations match; product shows the next FEFO batch.
- **Expired stock cannot be put in the cart** (clear message). **Server refusal (409) in the UI:** two units in the cart, another counter sells one meanwhile; completing the sale shows "Sale not saved … 2 requested, 1 available", **the cart is kept**, and the corrected sale goes through.
- **Inventory screen:** batches panel (empty batches hidden/shown), expiry tracker lists the expired batch, **write-off of the expired batch** through the adjustment dialog (batch picker, reason "Expired").
- Restart: all sales, batch quantities and stock persist.

Host + client (two real app instances):
- A **client UI sale spanning two batches** is allocated on the host; host and client show identical batch quantities.
- **Host and client sell the last unit at the same moment:** exactly one 200 and one 409 `INSUFFICIENT_STOCK`; stock 0 on both computers.
- All Phase 4 LAN tests (pairing, crash after COMMIT + "Check status", host switched off) still pass with the batch model.

### Defects found and fixed during Phase 6

| Defect | Found by | Status |
|---|---|---|
| Batch history used a column that does not exist (`sales_headers.created_at`) → 500 | new API test | Fixed (`sale_date`) |
| Deleting a product without history but with stock failed on the new foreign key | existing characterisation test | Fixed: its batches are removed with it (audited with the quantity) |
| Purchases screen pre-filled the product's current batch number and expiry, which would have created duplicate batches or been refused as expired | review during UI work | New lines start empty; batch, mfg date, expiry, cost and sale price are entered per line |
| Purchases screen checked "already expired" against the **local** computer clock; a LAN client's clock can differ from the host | E2E (fixed test date vs real date) | Date-dependent checks are left to the server (the pharmacy's date); the screen checks only quantity, price and mfg ≤ expiry |
| Editing a product sent the stock value back, so a sale made meanwhile would have caused a false 409 | review of D1 | The edit form no longer sends stock, batch or expiry |
| Test only: after a page reload "Print on Save" is ON again and the native print dialog blocked the window | E2E | Test helper turns it off after each reload |

### Not executed (honest list for Phase 6)

| Area | Status |
|---|---|
| **Anything on real Windows hardware**: the batch screens, purchase entry, POS refusal messages, receipts with batch lines, migration 0007 on a real customer database copy, performance with large catalogues | **Not executed.** All results above are from Linux. |
| Migration 0007 on a **real** pharmacy database | Not executed: only synthetic databases produced by the original application (8 fixtures). The pre-migration backup and the rollback/crash safety are tested. |
| Real multi-computer LAN race (two physical PCs, Wi-Fi) | Not executed. The simultaneous host+client sale ran on one computer over 127.0.0.1; the 50-sale race ran over HTTPS on loopback. Paired-client tokens are not enforced on loopback (by design), so the race shows concurrency safety, not token enforcement. |
| Thermal printer output of receipts with several batch lines | Not executed (no printer). Checked on screen only. |
| Long time-travel (real calendar passing an expiry date while the app runs) | Simulated with `PHARMACY_TEST_TODAY`; not observed over real days. |
| Very large inventories (performance of the batch summary per product) | Not measured. |

---

## Phase 4: desktop app, FK1–FK5, first-run setup, HTTPS LAN host/client

| | |
|---|---|
| Date | 2026-11-09 |
| Environment | Linux container (no Windows), Node 22.23.4, **Electron 45.2.3** under `xvfb-run`, Playwright's Electron driver |
| Commands | `npm test` (unit + backend), `xvfb-run -a npm run test:e2e` (builds UI + desktop runtime, then drives the real app) |
| Result | **Unit/backend: 15 files, 220 tests, all passing. Desktop end-to-end: 2 files, 17 tests, all passing on two consecutive runs.** `npm run lint` clean; `audit:db-callsites` 0 problems; no stray processes after the runs. |

### What the desktop end-to-end tests do (real app, real UI, real backend in Electron's utilityProcess)

**Single computer, `standalone.e2e.ts` (12 tests).**

First run and data layout:
- First start opens the setup wizard; no demo login works.
- Wizard flow: "Single computer", "Start a new pharmacy", create the administrator with the demo catalogue, open the pharmacy.
- The login screen shows the pharmacy's own name.
- `config.json`, `data/pharmacy.sqlite`, the certificate, its key and the logs are all in the data folder.

Security:
- The page has no `require`, `process` or `module`. `window.braintech` is frozen, with the exact expected keys.
- The sandboxed preload bundle requires only `electron`.
- Navigation to a website is blocked, and `window.open` to a website is refused.
- An `about:blank` print popup **cannot call the privileged API**.
- HTML responses carry a strict Content-Security-Policy.
- API traffic goes through the pinned HTTPS proxy.

POS through the real UI:
- Sign in, type a batch number, press Enter, CASH, "Complete Sale & Print Receipt".
- The receipt is built from the **saved** sale, `Invoice_INV-1-n.txt` is saved, and stock drops by 1.
- The same `client_txn_id` sent twice through the desktop proxy records one sale.

Restart:
- Closing and reopening goes straight to the pharmacy; every sale and the stock level are still there.

**Host + client, `lan.e2e.ts` (5 tests).** Two app instances with separate data folders.

Pairing:
- The host shows its address, port and pairing code.
- With a **wrong code, the client itself rejects the host's proof**.
- With the right code it pairs, and the host lists "Billing Counter".
- The client keeps **no database** and stores the pinned fingerprint.

Shared data:
- The client signs in with the host's account and sees the host's 12 products.
- A **cash sale made in the client UI** reduces the host's stock and appears in its register.
- A stock adjustment on the host is visible on the client.

Host crash **after COMMIT, before the reply** (one-shot test crash point):
- The client shows **SALE NOT CONFIRMED** and keeps the cart.
- The host's supervisor restarts its backend by itself, and the client reconnects.
- **"Check status" finds the sale**, the receipt appears, and stock dropped **exactly once**.

Host computer closed:
- The client shows the blocking "Pharmacy server unreachable" overlay, and API calls answer 503 `HOST_UNREACHABLE` / outcome `UNKNOWN`.
- When the host restarts, the client reconnects by itself and the overlay disappears.

### New backend tests (`npm test`)

| File | Tests | Covers |
|---|---|---|
| `08-archiving.test.ts` | 9 | FK2/FK3: archive product, customer, user, supplier, store with history; hidden from lists and counts, still on invoices, reports and ledgers; archived logins blocked; unique values reusable; no re-assignment of a user's sales; FK enforced at runtime |
| `09-desktop-backend.test.ts` | 13 | First-run admin (C4): weak password, duplicate, loopback-only, no demo logins, demo catalogue without accounts. Health endpoint, idempotent sales and status lookup. HTTPS-only host: plain HTTP refused, wrong pin refused, **real non-private address refused**. Local admin token. Pairing (wrong code, right code, token hash stored, revoke). **Impostor certificate relaying the real host's answers fails even with the right code.** Standalone refuses network requests. |
| `lan-guard-pairing.test.ts` | 15 | Address ranges; guard decisions with simulated private/public addresses and valid/revoked/missing client tokens; pairing proofs, replay, code rotation and expiry; certificate SANs, validity and fingerprint; JWT secret file; UDP discovery (answer, junk ignored, none found) |
| `07-durability.test.ts` | +2 | Every interrupted sale traced individually; deterministic crash **inside** the transaction (sale fully absent) and **after COMMIT** (sale fully present) |
| `migrations.test.ts`, `fk-audit.test.ts` | updated | All 7 old-format databases: placeholders with the exact missing ids, every original row kept, totals identical, `foreign_key_check` empty, enforcement ON; a new unresolved violation stops startup |

### Crash test (approval condition 5)

- **Random hard kill during a burst** (run in every full-suite run, more than 5 times): 25 acknowledged sales were all present. The 30 interrupted requests were each either fully committed or fully absent; most runs were 0 committed / 30 rolled back, and one run was 1 / 29. There were **0 partial rows and 0 duplicates** across header, line, balance and ledger.
- **Deterministic crash points** make the two hard cases certain, not luck: a crash *inside* the transaction leaves nothing, and a crash *after COMMIT* leaves the complete sale.

### Defects found and fixed during Phase 4

| Defect | Found by | Status |
|---|---|---|
| **Certificate pin not enforced**: Node skips `checkServerIdentity` for self-signed certificates | wrong-pin test | Fixed: the pin is checked on the socket before sending |
| Bundled backend crashed at load (`node-cron` uses `import.meta.url`) | first desktop launch | Fixed in the build |
| That fix broke the sandboxed preload (`window.braintech` missing) | E2E wizard test | Fixed; regression test added |
| A startup database error showed a blocking dialog before any window existed | E2E | Now shows the settings page with the reason |
| UI claimed "SQLite: Encrypted (WAL)"; the database is **not** encrypted at rest | screenshot review | Label corrected |
| Receipts and purchase orders printed another store's address, phone, NTN and a **made-up drug licence number** when the pharmacy had not set its own | screenshot review | Only the pharmacy's own settings are printed |
| Legacy: deleting a user re-assigned their sales to user #1; system emails used fake customer ids (PO emails used the supplier id) | FK work | Fixed |
| Legacy: first boot left every seeded row without a store (`tenant_id NULL`) | Phase 2 finding | Fixed |

### Not executed (honest list)

| Area | Status |
|---|---|
| **Windows**: install, run, uninstall, SmartScreen, Firewall prompts, ProgramData permissions, DPAPI | **Not executed.** No Windows machine; installer is Phase 11 (GitHub Actions `windows-latest`). |
| Real multi-computer LAN, Wi-Fi drop, router restart, DHCP address change | **Not executed.** Both instances ran on one Linux computer over 127.0.0.1. |
| Client-token enforcement for real LAN addresses | Unit-tested with simulated addresses only (loopback bypasses it by design) |
| UDP discovery between computers | Unit-tested over loopback only; the container's network is not a private LAN |
| Printers (Windows, thermal, preview), USB barcode scanners, webcams | **Not executed** (no hardware). Camera permission policy is implemented; native printing IPC exists; the existing `window.print()` paths are kept. |
| `safeStorage` on Windows | Not executed. On this Linux test system it reported encryption available. |
| Long-running stability, memory | Not executed |

---

## Phase 3: database layer (better-sqlite3), migrations, transactions, FK audit

| | |
|---|---|
| Date | 2026-11-08 |
| Command | `cd Medical-Pharmacy-Management-System-master && npm test` |
| Result | **12 files, 178 tests, all passing on two consecutive full runs.** `npm run lint` is clean, `npm run audit:db-callsites` reports 288 call sites and 0 problems, and `npm run build` succeeds. The bundled `dist/server.cjs` was started, served a login and shut down cleanly. |

| New test file | Tests | Covers |
|---|---|---|
| `tests/unit/db-adapter.test.ts` | 22 | Parameter rules, pragmas (WAL, FULL sync, busy_timeout, FK OFF), commit/rollback, nested savepoints, busy-lock behaviour, online backup, `serialize()` includes WAL data, damaged files |
| `tests/unit/transactional-route.test.ts` | 7 | Commit-then-respond, rollback on throw and on 5xx, keep 4xx audit writes, failed COMMIT never sends success |
| `tests/unit/migrations.test.ts` | 22 | **All 7 legacy fixtures migrated on copies:** every row count and money/stock/ledger total unchanged, verified pre-migration backup, originals byte-identical, full legacy column set. Failure cases: corrupt or non-DB file refused untouched, row-deleting migration rolled back, throwing migration rolled back, backup failure blocks migration, newer-version DB refused. Copy-only import (source byte-identical, no overwrite, corrupt/non-pharmacy refused, repo sample refused and untouched). |
| `tests/unit/fk-audit.test.ts` | 11 | Audit is read-only; orphan findings per fixture; what breaks if FK enforcement were switched on |
| `tests/characterization/07-durability.test.ts` | 2 | `SIGKILL` during a burst of concurrent sales: **25/25 acknowledged sales survived**, 30 in-flight requests were interrupted, no partial sale, stock equals stored sales, integrity ok (3 standalone runs + 2 full-suite runs, identical) |

**Characterisation tests changed on purpose.** Each was relabelled `[FIXED …]` with its old behaviour noted in a comment:
- R3: a failed purchase is now fully rolled back.
- R10: a damaged DB stops startup and the file is left untouched.
- S8: restore keeps a verified pre-restore safety copy.
- Schema test: the `schema_migrations` table and WAL mode are expected.
- R11: the daily job is still not a real backup (Phase 9); its source check was updated.

**New tests added:**
- a damaged backup is refused;
- an empty or non-pharmacy SQLite file is refused by restore.

The second closes a gap that existed in the original code too: it only checked the file header, so "restoring" an empty database would silently wipe all data. All other 105 Phase 2 tests pass unchanged.

**Defects found in Phase 3:**
- **Legacy (original app):** on the oldest schema the users-table rebuild drops `users.allowed_services` until the next start. Migration `0003` handles it, and a test records the legacy behaviour.
- **Legacy (original app):** restore accepted any SQLite file, including an empty one. Now refused.
- **Introduced during this phase and fixed before commit:** the restore integrity check left empty `-wal`/`-shm` side files behind. They are now removed, and a test asserts no leftovers.

Foreign keys: see `FK_AUDIT_REPORT.md`. Enforcement stays OFF pending approval of FK1–FK5.

---

## Phase 2: baseline characterisation suite (original application, before functional changes)

| | |
|---|---|
| Date | 2026-11-08 |
| Code under test | `server.ts` and `src/lib/api.ts` at audited revision `ec90af3` (unchanged) |
| Environment | Linux container, Node 22.23.4, npm 10.9.9, vitest 3.2.4. Not Windows (see "Not executed"). |
| Command | `cd Medical-Pharmacy-Management-System-master && npm test` |
| Result | **7 files, 111 tests, all passing** on two consecutive full runs (~147 s each). `npm run lint` (tsc) is clean. |

### How the suite works

- **`tests/helpers/server.ts`** starts the real backend (`tsx server.ts`, `NODE_ENV=production`) as a child process in a **fresh OS temp directory**. The server's `process.cwd()/data` database is therefore always a throwaway file. No test touches the repository's `data/` folder or any real pharmacy database.
- **`tests/helpers/db.ts`** inspects databases read-only by loading a copy into memory with sql.js. `editDbFile()` (used once, to plant an expired OTP) refuses to write anything outside the OS temp directory.
- **Tags.** Tests tagged `[LEGACY-BUG …]`, `[LEGACY-SECURITY …]` or `[CHANGE Cn]` deliberately assert *today's* defective behaviour, so the baseline is green. When a later phase fixes a defect, its tagged test is flipped in the same commit. Untagged tests are regression guards and must keep passing unchanged.
- **Fixed port.** The original server hardcodes port 3000, so test files run sequentially (`fileParallelism: false`).
- **Frozen original.** `tests/legacy/server.original.ts` is a byte-identical copy of the audited `server.ts`, pinned by SHA-256 in a test. It is used **only** to generate legacy databases, so migration tests in later phases always use databases made by the real old code.

### Suite contents

| File | Tests | Covers |
|---|---|---|
| `00-startup.test.ts` | 11 | Empty-dir start, schema (17 tables), seed data, persistence across restart, startup data rewrites, corrupt-DB handling, CORS |
| `01-auth-security.test.ts` | 19 | Login, 7-day tokens, lockout, role checks, forged tokens, settings exposure, `allowed_services`, customer IDOR guard, OTP registration and login, OTP replay, rate limit, OTP expiry |
| `02-sales.test.ts` | 18 | Cash, udhar and partial sales; ledger; notification queues; oversell; price tampering; duplicate posts; invoice-number collisions; ghost products; atomicity/rollback; void; 20 parallel sales; history |
| `03-inventory-purchases-customers.test.ts` | 21 | Product CRUD, filters, sanitising, invented barcodes, adjustments, categories, suppliers, purchases (batch overwrite, non-transactional), customers, payments, deletes, reminders |
| `04-admin-backup-reports.test.ts` | 24 | Dashboard and reports, email/SMS "process", settings, encrypted backup export/import, raw restore, MySQL dump, users lifecycle, token revocation on suspend, audit logs, super admin and tenants, tenant isolation, integrity after many writes |
| `05-offline-queue.test.ts` | 8 | Real `src/lib/api.ts` offline queue with mocked fetch and storage; BillingScreen fallback, scanner timing and camera (source checks) |
| `06-legacy-fixtures.test.ts` | 10 | Original-code checksum, 7 generated legacy DBs with manifest, FK-orphan facts, pre-tenant schema migration by the original code, corrupt-sample read-only report |

### Synthetic legacy databases (`npm run fixtures:legacy`)

These are generated into `tests/.fixtures/legacy/` (git-ignored), each with `manifest.json` entries for row counts, stock, balance and sales sums, integrity results and FK violations.

| Fixture | How it was made | Key facts |
|---|---|---|
| `fresh-first-boot` | Original app, started once | All seed rows `tenant_id NULL` |
| `after-restart` | Started twice | `tenant_id` backfilled; invented barcodes |
| `busy-store` | 40 sales (cash/udhar/partial, discounts), 15 products, 8 customers, 5 purchases, 2 adjustments, 1 payment, 1 void | Stock sum 1050, balances 9183.39, sales 22454.17 |
| `multi-tenant` | 3 stores created by SUPER_ADMIN, 1 deleted | FK orphans: `sale_items→products` (3), `sale_items→sales_headers` (3) |
| `orphans` | Deleted product with sales history; deleted customer with an invoice; SMTP test row | FK orphans: `sale_items→products`, `sales_headers→customers` |
| `pre-tenant-raw` | Hand-built oldest schema (role CHECK; no tenant/email/status/barcode columns) | Never opened by the app |
| `pre-tenant-migrated-by-original` | `pre-tenant-raw` after one start of the original app | All business rows and sums preserved; **2 SUPER_ADMIN accounts injected** |

No anonymised real customer database was available, so these synthetic files are the migration inputs for Phase 3, as you approved.

**Repository sample** `data/khushi_pharmacy.sqlite.corrupt.1785024578279`: read through a copy, it fails with "database disk image is malformed", including `sqlite_master` itself. No tables are recoverable with the available tooling. The original file was verified byte-identical before and after (SHA-256).

---

## Existing defects found by the baseline (confirmed by executed tests)

New items not already listed in `PROJECT_AUDIT.md` are marked **NEW**.

### Data integrity / money

| ID | Defect | Test |
|---|---|---|
| R1 / C3 | A sale whose response is lost is queued offline and re-posted with no idempotency, so **the server records it twice**. A sale rejected with HTTP 400 stays queued and is retried forever. **Any** API error, not only network failure, prints a receipt with an `OFFLINE-…` number. | `05` |
| C3 | Posting the same sale twice creates two invoices and deducts stock twice | `02` |
| R4 | Deleting an older invoice makes **all later sales fail** (HTTP 500, UNIQUE constraint on invoice number). Deleting the newest invoice re-issues its number to a different sale. | `02` |
| C2 / R5 | Overselling accepted; stock clamped to 0 | `02` |
| C9 / S6 | Server stores client-supplied price, cost and total (Rs 1 sale of a Rs 220 item at cost 0 accepted) | `02` |
| C6 / R6 | A purchase overwrites the product's batch, expiry and purchase price; the expiry of older stock is lost | `03` |
| R3 | Purchases are not transactional: a failing second line leaves the header, the first line and its stock increase | `03` |
| **NEW** | Sale referencing a non-existent product ID is accepted and recorded | `02` |
| **NEW** | Deleting a product makes its lines **disappear from past invoices** (inner JOIN); the invoice total no longer matches its items | `02` |
| **NEW** | Deleting a zero-balance customer **erases their whole ledger**, removes their login, leaves their invoices pointing at a missing customer, and writes **no audit entry** | `03` |
| **NEW** | Deleting a store (tenant) leaves orphaned `sale_items` (and other child rows) | `06` |
| **NEW** | Customer payment larger than the balance makes the balance negative, with no guard or warning | `03` |
| **NEW** | Stock adjustment REMOVE larger than stock clamps to 0 but records the full requested quantity | `03` |

### Startup / first-run

| ID | Defect | Test |
|---|---|---|
| **NEW** | On the **first start**, every seeded row (users, products, sales, customers, settings…) gets `tenant_id NULL`, because the backfill runs before seeding. Consequences until the app is restarted: the store admin's **audit log screen is empty**, the demo sale is missing from the sales register, the first invoice number restarts at `INV-1-1001`, and a **second store sees store #1's products** (NULL rows are visible to every tenant). | `00`, `02`, `04` |
| C11 | Barcodes `8901000000NNN` are invented for products without one: on the second start for seeded products, immediately for new products | `00`, `03` |
| R8 | The `admin` user's full name is overwritten to "Muhammad Asghar (Owner)" on every start | `00` |
| R10 | A corrupt database is renamed and a fresh demo database with default logins starts **silently** | `00` |
| R11 | The "daily backup" job only re-saves the live file | `04` |
| S8 | Restore keeps no safety copy of the database it replaces | `04` |

### Security

| ID | Defect | Test |
|---|---|---|
| S1 | Token forged with the public hardcoded secret is accepted, **and its role claim is trusted** (STAFF → ADMIN) | `01` |
| S2 | `superadmin`/`admin123` and a personal-email SUPER_ADMIN are force-created, **including into an existing customer database during upgrade** | `00`, `06` |
| S3 | Demo logins `admin/admin123`, `staff/staff123`, `customer123` | `00` |
| **NEW** | Every customer created by staff gets a portal login with the default password `customer123` | `03` |
| S4 | OTP codes returned in API responses (registration and login OTP; login OTP grants SUPER_ADMIN) | `01` |
| **NEW** | An expired OTP is still accepted until UTC midnight (ISO `T` vs SQLite space text comparison) | `01` |
| **NEW** | `send-login-otp` reveals whether an account exists (404 vs 200) | `01` |
| S5 | `Access-Control-Allow-Origin: *` | `00` |
| S9 | STAFF can read SMTP and Twilio secret fields | `01` |
| S11 | `allowed_services` restrictions are UI-only; the API still serves the routes | `01` |
| **NEW** | The CUSTOMER role can read the full inventory, including purchase (cost) prices | `01` |
| **NEW** | An ADMIN of **any** store can clear the audit log of **every** store | `04` |

### Correct behaviours confirmed (must be preserved)

These all passed as regression guards:
- login lockout after 5 failures;
- suspended user's existing token rejected immediately;
- tenant suspension blocks store users;
- customer IDOR guard on invoices;
- OTP single use and rate limit;
- self-registration cannot obtain ADMIN and starts PENDING;
- sale transaction rolls back stock and balance on error;
- 20 parallel sales give exact stock and unique invoice numbers;
- encrypted backup round-trip with wrong-password rejection;
- MySQL dump;
- HTML/script stripping in names;
- duplicate category returns the existing one;
- duplicate customer phone rejected;
- customer with debt cannot be deleted;
- integrity_check clean after many writes.

---

## Not executed in Phase 2

| Area | Why | Plan |
|---|---|---|
| Windows install/run, NSIS, portable | No Windows machine here; packaging not built yet | Phase 11 GitHub Actions `windows-latest` |
| UI rendering and clicks (React screens) | Phase 2 covers backend and API behaviour plus the offline-queue module; no browser E2E yet | Playwright against the Electron app in Phase 4+ |
| Printers, USB scanners, webcams | Hardware | Manual procedures in Phase 12 |
| Multi-PC LAN, Wi-Fi drop, router restart | Hardware/network | Manual procedures; two-instance automated tests in Phase 5/8 |
| Real customer databases | None provided | Synthetic fixtures above; the owner may supply anonymised copies later |
| Power-loss durability of sql.js | Requires killing the process mid-write | Covered after the better-sqlite3 switch (Phase 3) with kill-during-write tests |
