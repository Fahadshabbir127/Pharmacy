# Feature Preservation Checklist

Every feature found in the existing source (revision `ec90af3`) must keep working after the desktop conversion, unless a row is marked **CHANGE**. CHANGE rows need explicit owner approval; see `PROJECT_AUDIT.md` §14.

**Columns**
- **Auto**: covered by an automated test (filled in during Phases 2–11).
- **Manual**: verified by a person on Windows hardware.
- **Status**: `pending`, `pass`, `fail`, or `n/a`. Nothing is marked `pass` until it has actually been tested.

All rows start as `pending`.

**Phase 2 baseline:** the automated characterisation suite (`tests/characterization/`, 111 tests, see `TESTING_REPORT.md`) now covers the backend behaviour behind sections 1–12. Each item's `Status` stays `pending` until it is verified again after the conversion, in the desktop app, on Windows.

## 1. Authentication & accounts

| # | Feature | Source | Auto | Manual | Status |
|---|---|---|---|---|---|
| A1 | Username/password login (bcrypt) | `POST /api/auth/login`, `LoginModal.tsx` | | | pending |
| A2 | Failed-login lockout (in-memory attempts map) | `server.ts:692,1117` | | | pending |
| A3 | Email OTP login: request + verify | `/api/auth/send-login-otp`, `/api/auth/login-otp` | | | pending (**CHANGE C5**: OTP no longer returned in response) |
| A4 | Customer self-registration with email OTP | `/api/auth/send-otp`, `/api/auth/register` | | | pending (**CHANGE C5**) |
| A5 | Store (tenant) self-registration with OTP | `/api/auth/register-store` | | | pending (**CHANGE C5**) |
| A6 | Session restore on reload (`/api/auth/me`) | `App.tsx checkAuthSession` | | | pending |
| A7 | `?logout=true` / `?login=true` force-logout URL parameters | `App.tsx:103` | | | pending |
| A8 | Logout | `Navbar.tsx`, `App.tsx` | | | pending |
| A9 | Account status gate (PENDING/APPROVED/disabled) checked on every request | `authenticateToken` | | | pending |
| A10 | Suspended-tenant gate | `authenticateToken` | | | pending |
| A11 | Roles SUPER_ADMIN / ADMIN / STAFF / CUSTOMER and role middleware | `requireRoles` | | | pending |
| A12 | Per-user `allowed_services` controlling sidebar items | `Sidebar.tsx`, `/api/users/:id/permissions` | | | pending |
| A13 | Password strength rule (≥ 8 chars, a letter, and a digit or symbol) | `isPasswordStrong` | | | pending |
| A14 | Forced creation of `superadmin` and personal SUPER_ADMIN accounts, password reset at boot | `server.ts:505-553` | | | **CHANGE C4**: removed; existing accounts kept |
| A15 | Demo seed users and sample data on an empty DB | `server.ts:374-502` | | | **CHANGE C4**: only when "load demo data" is ticked in the wizard |

## 2. Super Admin (multi-store platform)

| # | Feature | Source | Status |
|---|---|---|---|
| SA1 | Platform metrics | `GET /api/superadmin/metrics` | pending |
| SA2 | List tenants / view tenant details (medicines, customers, sales, staff, audit) | `/api/superadmin/tenants`, `/:id/details` | pending |
| SA3 | Create tenant (store + owner account) | `POST /api/superadmin/tenants` | pending |
| SA4 | Suspend / activate tenant | `PUT …/:id/status` | pending |
| SA5 | Delete tenant | `DELETE …/:id` | pending |
| SA6 | Edit tenant allowed services | `PUT …/:id/services` | pending |
| SA7 | "Login as" a store (impersonation) and "Return to Super Admin" | `POST …/:id/login-as`, `Navbar.tsx handleReturnToSuperAdmin` | pending |
| SA8 | Send message to a store (email queue), with templates | `POST /api/superadmin/send-message` | pending |
| SA9 | Global settings and SMTP test from the super-admin screen | `SuperAdminScreen.tsx` | pending |
| SA10 | Tenant isolation: every tenant-scoped query filters by `tenant_id` | all routes | pending |

## 3. POS / Billing (F1)

| # | Feature | Source | Status |
|---|---|---|---|
| P1 | Product search by name, barcode, batch, HSN, or ID | `BillingScreen.findProductByBarcode`, `/api/inventory?search=` | pending |
| P2 | USB HID barcode scanner (keystroke burst < 80 ms + Enter, ≥ 3 chars), no driver needed | `BillingScreen.tsx:203-236` | pending |
| P3 | Camera barcode scanning (`html5-qrcode`, rear camera) inside the Electron window | `BillingScreen.tsx:240-300` | pending (camera permission must work in Electron) |
| P4 | Manual barcode / search entry + Enter | `BillingScreen.tsx` | pending |
| P5 | Scan beep (success/error) with a sound on/off toggle | `playScanBeep`, `soundEnabled` | pending |
| P6 | Barcode-mode toggle and print-on-save toggle | `barcodeMode`, `printOnSave` | pending |
| P7 | "Last scanned item" notice | `lastScannedItem` | pending |
| P8 | Cart: add, change quantity, remove, per-item discount %, GST per item | `BillingScreen.tsx` | pending |
| P9 | Bill-level discount % | `overallDiscountPercent` | pending |
| P10 | Payment methods CASH / PARTIAL / UDHAR (credit) with amount paid and change | payment modal, `POST /api/sales` | pending (extended in Phase 7) |
| P11 | Customer select + quick-add customer from the POS | `handleQuickAddCustomer` | pending |
| P12 | Udhar/partial requires a customer | client + server validation | pending |
| P13 | Customer balance and ledger updated by a sale | `POST /api/sales` | pending |
| P14 | Email + SMS notice queued when the customer owes money | `POST /api/sales` | pending |
| P15 | Draft cart auto-save, with restore/discard after reload | `saveDraftCart` / `loadDraftCart` | pending |
| P16 | Thermal receipt modal with print | `ThermalReceiptModal.tsx` | pending |
| P17 | Automatic `.txt` invoice download after a sale | `downloadSaleInvoiceFile` | pending |
| P18 | Invoice number per tenant (`INV-<tenant>-<n>`) | `POST /api/sales` | **CHANGE R4 fixed (Phase 7 Batch 2e)**: per-store sequence (`invoice_sequences`, migration 0011) that only goes up; existing numbers kept; voided numbers never reused; tests `02`, `14`, `invoice-sequence-migration`, LAN E2E |
| P19 | Stock deducted on sale | `POST /api/sales` | pending (**CHANGE C2**: no oversell; FEFO batches) |
| P20 | Offline sales queue + auto sync + footer "PENDING SYNC" | `api.ts:443-503`, `App.tsx` | **CHANGE C3**: replaced by NOT CONFIRMED + idempotent retry; legacy queue entries reviewable |
| P21 | Server accepts client totals | `POST /api/sales` | **CHANGE C9**: server recomputes |

## 4. Sales Register

| # | Feature | Source | Status |
|---|---|---|---|
| SR1 | Sales history with date range and customer filter | `GET /api/sales/history` | pending |
| SR2 | Full history including items | `getFullSalesHistory` | pending |
| SR3 | Sale detail view | `GET /api/sales/:id` | pending |
| SR4 | Print sales register report (popup window) | `SalesScreen.handlePrintRegisterReport` | pending |
| SR5 | Void/delete invoice (ADMIN): restores stock, reverses udhar, ledger entry, audit | `DELETE /api/sales/:id` | pending (**CHANGE C1**: soft-void) |

## 5. Inventory (F2)

| # | Feature | Source | Status |
|---|---|---|---|
| I1 | List with search, category filter, low-stock filter, expiring-within-N-days filter | `GET /api/inventory` | pending |
| I2 | Add / edit product (name, unit, prices, min stock, batch, expiry, category, HSN, GST, rack, supplier, barcode) | `POST/PUT /api/inventory` | pending |
| I3 | Delete product (ADMIN) | `DELETE /api/inventory/:id` | pending |
| I4 | Stock adjustment ADD/REMOVE with reason, audited | `POST /api/inventory/adjust` | pending (extended to per-batch typed reasons) |
| I5 | Categories: list and add | `/api/categories` | pending |
| I6 | Inventory Excel export | `InventoryScreen.handleExportExcel` | pending (download via native save dialog) |
| I7 | Low-stock and expiring counters in the sidebar | `App.fetchAlertsAndSettings`, `/api/reports/dashboard` | pending |
| I8 | Product max limit per tenant plan (`max_products`) | tenant fields | pending (verify enforcement in tests) |

## 6. Customers & Udhar

| # | Feature | Source | Status |
|---|---|---|---|
| C1 | List / search customers with balances | `GET /api/customers` | pending |
| C2 | Create customer (optional portal login) | `POST /api/customers` | pending |
| C3 | Edit / delete customer | `PUT/DELETE /api/customers/:id` | pending |
| C4 | Ledger history with running balance | `GET /api/customers/:id/ledger` | pending |
| C5 | Record udhar payment (ledger + balance + notification queue) | `POST /api/customers/:id/payment` | pending |
| C6 | Send udhar reminder (queue email/SMS from template) | `POST /api/customers/:id/remind` | pending |
| C7 | Send via WhatsApp (`wa.me`) and SMS app (`sms:`) links | `handleSendWhatsApp`, `handleSendSMSApp` | pending (opens external browser after confirmation; needs internet) |
| C8 | Print customer ledger | `handlePrintCustomerLedger` | pending |

## 7. Purchases & Suppliers

| # | Feature | Source | Status |
|---|---|---|---|
| PU1 | Record purchase (supplier, invoice number, items, batch, expiry, price) → stock in | `POST /api/purchases` | pending (**CHANGE C6**: creates batches) |
| PU2 | Purchase history and detail | `GET /api/purchases`, `/:id` | pending |
| PU3 | Draft purchase order modal: print as PDF and email PO (queue) | `PurchaseOrderModal.tsx`, `POST /api/purchases/email-po` | pending |
| PU4 | Suppliers: list / add / edit / delete | `/api/suppliers*` | pending |

## 8. Reports

| # | Feature | Source | Status |
|---|---|---|---|
| R1 | Dashboard stats (sales today, low stock, expiring, udhar totals, …) | `GET /api/reports/dashboard` | pending |
| R2 | Sales/profit report by date range | `GET /api/reports/sales` | pending |
| R3 | Top products | `GET /api/reports/top-products` | pending |
| R4 | Report Excel export | `ReportsScreen.handleExportSalesReportExcel` | pending |

## 9. Email & SMS centre

| # | Feature | Source | Status |
|---|---|---|---|
| E1 | Email queue: list / edit / delete / clear | `/api/email/queue*` | pending |
| E2 | "Process" email queue: marks PENDING as SENT, **sends nothing** | `POST /api/email/process` | pending (**CHANGE C10**: relabel only) |
| E3 | SMS queue: list / edit / delete / clear / "process" | `/api/sms/*` | pending (**C10**) |
| E4 | Online/offline indicator on queue screens | `navigator.onLine` | pending |

## 10. Users & audit

| # | Feature | Source | Status |
|---|---|---|---|
| U1 | List users, create staff/admin users | `GET/POST /api/users` | pending |
| U2 | Approve / reject / disable (status) | `PUT /api/users/:id/status` | pending |
| U3 | Change role | `PUT /api/users/:id/role` | pending |
| U4 | Edit profile | `PUT /api/users/:id` | pending |
| U5 | Admin reset of a user password | `PUT /api/users/:id/reset-password` | pending |
| U6 | Per-staff permission toggles and presets | `PUT /api/users/:id/permissions` | pending |
| U7 | Delete user | `DELETE /api/users/:id` | pending |
| U8 | Max users per tenant plan | tenant `max_users` | pending |
| AU1 | Audit log list with search, filters, pagination | `GET /api/audit-logs` | pending |
| AU2 | Audit log Excel export | `exportAuditExcel` | pending |
| AU3 | Clear audit logs (ADMIN) | `DELETE /api/audit-logs/clear` | pending (the clear action itself becomes an audit entry) |

## 11. Settings & backups

| # | Feature | Source | Status |
|---|---|---|---|
| S1 | Store settings: name, Urdu name, address, phone, NTN, receipt footer, printer type/address | `GET/POST /api/settings` | pending |
| S2 | SMTP and Twilio settings fields, SMS/email enabled flags | settings | pending (secrets hidden from STAFF) |
| S3 | Message templates (udhar reminder, payment receipt, refill, welcome) incl. Urdu | settings | pending |
| S4 | SMTP test (queues a test email) | `POST /api/settings/test-smtp` | pending |
| S5 | Encrypted backup download (`.kmhbackup`) with a password | `POST /api/backup/export` | pending |
| S6 | Restore from `.kmhbackup` (and raw SQLite base64) | `POST /api/backup/import` | pending (adds a safety backup before restore) |
| S7 | MySQL/MariaDB dump export | `GET /api/backup/mysql-export` | pending |
| S8 | Admin password reset from the settings screen | `SettingsBackupScreen.handleResetUserPassword` | pending |
| S9 | Auto-backup settings (`auto_backup_enabled`, `backup_interval_hours`) | settings | pending (becomes a real backup engine) |

## 12. Customer portal (F8)

| # | Feature | Source | Status |
|---|---|---|---|
| CP1 | Customer sees own profile, balance, recent invoices, ledger | `GET /api/customer-portal/me` | pending |
| CP2 | Print own statement | `CustomerPortalScreen.handlePrintStatement` | pending |
| CP3 | Customer cannot reach other data or staff tabs (F-key shortcuts ignored) | `App.tsx:152`, route filters | pending |

## 13. Shell / UX

| # | Feature | Source | Status |
|---|---|---|---|
| X1 | Keyboard shortcuts F1 Billing, F2 Inventory, F8 Portal | `App.tsx:150-166` | pending |
| X2 | Lazy-mounted tabs that keep their state | `App.tsx visitedTabs` | pending |
| X3 | Mobile/responsive sidebar | `Sidebar.tsx`, `Navbar.tsx` | pending |
| X4 | Navbar clock and online indicator | `Navbar.tsx` | pending (shows host connection instead of internet) |
| X5 | Urdu text rendering (RTL strings in templates and store name) | settings | pending |
| X6 | Branding "Khushi Medical Hall", footer "© Muhammad Umar" | many files | **CHANGE C7** |

## 14. New capabilities required by the owner (not regressions; tracked here so they are verified)

Batch inventory and FEFO · supplier returns · customer returns/refunds · configurable and split payments · tax configuration · shifts and cash reconciliation · branch invoice sequences · invoice templates · native printer selection · standalone, host and client modes · HTTPS pairing · real-time updates · verified encrypted backups with retention and an external drive. See `ARCHITECTURE.md`.

## Status of the approved changes (after Phase 6)

| Change | Status |
|---|---|
| C1 soft-void invoices | Not yet (Phase 7). Delete-invoice still works as before; FK enforcement is compatible with it. |
| C2 reject oversell | **Done (Phase 6).** 409 `INSUFFICIENT_STOCK` / `EXPIRED_STOCK`, FEFO across batches, database-level protection; POS keeps the cart and explains the refusal; tested incl. 50 concurrent sales and a host+client last-unit race. |
| C3 no silent offline queue; idempotent retry | **Done.** `client_txn_id`, SALE NOT CONFIRMED + Retry / Check status; legacy queue manual-review only; tested end to end including a host crash after COMMIT. |
| C4 no forced/backdoor accounts, first-run admin | **Done** |
| C5 OTP not returned; SMTP or admin approval | Not yet (Phase 10) |
| C6 purchases keep batches | **Done (Phase 6).** Each purchase line is its own batch (batch, mfg date, expiry, cost, sale price). |
| C7 BrainTech branding, pharmacy's own name/logo | **Done** for names, receipts, purchase orders, messages and file names. Logo upload is not built yet. |
| C8 per-install token secret, re-login | **Done** (plus: the role is read from the database, not the token) |
| C9 server-side totals | **Done (Phase 7, Batch 1).** The host prices every sale; a different client total is refused with the server figures; the payment screen shows the server total before money is taken. |
| C10 "Mark as sent (manual dispatch)" label | Not yet (Phase 10) |
| C11 no invented barcodes | **Done** (existing barcodes untouched) |
| FK1–FK5 | **Done** (see `FK_AUDIT_REPORT.md` §5) |

Features verified in the **desktop app** by automated end-to-end tests on Linux (not yet on Windows):
- login (A1);
- POS search by batch, cart, cash sale, receipt, invoice download (P1, P4, P8, P10, P16, P17);
- persistence across restart;
- data shared between host and client;
- Phase 6: stock deducted per batch by FEFO and refused when short or expired (P19), receipt with batch lines (P16), purchase entry with batch/mfg/expiry (PU1), inventory batches panel, expiry tracker and per-batch write-off (I1, I4).

**Phase 7 Batch 2 changes to existing behaviour (approved P1–P8, Q1, advance priority; see `PAYMENTS.md`):**
- P10: payments are recorded per method (Cash, Card, Bank Transfer, Mobile Wallet) with split payments; Full Cash / Partial / Udhar remain as shortcuts. A walk-in customer must pay in full.
- P13 / C5: every payment is a permanent record applied to the opening balance, confirmed carried-over balances and the oldest invoices; extra money is kept as advance and applied to new debt automatically. Customer payments need a transaction id (the screens send one; retries are safe) and are now audited.
- C4: the ledger is unchanged; new tabs show open invoices (what is still owed) and payment history.
- SR1/SR3: each invoice shows its current balance and status next to the at-sale status; payments can be recorded against an invoice; administrators can reverse a payment with a reason.
- SR5 (until Batch 4): an invoice with later payments cannot be voided; money taken at the sale is reversed and kept as history; the customer balance is reduced exactly (no clamp at 0).
- P16: the receipt lists each payment method, cash received and change.

**Phase 7 Batch 1 changes to existing behaviour (approved E1–E3):**
- P8/P9: discounts above the staff limit (default **0 %**) need an administrator's authorization at the counter and a reason; administrators selling directly give a reason. Limits are store settings (Settings → POS Discount Limits).
- P10: CASH must cover the bill (change is shown and returned); PARTIAL cannot exceed the bill. Previously a short cash payment was silently stored as part-paid without a customer.
- P21: the server calculates all totals (C9). If a price changed on the host, the payment screen shows the new total before completing.

**Phase 6 changes to existing behaviour (approved D1–D7):**
- I2: the product form sets **opening** stock, batch and expiry only when a product is created; when editing, stock is read-only (D1) and batches are edited in the Batches panel.
- I4: REMOVE needs the batch and a reason code; more than the batch holds is refused (was clamped).
- I7: the sidebar counts expiring **batches** (incl. expired) and shows expired batches separately; low stock uses sellable (non-expired) stock.
- P19: overselling and selling expired stock are refused (C2).
- PU1: purchases no longer overwrite the product's batch/expiry/cost (C6); the product's purchase/sale price is still updated as the default for new entries.
- SR5: voiding a sale returns units to the batches they came from (still a hard delete until Phase 7).
- Excel export adds sellable stock, expired stock and batch count columns (existing columns unchanged).

All other rows remain `pending` until they are checked on Windows.
