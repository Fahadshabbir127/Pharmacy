# Payments (Phase 7, Batches 1–2d)

This document describes how BrainTech Pharmacy AI records and protects money, as built and verified up to Phase 7 Batch 2d. It covers the approved decisions E1–E9, P1–P8, Q1 and the advance-priority decision. Verification results are in `TESTING_REPORT.md`.

## 1. Rules

| Rule | Where it is enforced |
|---|---|
| The host computer calculates every price, discount, tax and total (E1–E3). A screen's total that differs from the host's is refused (409 `PRICE_MISMATCH`). | `shared/pricing.ts`, `prepareSale()` in `server.ts` |
| Payment methods: Cash, Card, Bank Transfer, Mobile Wallet (EasyPaisa / JazzCash), recorded by hand with an optional reference. Udhar is the unpaid part, not a payment. No payment gateway (E4, P6). | `server/payments/service.ts` (`parseMethod`) and the database CHECK on `payments.method` |
| A sale may be paid with several methods (split payment). Change can only come from cash. A walk-in customer (no customer selected) must pay the whole bill. | `prepareSale()`; the POS window repeats the checks for display only |
| Every payment is a permanent record; it is never edited or deleted. A mistake is corrected by an **administrator reversal** with a mandatory reason, which adds an OUT record (P7). | triggers `trg_payments_no_delete` / `trg_payments_no_update`; `POST /api/payments/:id/reverse` (ADMIN) |
| Every sale and payment carries a unique transaction id (`client_txn_id`). Repeating a request with the same id returns the first result; an id cannot be reused for a different operation (condition 1). | `idempotency_keys`, unique `payments.client_txn_id`, database CHECK |
| An invoice is never paid more than it owes; a payment is never allocated beyond its amount (P1). | service checks plus trigger `trg_alloc_apply_guard` |
| Customer payments and advances settle debts in this order: **1. opening balance, 2. confirmed carried-over balances (oldest first), 3. oldest unpaid invoices**. What is left stays as the customer's advance and is never lost (E5, P2, P3, 2c decision). | `allocateFifo`, `applyAvailableAdvance` |
| A customer's stored balance is changed only together with a ledger row and an audit row: sale (+ due), payment (− amount), reversal (+ amount), void (− what the invoice still owed). Nothing changes a balance silently. | the five balance writes in `server.ts` / `service.ts` (reviewed in Batch 2d) |
| Each invoice keeps its at-sale figures unchanged (`amount_paid`, `amount_due`, `payment_status`, `payment_method`, totals). What it still owes now is `balance_due` / `settlement_status`, kept equal to the allocations by triggers (P1). | triggers `trg_sales_snapshot_guard`, `trg_sales_balance_guard`, `trg_alloc_sync_sale` |
| Void until Batch 4 (P5): refused if the invoice received any payment after the sale; otherwise the payments taken at the sale are reversed (never twice) and kept, and the balance is reduced by exactly what the invoice still owed (the old clamp at 0 was removed). | `DELETE /api/sales/:id` (ADMIN) |
| Balances that no record explains (from before payment tracking) are only reported. An administrator may confirm a **positive** difference as a carried-over balance, with a reason; negative differences stay for manual review (Q1). The stored balance is never changed. | `GET /api/payments/reconciliation`, `POST /api/customers/:id/carried-over-balance` (ADMIN) |

## 2. Who can do what

| Action | ADMIN | STAFF | CUSTOMER |
|---|---|---|---|
| Sell, take payments at the POS, record customer and invoice payments | yes | yes | no |
| Give a discount above the staff limit | yes (reason) | only with an administrator's authorization at the counter | no |
| Reverse a payment, void an invoice | yes (reason for reversal) | no (403) | no |
| Balance review, confirm a carried-over balance | yes | no (403) | no |
| See payments and outstanding items | yes | yes | own invoices via the portal (without payment details) |

All of these are enforced by the host. The screens only hide what a user cannot use.

## 3. Retry protection in the screens

The POS, Receive Payment, Record invoice payment, Reverse payment and Confirm carried-over balance windows all use `src/lib/usePaymentAttempt.ts`:
- **New id:** a transaction id is created when a new attempt begins. A new id is created only when the user starts a new payment (for example "Record another payment").
- **Lost answer:** if the answer is lost (no reply, gateway error, timeout), the window shows **NOT CONFIRMED** and "Retry" sends the **same id**. If the host had already saved it, the answer is "already saved earlier – not recorded twice".
- **Definite refusal:** after a definite refusal or a server error that saved nothing, the **same id** is kept for the corrected retry (verified in Batch 2d).
- **Double click:** a second click while saving is ignored.
- **Result first:** the server's result is shown before another payment can start.

## 4. Database

Tables (all append-only):
- `payments` (IN money; OUT reversals);
- `payment_allocations` (APPLY / RELEASE against an invoice, the opening balance or a confirmed carried-over balance);
- `customer_carried_over_balances`;
- `payment_migration_issues` (report only).

Migrations:
- **0008:** creates the payment tables, carries over all history (one record per paid sale and per ledger payment, replayed in date order) and reports differences.
- **0009:** carried-over balances; rebuilds the allocations table with all rows copied; catch-up.
- **0010:** applies advances that existed before 2c, once.

Each migration runs after a **verified pre-migration backup** (`data/backups/pre-migration-v<from>-to-v<to>-<time>.sqlite`, integrity-checked and row-count-checked) and inside one transaction. Batch 2d verified that a failure, or the program being killed inside 0008, 0009 or 0010, leaves the database exactly as before and that the next start completes the migration.

## 5. Host and client (protocol 4)

- The host reports `apiProtocol: 4` at `/api/health`.
- A client with a different protocol shows the blocking **"Different software versions"** screen. **Update the host and every client together.**
- If an older client still sent requests, the host would stay safe:
  - older POS sales (payment method + amount paid + transaction id) are still recorded correctly with a payment record;
  - older customer-payment requests without a transaction id are refused and write nothing (tested).

## 6. Known limitations

| Limitation | Notes |
|---|---|
| **Not tested on Windows** | Everything in Batches 1–2d was verified on Linux (Electron under a virtual display). See section 7. |
| Two computers on one machine | Host + client tests ran on one computer over 127.0.0.1. A real LAN drop (Wi-Fi, cable) was not tested; lost answers were simulated in the page. |
| Discount authorizations | Kept in the host's memory for 10 minutes; lost if the host restarts (the cashier asks again). A grant used by a sale that then fails is used up. |
| Interim void (until Batch 4) | Still deletes the invoice (payments are kept with the invoice number). Invoices with later payments cannot be voided. A reversal of money taken at a sale is recorded as money returned; linking it to the cash drawer is Batch 3/4. |
| Walk-in payment reversal | Only possible by voiding the sale. |
| Version mismatch | The client's blocking screen stops the user, but its request forwarder does not itself refuse requests in that state. The host stays safe (section 5). Recommended hardening for a later batch: refuse API requests in the client while the versions differ. |
| Money stored as decimal (floating point) | Amounts are rounded to 2 decimals on every write and comparisons allow half a paisa. Very long histories can accumulate sub-paisa differences in stored balances; the reconciliation ignores differences below Rs. 0.005. |
| Advance application | Automatic only when new debt appears (credit sale, carried-over confirmation, reversal). There is no manual "apply advance to a specific invoice" button. |
| Printing | Receipts show split payments on screen; printer selection and thermal printing are Batch 5. |
| **Invoice numbers after a void ([LEGACY-BUG R4], found again in Batch 2d)** | Invoice numbers are "1001 + number of sales". Voiding (deleting) an older invoice lowers that count, so **every later sale gets an existing number and fails** (HTTP 500, fully rolled back, nothing saved) until numbering is fixed. Pre-existing defect of the original app, not caused by payments; the planned fix (sequence table, existing numbers kept) needs approval. Until then: **avoid voiding invoices other than the most recent one.** |
| Same-second history | When history was carried over, events in the same second were ordered sale-before-payment. This affects only which payment was matched to which invoice, never totals. |

## 7. Windows test checklist for Phase 7 payments

Use a **copy** of your pharmacy data, never the original:
1. Close the app.
2. Copy `C:\ProgramData\BrainTechPharmacyAI` to a backup folder.
3. On both PCs (host and clients), run `git pull`, then `git log -1 --oneline`, which must show the latest Batch 2d commit. Then run `npm install` and `npm run desktop`.

Then check:
1. **Migration:** on first start, `data\backups` contains a new `pre-migration-v…-to-v10-…sqlite`. `logs\backend.log` shows the applied migrations and any `[PAYMENTS]` report lines.
2. **Protocol:** `https://127.0.0.1:3747/api/health` on the host shows `"apiProtocol":4`. Each client opens normally (no "Different software versions" screen).
3. **POS split payment:** a bill paid with Cash 500 + Card 80 on Rs. 380 shows change Rs. 200. The receipt lists Card and Cash, cash received and change.
4. **Walk-in rule:** a walk-in customer paying less than the bill gets a message, and Complete stays disabled.
5. **Customer payment:** Customers → choose a customer → Receive Payment. Type an amount: the preview shows what it settles and any advance. Save; check the Open invoices and Payment history tabs.
6. **Retry:** while saving a payment on a client, unplug the host's network cable (or switch off its Wi-Fi) briefly. The client should show NOT CONFIRMED. Reconnect and press Retry: the payment appears once.
7. **Double click:** double-click Record Payment; only one payment appears.
8. **Sales Register:** an invoice with money owed shows "Record payment". Pay part of it; the balance updates. As administrator, Reverse that payment with a reason; it shows REVERSED and the balance returns.
9. **Staff:** a staff user sees no Reverse button and no Balance review.
10. **Balance review:** if your data has unexplained balances from the old app, Customers → Balance review lists them. Confirm one positive difference with a reason, and check that the customer's balance did not change.
11. **Two computers:** a payment made on a client appears immediately on the host and on other clients.

Report anything unexpected with a screenshot and `logs\main.log` / `logs\backend.log`.
