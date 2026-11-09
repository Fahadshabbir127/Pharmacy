# Testing Report

This report contains only results that were actually executed. Anything not executed is listed as such.

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
