# Architecture: BrainTech Pharmacy AI (desktop, offline-first, LAN host/client)

Status: approved design (Phase 1). **Implemented through Phase 4**; see §17 for what was built and where it differs from the design. The current system is described in `PROJECT_AUDIT.md`.

| | |
|---|---|
| Product | BrainTech Pharmacy AI |
| App ID | `com.braintech.pharmacy` |
| Installer | `BrainTech Pharmacy AI Setup.exe` |
| Portable | `BrainTech Pharmacy AI Portable.exe` |
| Platform | Windows 10/11 x64 (the minimum is set by the Electron version; confirmed in CI) |
| Stack kept | React 19 + Vite UI, Express backend (no rewrite), SQLite file format |
| Changed | sql.js → better-sqlite3; Electron shell added |

## 1. Process model

```
┌──────────────────────── Electron main process ─────────────────────────┐
│ single-instance lock · window mgmt · config.json · logs · supervisor    │
│                                                                         │
│  app://braintech/*  ── protocol.handle ──┬─ static: bundled dist/ UI    │
│                                          └─ /api/* ─► net.fetch HTTPS ──┼──► backend (local or host)
│                                             (pinned cert fingerprint,   │     
│                                              Authorization forwarded)   │
│  ipcMain (allow-listed channels, sender = app://braintech, zod-checked) │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ utilityProcess.fork (standalone / host only)
               ▼
┌──────────── Backend (Express, Electron's bundled Node) ─────────────────┐
│ HTTPS listener (per-install cert) · LAN guard · auth · routes · SSE bus │
│ DB adapter (better-sqlite3, WAL) · migrations · backup engine · cron    │
└──────────────┬──────────────────────────────────────────────────────────┘
               ▼
   %PROGRAMDATA%\BrainTechPharmacyAI\data\pharmacy.sqlite (+ -wal, -shm)
```

- **No Node.js is needed on customer PCs.** The backend bundle `dist-electron/server.cjs` runs inside Electron's own Node via `utilityProcess`.
- **Supervision.** The backend is restarted with exponential backoff (1 s → 30 s) if it exits. After 5 failures in 2 minutes the app shows an error screen with log location and recovery steps; it never silently starts an empty DB.
- **Graceful shutdown.** On quit, main tells the backend to stop. The backend refuses new writes, finishes in-flight transactions, checkpoints WAL and closes the DB, with a 10 s timeout before kill. If a sale is being submitted, the window asks for confirmation before closing.

## 2. Modes

| Mode | Backend | Listens on | DB | UI talks to |
|---|---|---|---|---|
| **Standalone** | local | `127.0.0.1:<free port>` HTTPS | local | local backend |
| **Host** | local | private LAN interfaces + loopback, port default **3747** HTTPS | local (authoritative) | local backend |
| **Client** | **none** | n/a | **none** | host backend over pinned HTTPS |

The mode, host address, pinned fingerprint and port are stored in `%PROGRAMDATA%\BrainTechPharmacyAI\config.json`. Secrets are not stored there.

## 3. Trusted UI and request path

- The renderer **only** loads the UI that ships with the installed app: `app://braintech/index.html`, a privileged and secure custom scheme. It never loads pages served by a host, so a compromised or spoofed host cannot run code that has access to the preload API.
- `src/lib/api.ts` keeps relative `'/api'` URLs, which resolve to `app://braintech/api/...`. Main forwards these to the active backend with `net.fetch`, verifying the backend's certificate against the **pinned SHA-256 fingerprint** via a dedicated session's `setCertificateVerifyProc`.
- **Same origin:** no CORS in the renderer, no TLS logic in the renderer.
- **Downloads** (Excel, `.kmhbackup`, SQL dump) are handled by `session.on('will-download')` with a native save dialog.

## 4. Electron security baseline

| Control | Setting |
|---|---|
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `nodeIntegration` / `nodeIntegrationInWorker` | `false` |
| `webSecurity` | `true` |
| CSP | `default-src 'self' app:; img-src 'self' data: blob:; media-src mediastream: blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'` |
| Navigation | `will-navigate` / `will-redirect`: only `app://braintech/*` |
| New windows | `setWindowOpenHandler`: only `about:blank` (existing print popups), opened with no preload, sandboxed; everything else denied |
| External links | allow-list `https://wa.me/*`, `https://api.whatsapp.com/*`, `sms:`; confirmation dialog, then `shell.openExternal` |
| Permissions | `setPermissionRequestHandler`: `media` (camera) only for `app://braintech`; everything else denied |
| IPC | each `ipcMain.handle` checks that `event.senderFrame.url` starts with `app://braintech/` and validates arguments with zod; unknown channels are rejected |
| Filesystem | renderer never supplies paths; main opens dialogs and keeps the chosen paths internally (backup folder, restore file, legacy DB import, logo image) |
| Devtools | disabled in production builds |
| Updates | manual installer upgrade (same appId keeps data); auto-update is out of scope for v1 and documented |

**Preload API** (`window.braintech`), complete list:
- `getAppInfo()`, `getConnectionState()`, `onConnectionState(cb)`
- `setup.*`: choose mode, discover hosts, pair with host, test connection
- `server.status()` (host only): IPs, port, client count, DB status, last backup, fingerprint, pairing code
- `backup.*`: run now, choose external folder, choose restore file, restore, list history
- `printers.list()`, `print.html({html, printer, paper, silent})`
- `files.importLegacyDatabase()`, `files.chooseLogo()`

## 5. Transport security (HTTPS everywhere)

- On first start in standalone or host mode, the backend generates a per-installation **ECDSA P-256** key and a self-signed certificate.
  - SANs: computer name, `localhost`, `127.0.0.1`, all current private IPv4 addresses.
  - Validity: 5 years.
  - Stored in `certs\`; the key is encrypted at rest with Electron `safeStorage` (DPAPI), and the file ACL is restricted.
- There is **no plaintext HTTP listener**. JWTs, passwords and pharmacy data never cross the network unencrypted.
- **Clients verify by pinned fingerprint, not by hostname.** DHCP IP changes therefore do not break trust, and SAN mismatches do not matter.

### Pairing (client trusts host)

1. The host's Server screen shows an 8-character pairing code (rotates every 10 minutes or on demand) and a short certificate fingerprint.
2. The client enters the host IP and port (or picks one found by discovery) and the code.
3. The client opens TLS **without** trust, reads the presented certificate fingerprint `F`, and sends `clientNonce`.
4. The host answers `HMAC(code, "host" ‖ clientNonce ‖ serverNonce ‖ F_host)`. The client recomputes with its observed `F`. A mismatch means a wrong code or a man in the middle, and pairing is aborted.
5. The client proves its own knowledge of the code with `HMAC(code, "client" ‖ serverNonce ‖ clientNonce)`. The host registers the client (name, first seen) and audits the event.
6. The client pins `F`. Any later certificate mismatch shows a blocking "Host certificate changed, re-pair required" screen; it never silently trusts the new certificate.

### Certificate renewal

An admin on the host chooses **Renew certificate**:
- the new certificate is generated;
- the old one stays accepted for a 14-day grace period on clients that are already paired (the server sends a signed hand-over: the old key signs the new fingerprint);
- clients re-pin automatically through that signed hand-over, or re-pair manually.

Each renewal is audited and documented in `LAN_SETUP_GUIDE.md` and `SECURITY_GUIDE.md`.

## 6. LAN guard, discovery, version check

- **LAN guard middleware** rejects any request whose remote address is not loopback, RFC1918 (10/8, 172.16/12, 192.168/16) or link-local, and in standalone mode anything that is not loopback. Login rate limiting is kept. Connected clients are listed on the host and can be revoked; revoking deletes the pairing and invalidates that client's sessions.
- **Firewall:** in host mode the installer adds a Windows Firewall inbound rule for TCP 3747 and UDP 3748, `profile=private`, `remoteip=localsubnet`, with user consent.
- **Discovery:** UDP broadcast on port **3748** (a request carries a magic string and a nonce; the reply carries name, IPs, port and the short fingerprint). It is a convenience only; **manual IP entry is always available**. Discovery results are untrusted until paired.
- **Version check:** `GET /api/health` returns `{appVersion, apiProtocol, mode, db:{ok}, time}`. A client refuses to operate when `apiProtocol` differs ("Update this computer to version X") and warns on a minor version difference.

## 7. Connection state and disconnected behaviour

`ConnectionManager` in main sends a heartbeat to `/api/health` every 5 s, with a 3 s timeout. States: `CONNECTED`, `DEGRADED` (one miss), `DISCONNECTED`, `CERT_MISMATCH`, `VERSION_MISMATCH`.

- The renderer shows a status chip; when the state is DISCONNECTED it shows a blocking overlay ("Host unreachable, reconnecting… [Retry] [Connection settings]").
- **A client never records sales locally.** There is no local DB in client mode.
- **Sale submission is idempotent.**
  1. The UI creates `client_txn_id` (UUID v4) at checkout and keeps it with the cart, persisted in the draft.
  2. On timeout or network error, the UI shows **SALE NOT CONFIRMED** with two actions: *Retry*, which re-posts with the same `client_txn_id` (the server returns the original result if it already committed), and *Check status*, which calls `GET /api/sales/by-txn/:id`.
  3. A receipt is printed only after the server returns the committed sale.
- Reconnection uses backoff of 1 s, 2 s, 5 s, then every 10 s. After a reconnect the UI re-fetches all data (see §9).

## 8. Database layer

### Adapter (`server/db/adapter.ts`)

```ts
interface Db {
  all<T>(sql: string, params?: Param[]): T[];
  get<T>(sql: string, params?: Param[]): T | undefined;
  run(sql: string, params?: Param[]): { changes: number; lastInsertRowid: number };
  exec(sql: string): void;                       // DDL / multi-statement only
  transaction<T>(fn: () => T): T;                // BEGIN IMMEDIATE … COMMIT / ROLLBACK
  backupTo(path: string): Promise<void>;         // online backup API
  integrityCheck(): string[];                    // [] when ok
  close(): void;
}
type Param = string | number | bigint | Buffer | null;
```

- **Parameter normalisation:** `undefined → null`, `boolean → 0/1`. `Date` becomes an ISO string. Objects and arrays throw, which surfaces call-site bugs that sql.js used to hide. Covered by unit tests.
- **Pragmas:** `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`, `foreign_keys` (see FK plan), `temp_store=MEMORY`.
- **Prepared statements** are cached by SQL text.
- **Call sites** (~290, inventoried in `PROJECT_AUDIT.md` Appendix A) are migrated **by hand, route group by route group**. Multi-statement writes go into `transaction()`. Re-reads such as `SELECT id … WHERE invoice_number=?` are replaced with `lastInsertRowid`. Characterisation tests are written before migration and must pass after it. sql.js and `saveDatabase()` are removed only when no call sites remain.

### Migrations (`server/db/migrations/NNN_name.ts`)

- The `schema_migrations(version, name, applied_at, app_version, checksum)` table records each applied migration.
- **0001_baseline:** the existing schema, including all historic `ADD COLUMN` variants, applied idempotently. The legacy `users` CHECK-constraint rebuild is preserved.
- Later migrations add: indexes, `client_txn_id` columns, invoice sequences, batches, payments, shifts, returns, soft-void columns, backup history, terminals/pairings.

**Runner sequence:**
1. Open DB.
2. `integrity_check`. If it fails, **stop**.
3. Verified pre-migration backup. If it fails, **stop**.
4. Record row counts for every table.
5. Apply each pending migration in its own transaction.
6. Re-check integrity and the row-count invariants (no table loses rows unless the migration declares it).
7. On any failure: roll back, keep the backup, show a report screen. The app never runs on a half-migrated DB.

**Legacy import (copy only):** the wizard can import an old `khushi_pharmacy.sqlite`. Main opens a file dialog; the backend **copies** the file into the data dir under a new name, checks the copy and migrates the copy. **The original file is never written, moved or renamed.**

### Foreign-key plan

1. `scripts/fk-audit.mjs <db-copy>` runs `PRAGMA foreign_key_check` plus orphan queries for undeclared relationships (`tenant_id`, `customer_ledger.sale_id`, `users.customer_id`).
2. Findings are written to a report. **No rows are deleted.**
3. Fixes need owner approval and are non-destructive, for example:
   - create one placeholder parent per tenant ("[Deleted customer #N]");
   - or set a nullable FK to NULL while keeping the old value in `legacy_<col>`.
4. `PRAGMA foreign_keys=ON` is enabled only when the audit is clean on the migrated copy. Rebuilds that add FK clauses or actions use the SQLite 12-step table-rebuild procedure in one transaction, after a backup.
5. Deletes that would orphan rows (customer, product, tenant) are changed to *archive/deactivate* where history exists. The delete action stays in the UI, with a clear message.

### Data location

```
%PROGRAMDATA%\BrainTechPharmacyAI\
  config.json          mode, host, pinned fingerprint (no secrets)
  data\pharmacy.sqlite (+ -wal/-shm)
  data\jwt.secret      random 64 bytes, DPAPI-protected, ACL restricted
  certs\               server cert + encrypted key (host/standalone)
  backups\             verified encrypted backups (+ optional external copy)
  logs\                rotating app/backend logs (7 × 5 MB)
```

The installer grants `Users:Modify` on this folder. If it is not writable, the app falls back to `%LOCALAPPDATA%\BrainTechPharmacyAI\` and shows a warning. Data is never stored in Program Files. The uninstaller never deletes this folder; data removal is a separate documented procedure that asks for typed confirmation.

## 9. Real-time updates (SSE)

- `GET /api/events` is a `text/event-stream`, **authenticated by the normal `Authorization: Bearer` header**. The renderer reads it with `fetch()` and a `ReadableStream` (not `EventSource`), and main forwards the header over pinned TLS. **No token appears in a URL.**
- On connect and every 60 s the server re-validates the JWT and the user/tenant status. The stream is closed on expiry, disable, suspension, logout or pairing revocation.
- **Payload:** only `{seq, topic, tenantId}` with topic ∈ `inventory | sales | customers | purchases | settings | users | backups`. No business data travels in events; clients re-fetch through authorised endpoints, so authorisation is never bypassed.
- Events are emitted **after commit** only, scoped per tenant, and `seq` is monotonic per server start (with a `bootId`). A client that sees a gap, a new `bootId` or a reconnect performs a full refresh. Duplicate events are harmless because they only trigger a re-fetch.
- **Front end:** `src/lib/liveUpdates.ts` (`useLiveRefresh(topic, refetch)`), wired into App alerts, Billing (products, customers), Inventory, Customers, Sales, Purchases and Reports. A heartbeat comment every 20 s keeps NAT/Wi-Fi idle timeouts from dropping the stream.

## 10. Inventory model (batch level)

```
products (catalogue; stock = cached SUM of active batches)
  └─ product_batches (batch_number, expiry_date, purchase_price, sale_price, mrp,
                      qty_on_hand, supplier_id, purchase_item_id, status, tenant_id)
sale_items ── sale_item_batches (sale_item_id, batch_id, qty, unit_cost)
purchase_items.batch_id
stock_adjustments.batch_id + reason_code (DAMAGED, EXPIRED, LOST, THEFT, COUNT_CORRECTION, ADD) + note
supplier_returns / supplier_return_items (batch_id, qty, credit)
sales_returns / sales_return_items (sale_item_id, batch_id, qty, restock flag, refund)
```

- **FEFO:** for each sale line the server takes active, non-expired batches with `qty_on_hand > 0`, ordered by `expiry_date ASC, id ASC`, and allocates quantity across them. Expired batches are never sold. The cashier can pin a specific batch.
- **Insufficient stock:** HTTP 409 with the available quantity. The whole sale rolls back.
- **Invariant**, checked in the same transaction and by a periodic health check: `products.stock = SUM(qty_on_hand of non-quarantined batches)`.
- **Migration:** one batch per existing product with `stock > 0`, using its current batch, expiry and prices.

### As built in Phase 6 (differences from the design above)

| Item | Built |
|---|---|
| Tables | `product_batches` (batch_number, mfg_date, expiry_date `YYYY-MM-DD` or NULL, **expiry_raw** = original text, purchase_price, sale_price, qty_received, qty_on_hand `CHECK >= 0`, supplier_id, purchase_item_id, source MIGRATION/OPENING/PURCHASE/ADJUSTMENT/VOID_RESTORE, tenant_id, created_by, archive columns), `sale_item_batches` (quantity `CHECK > 0`, unit_cost), `inventory_migration_issues`; new columns `purchase_items.batch_id/mfg_date/sale_price`, `stock_adjustments.batch_id/reason_code`. No `mrp`, `status`/quarantine, supplier or customer returns yet (later phases). |
| Stock total | `products.stock` is kept by triggers on `product_batches` (insert/update/delete). Guard triggers abort any direct write of `products.stock` (`STOCK_GUARD`), so a forgotten code path fails loudly instead of desynchronising stock. |
| FEFO | `server/inventory/fefo.ts`: non-expired batches with stock, expiry ascending, **undated batches last** (D5), then id. Lines for the same product share one pool. The whole plan is computed and validated before the first write. No cashier batch pinning yet. |
| Expiry rule | `server/inventory/expiry.ts`: sellable up to and including the expiry date (D3); `YYYY-MM` / `MM/YYYY` = last day of that month; ambiguous day/month text is not guessed (kept in `expiry_raw`, reported). "Today" = the host computer's local date. |
| Refusals | 409 `INSUFFICIENT_STOCK` / `EXPIRED_STOCK` with `product_id`, `product_name`, `requested`, `available`, `expired`. 400 for invalid quantity, unknown or archived product. Nothing is written for a refusal. |
| Sale records | `sale_item_batches` rows; `sale_items.batch_number` = the batch numbers used, `expiry_date` = earliest; `cost_price` = weighted batch cost (D6); the price charged is still the POS price (D2, C9 in Phase 7). |
| Void | Still the old hard delete (soft-void is Phase 7); units return to the exact batches; pre-batch sales go into a VOID_RESTORE batch built from the line's batch/expiry text. |
| Invariant check | `inventoryInvariantIssues()` at backend startup (stock = sum of batches, no negative batch, sale line quantity = its allocations). Problems are logged and shown in `/api/local/host-status` → `inventory`; nothing is auto-repaired. No periodic re-check yet. |
| Endpoints | `GET /api/inventory/:id/batches`, `PUT /api/batches/:id` (ADMIN; number, dates, sale price; reason required; audited; never quantity), `GET /api/batches/:id/history`, `GET /api/inventory/expiry-report?days=`. `GET /api/inventory` adds `sellable_stock`, `expired_stock`, `batch_count`, `next_batch_id`, `next_expiry`, `has_undated_stock`; its `batch_number`/`expiry_date` describe the next FEFO batch. |
| Protocol | `API_PROTOCOL` = 2 (D7): a host and a client on different versions get the existing "different versions" screen. |

## 11. POS model

| Concern | Design |
|---|---|
| Idempotency | `client_txn_id TEXT UNIQUE` on sales, sales returns, purchases, customer payments, adjustments, supplier returns; replay returns the stored result |
| Totals | Server recomputes from DB batch prices, discounts and tax config; a mismatch above 0.01 is rejected with the server's figures |
| Payments | `payment_methods` (configurable, active flag, type CASH/CARD/BANK/WALLET/CREDIT) and `sale_payments` (split); header `payment_method` kept as derived CASH/PARTIAL/UDHAR summary for compatibility |
| Tax | Settings: tax label, inclusive/exclusive; rate per product (`gst_rate`) |
| Shifts | `cash_shifts` (terminal, user, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, notes). Sales and returns are linked to a shift. Setting `require_open_shift`. Daily reconciliation report. |
| Numbering | `invoice_sequences(tenant_id, branch_code, doc_type, prefix, next_value)`, incremented inside the sale transaction. Configurable format, e.g. `{branch}-{yyyy}-{seq:6}`. Existing invoices keep their numbers; the sequence starts above the current maximum. |
| Templates | Settings: header/footer text, logo, paper 58 mm / 80 mm / A4, field visibility; one shared renderer used for preview, `window.print` fallback and native `webContents.print` |
| Voids | Soft-void (`status`, `voided_at`, `voided_by`, `void_reason`) that restores stock to the original batches and reverses the ledger; reports exclude voided sales |
| Audit | Every financial, stock, security, backup and config action is written to `audit_logs` in the same transaction as the change |

### As built in Phase 7, Batch 2c (payment screens)
- Advance priority: opening balance → confirmed carried-over balances (oldest first) → oldest invoices (`applyAvailableAdvance`), applied on credit sales, Q1 confirmations and reversals; migration 0010 applied pre-existing advances once. `GET /api/customers/:id/payment-preview?amount=` (read-only) powers the payment preview.
- Screens: POS payment rows (Cash, Card, Bank Transfer, Mobile Wallet EasyPaisa/JazzCash, reference; Full Cash / Partial / Udhar shortcuts; change only from cash; walk-in must pay in full); Customers: Receive Payment with server preview and advance, Open invoices and Payment history tabs, administrator Balance review (Q1); Sales Register: current balance and status, payments, Record payment, administrator reversal with reason; receipt lists each payment, cash received and change.
- `src/lib/usePaymentAttempt.ts`: one transaction id per payment attempt, reused for retries after a lost answer, new only when the user starts a new payment; a second click while saving is ignored; the server result is shown before another payment can start. Used by every payment, reversal and Q1 confirmation window.

### As built in Phase 7, Batch 2b (payment module and APIs)
- `server/payments/service.ts`: validation (amount > 0, 2 decimals; methods CASH / CARD / BANK_TRANSFER / MOBILE_WALLET with EasyPaisa or JazzCash; transaction id required), allocation order **opening balance → confirmed carried-over balances (Q1) → oldest invoices → advance**, P3 advance applied to new credit invoices, reversal (release all allocations, OUT record, balance + ledger ADJUSTMENT). Every function runs inside the route's transaction; database triggers (0008/0009) are the backstop.
- Migration `0009_carried_over_balances`: `customer_carried_over_balances` (append-only, unique per discrepancy and transaction id, amount = confirmed difference), `payment_allocations` rebuilt to allow the `CARRIED_OVER_BALANCE` target (all rows copied, all guards recreated), `customer_ledger.payment_id`, catch-up of anything a 2a build recorded without payment records.
- API (protocol 4): `POST /api/sales` requires `client_txn_id`, accepts `payments: [{method, method_detail, amount, reference}]` (the old `payment_method` + `amount_paid` form still works and becomes one cash record); `POST /api/sales/:id/payments`; `POST /api/customers/:id/payment` (FIFO, advance, transaction id required); `POST /api/payments/:id/reverse` (ADMIN, reason); `GET /api/customers/:id/outstanding`, `GET /api/customers/:id/payments`, `GET /api/payments`; `GET /api/payments/reconciliation` (ADMIN: mismatches, migration issues, walk-in dues, confirmed items); `POST /api/customers/:id/carried-over-balance` (ADMIN, Q1). Every payment write is idempotent through `idempotency_keys`; a transaction id cannot be reused for another operation.
- Interim void (P5): refused (`VOID_HAS_PAYMENTS`) if the invoice received later payments; otherwise the at-sale payments are reversed (never twice) and kept; the customer balance is reduced by exactly what the invoice owed (the legacy clamp at 0 is removed).

### As built in Phase 7, Batch 2a (payment records, database only)
- Migration `0008_payments`: `payments` (IN money / OUT reversals; methods CASH, CARD, BANK_TRANSFER, MOBILE_WALLET, UNSPECIFIED for unmapped history; `client_txn_id` required for everything except carried-over history; one reversal per payment) and `payment_allocations` (APPLY / RELEASE against an invoice or the opening balance), both append-only by trigger. `sales_headers.balance_due` and `settlement_status` are maintained by triggers from the allocations and cannot be set directly; the at-sale columns are an immutable snapshot (trigger). Database triggers refuse allocations beyond the payment, the invoice total or the opening balance.
- History (E9, P2–P4): one CARRIED_OVER_SALE payment per paid sale, one CARRIED_OVER_CUSTOMER payment per ledger payment (method from the stored mode text), replayed in date order: opening balance first, then oldest invoices, leftover = advance applied to the next credit invoice. Stored balances and amounts are never changed; differences go to `payment_migration_issues` and the audit log.
- `server/payments/reconcile.ts`: at startup each customer's stored balance is compared with opening still owed + invoice balances − advance; mismatches, sales without payment records and walk-in sales with money owed are logged and shown in `/api/local/host-status` → `payments`. Nothing is repaired.
- Until Batch 2b the API does not write payment records yet (new sales are reported as "no payment record").

### As built in Phase 7, Batch 1 (server-calculated POS)
- `shared/pricing.ts` is the only pricing formula; the server uses it to charge, the POS uses it only for display. Per line: gross, line discount and GST each rounded to 2 decimals; bill discount after line discounts and not reducing GST (legacy rule kept, E3).
- `POST /api/sales/quote` returns the host's figures (lines, totals, discount status) and checks stock; nothing is written. The payment screen shows these figures and cannot complete until they are confirmed.
- `POST /api/sales` re-validates everything in `prepareSale()` before the first write: products (price and GST rate from the host, E1), quantities, discounts 0–100 %, discount limits, payment method and amounts, FEFO stock plan. A client `grand_total` that differs from the server's by half a paisa or more → 409 `PRICE_MISMATCH` with the server figures. CASH must cover the bill (change returned); PARTIAL cannot exceed it.
- Discounts (E2): settings `pos_staff_max_discount_percent` (default 0) and `pos_admin_max_discount_percent` (default 100), ADMIN-only, validated, changes audited. Above the staff limit: ADMIN sellers give a reason; STAFF need `POST /api/sales/discount-authorization` (an administrator's username and password entered at the counter, a maximum % and a reason) which returns a single-use grant bound to that cashier, valid 10 minutes, held in host memory only (`server/pos/discountAuth.ts`). 5 wrong passwords lock it for 10 minutes. Every such sale writes a `DISCOUNT_OVERRIDE` audit row (cashier, authorizer, percentages, amount, reason).
- `API_PROTOCOL` = 3.

## 12. Backups

- **Engine:** better-sqlite3 `backup()` (online, consistent while writes continue) writes to a temp file. The file is then encrypted (AES-256-GCM, scrypt N=2^15 with a random 16-byte salt per file, header with format version and app version) and atomically renamed.
- **Verification** for each backup: decrypt to a temp file, open read-only, `integrity_check`, compare table row counts with the source snapshot, then delete the temp file. Results go into `backup_history` (time, type, size, sha256, verified, error).
- **Triggers:** daily at a configurable time (default 13:00, when the PC is likely on); on app close if the last backup is more than 24 h old; manual; pre-migration; **pre-restore** (always).
- **Key:** a *backup recovery password* set in the setup wizard, needed to restore on a new PC. A DPAPI-wrapped copy on the host allows unattended backups. The admin is warned to write the password down; it cannot be recovered.
- **Retention:** configurable (default 14 daily, 8 weekly, 12 monthly), pruned only after a newer verified backup exists.
- **External copy:** optional folder on another drive or USB, copied and verified after each backup. A warning is shown if the drive is missing.
- **Restore:**
  1. choose the file through the native dialog;
  2. decrypt and verify;
  3. safety backup of the current DB;
  4. stop writes;
  5. swap the files;
  6. reopen and run integrity check plus migrations;
  7. on failure, automatically roll back to the safety backup.
- **Legacy formats:** `.kmhbackup` import stays supported (read-only CBC path). The MySQL dump export is kept.
- **UI:** last successful backup time, health chip (OK / STALE > 26 h / FAILED / NO EXTERNAL COPY), history list.

## 13. Branding and configuration

- The product name, icons, installer and window title are "BrainTech Pharmacy AI".
- Pharmacy identity comes from settings: `store_name`, `store_urdu_name`, address, phone, NTN, logo (stored in the DB as a data URI, max 256 KB) and message templates with `{store_name}` placeholders.
- A fresh install gets neutral defaults entered in the wizard. Existing DBs keep their stored values.

## 14. Logging and errors

- JSON-lines logs: `ts`, `level`, `appVersion`, `mode`, `category` (`db|auth|sale|lan|backup|ipc|print|update`), `op`, `msg`, `errCode`.
- Passwords, tokens, OTPs, SMTP/Twilio secrets, recovery passwords and customer phone or address are **never logged**; a redaction list is applied before writing.
- Handlers for `unhandledRejection` and `uncaughtException` log the error and, in the backend, exit for supervised restart. Clients receive generic errors with a correlation ID rather than stack traces.

## 15. Build and release

- **Scripts:**
  - `build:web` (vite) → `dist/`
  - `build:server` (esbuild, bundle everything except `better-sqlite3`) → `dist-electron/server.cjs`
  - `build:electron` → `dist-electron/main.cjs`, `preload.cjs`
  - `dist:win` (electron-builder)
- **electron-builder:** NSIS (assisted, choose directory, desktop and Start-menu shortcuts, `installer.nsh` for the ProgramData ACL and optional firewall rule) plus portable. `asarUnpack: node_modules/better-sqlite3/**`. Signing through `CSC_LINK` / `CSC_KEY_PASSWORD` when provided; **unsigned otherwise, and stated as such**.
- **CI** (`.github/workflows/windows-build.yml`, `windows-latest`):
  - **Triggers:** `workflow_dispatch` (input `channel: dev|release`), push to the work branch (dev), and tags `v*` (release).
  - **Steps:** `npm ci` → lint → tests → build → NSIS silent install → smoke test (first-run admin via API, login, purchase creating a batch, FEFO sale, app restart, sale persisted) → uninstall (data folder must remain) → portable exe, same smoke → `CHECKSUMS.txt` (SHA-256).
  - **Outputs:** dev builds are versioned `x.y.z-dev.<run>` and uploaded as workflow artifacts only. Release builds create a GitHub Release with the EXEs and checksums.
- **Not testable in CI:** physical printers, scanners, cameras, and multi-PC Wi-Fi or router behaviour. These are documented as manual procedures in `TESTING_REPORT.md`, with status "not executed" until someone performs them.

## 16. Implementation phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 | Audit, checklist, architecture (this document) | Owner approves conflicts C1–C11 |
| 2 | Test harness: vitest, legacy fixture generator (original sql.js code), characterisation tests | Tests describe current behaviour and pass on the current code |
| 3 | DB adapter, call-site migration, migration framework, copy-only legacy import, FK audit | All characterisation tests pass; migrated fixtures meet the invariants; **halt and report on any data risk** |
| 4 | Electron shell, `app://`, hardened IPC, utilityProcess supervisor, wizard, first-run admin, branding | App runs standalone under xvfb |
| 5 | HTTPS, pairing, pinning, LAN guard, discovery, version check, connection overlay | Two instances pair; MITM and wrong-code tests fail closed |
| 6 | Batch inventory, FEFO, adjustments, supplier and customer returns, alerts, history | Stock invariants and FEFO tests pass |
| 7 | POS: idempotency, split and configurable payments, tax, shifts, numbering, templates, soft-void, NOT-CONFIRMED, native print | Concurrency (50 parallel sales) and replay tests pass |
| 8 | SSE real-time with live refresh | Cross-instance refresh test passes |
| 9 | Backup engine and UI | Backup/verify/restore round trip and pre-restore safety tests pass |
| 10 | Security pass, logging, dependency cleanup | No secrets in logs (test), redaction tests |
| 11 | Packaging and Windows CI | Green Windows workflow: NSIS + portable smoke, artifacts, checksums |
| 12 | Remaining docs, release notes | All 14 docs present; testing report honest |

Every phase ends with tests, a build check, a regression check against `FEATURE_PRESERVATION_CHECKLIST.md`, doc updates and a commit pushed to `claude/beautiful-einstein-ps972s`.


## 17. As built (after Phase 6) and deviations from the design

| Area | Design said | Built | Why |
|---|---|---|---|
| Electron | (version not fixed) | **Electron 45.2.3** | A currently supported release line |
| SQLite native module | electron-builder rebuild | **better-sqlite3 13.0.3**, whose npm package ships Node-API binaries for all platforms (incl. `win32-x64`) | One binary works in Node (tests) and Electron; no native compiling on build machines; removes a common cause of broken Windows installers |
| Certificate | ECDSA P-256 | **RSA-2048**, self-signed, 5 years, generated with `node-forge` | node-forge (pure JS, no OpenSSL dependency) signs RSA only. Trust is by pinned SHA-256 fingerprint, so the key type does not change the security model. |
| Pinned transport | `net.fetch` + `setCertificateVerifyProc` | Node `tls`/`https` in the main process (`server/lan/pinnedClient.ts`): the fingerprint is checked **on the connected socket before any request byte is sent** | Testable under plain Node (impostor and wrong-pin tests). A bug found during testing showed why this matters: Node skips `checkServerIdentity` for self-signed certificates, so the pin must be enforced explicitly. |
| Private key at rest | DPAPI via `safeStorage` | `safeStorage` async API (`encryptStringAsync`); falls back to an owner-only `key.pem` when encryption is unavailable | The synchronous API is deprecated in Electron 45 |
| Client identity | pairing + pin | pairing + pin + **per-client token** (only its SHA-256 is stored on the host), required by the LAN guard for every non-loopback request; revocable | Lets the host remove a lost laptop without re-keying everyone |
| Certificate renewal | signed hand-over with 14-day grace | **Not built yet.** Renewal = new certificate; clients re-pair (documented in `LAN_SETUP_GUIDE.md` §8). | Deferred; listed as remaining work |
| Discovery | UDP 3748 broadcast | Built (`server/lan/discovery.ts`), answers private-LAN requesters only | Unit-tested over loopback; not testable on a real LAN in this environment |
| JWT secret | random, DPAPI-protected | random 64 bytes in `data/jwt.secret`, owner-only file permissions; the role is always read from the database | DPAPI wrapping of this file is listed for Phase 10 |
| FK enforcement | after approved fixes | **ON** (FK1–FK5, see `FK_AUDIT_REPORT.md`) | n/a |
| Idempotency | `client_txn_id` column on each table | `idempotency_keys` table (key, route, stored result), written in the same transaction as the sale | One mechanism for every route, no table rebuilds; used by sales now, payments/purchases in Phase 7 |
| Real-time updates | SSE | **Not built yet** (Phase 8). Every screen reads fresh data from the host when it loads. | Phase order |
| Batch inventory (Phase 6) | §10 | Built as described in §10 "As built in Phase 6". Stock protection is in the database (CHECK + triggers), not only in code. | A missed code path must fail, not silently corrupt stock |
| Stock invariant check | in-transaction + periodic | at startup only, reported, never repaired; the database triggers make a mismatch impossible through normal writes | Periodic check deferred |

### Module map

```
electron/main.ts         lifecycle, single instance, windows, menu, navigation/permission/download policy, IPC handlers
electron/preload.ts      window.braintech (frozen; requires only 'electron'; sandboxed)
electron/connection.ts   app:// protocol: bundled UI + /api proxy over pinned HTTPS, CSP, heartbeat/connection states
electron/backend.ts      utilityProcess supervisor (start, graceful stop, crash restart with backoff, 5-in-2-min stop)
electron/certs.ts        per-installation certificate (generate, encrypted key)
electron/store.ts        data folder selection (ProgramData > LocalAppData; never the install dir), config.json, logs
electron/ipc.ts          channel registry, sender check (app://braintech only), zod argument validation
electron/ui/             setup wizard + Connection & Server Settings (no inline scripts)
server/config.ts         modes, address classification, API protocol version
server/lan/*             tls, pairing, pinnedClient, guard, discovery
server/db/*              adapter, migrations 0001-0007, open (integrity + migrate + FK check), legacy import, transactional routes
server/inventory/*       expiry rules (D3/D5), FEFO planner, batch helpers (guarded take/add, invariant check)
server/seed.ts           optional demo catalogue (no logins); legacy test seed (tests only)
server/security/*        per-install JWT secret
```

### Runtime data layout (as built)

```
<data root>/config.json          mode, host address + pinned fingerprint, encrypted client token
<data root>/data/pharmacy.sqlite (+ -wal/-shm), jwt.secret, backups/ (pre-migration, pre-restore)
<data root>/certs/cert.pem, key.enc (or key.pem)
<data root>/logs/main.log, backend.log
```
