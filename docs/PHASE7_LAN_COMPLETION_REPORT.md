# Phase 7 completion report: LAN Host/Client Foundation

Date: 2026-11-14. Branch `claude/beautiful-einstein-ps972s`.

> **Numbering.** The owner's brief calls this work "Phase 7 — LAN Host/Client Foundation". In this repository's roadmap (`ARCHITECTURE.md` §16) the same scope is **Phase 5** (HTTPS, pairing, pinning, LAN guard, discovery, version check, connection overlay), built together with Phase 4. The roadmap's **Phase 7 is the POS phase**: payments, numbering, shifts, templates, soft-void, native print. Its Batches 1–2e are done; shifts, soft-void and native printing are still open and were **not** touched here. The roadmap's Phase 8 (live refresh across computers) matches the brief's Phase 8 boundary.

## A. Executive summary
The LAN foundation lets one pharmacy computer act as the **host**: it owns the database and serves HTTPS on the local network. Other computers act as **clients**: they pair with a short code, pin the host's certificate, and use the host's data. A **standalone** computer accepts no network connections.

That foundation was already built and tested (Phase 4/5, then hardened in Batches 1–2e). This round audited it against the brief (sections A–H), closed the gaps in automated testing, and fixed two defects:
1. **Before this round, `9224544`:** the pinned client sent requests over a second, unpinned TLS connection. This was the cause of the Windows `ECONNRESET` errors.
2. **This round, `054fcce`:** request timeouts in the pinned client no longer fired. This was a regression introduced by fix 1.

All automated tests pass on Linux. **Windows verification of this round's commits and the physical two-PC test are still open** (section F).

## B. Audit against the brief, and work done

| Area | Status | Evidence (tests) |
|---|---|---|
| **A. Host** | | |
| Starts in host mode, binds `0.0.0.0` with HTTPS only; refuses network binding without TLS | done | `09` host mode test, `09` "refuses to listen on the network without TLS" |
| Reports status (mode, fingerprint, pairing code, clients) | done | `09` (`/api/local/host-status`, local token required) |
| Port already in use: clear failure, nothing left running | **new test** | `15` "a port that is already in use…" (process exits with `EADDRINUSE`) |
| Clean shutdown, port released, repeated cycles, pairings persist | **new test** | `15` "five start/stop cycles…"; `server-helper` tests; Windows exit fix `63c67f0` |
| **B. Client** | | |
| Pairs and connects; shares the host's data | done | `lan.e2e` (two real Electron instances: pairing wizard, sales, stock, payments) |
| Input validation (host, port, code, name) | done (code review) | zod schema `S.pair` in `electron/ipc.ts`. Not unit-tested: the module needs Electron. Exercised by `lan.e2e` |
| Connection failures and timeouts give clear errors | **fixed + new tests** | `pinned-client`: handshake never completes → `ETIMEDOUT`; server never answers → `ETIMEDOUT` (was a hang); host not running → `ECONNREFUSED` |
| Reconnects safely; cannot connect to an unverified host | done | `lan.e2e` "host computer switched off" (blocks, recovers); `pinned-client` and `09` wrong pin refused |
| **C. Pairing** | | |
| Secure codes; wrong code rejected; replay refused; 5 failures rotate the code; 10-minute expiry | done | `lan-guard-pairing` unit tests; `09` wrong code |
| Impostor host (man-in-the-middle) cannot pair even with the right code | done | `09` "a client pairing with an impostor certificate fails" |
| Revoked client refused | done | `lan-guard-pairing` (revoked token → 401); `09` revoke |
| Rate limit (20 attempts per address per 10 minutes) | **new test** | `15` "pairing attempts are limited…" |
| Tokens and codes never logged; only token hashes stored | **new test** | `15` (server log, audit log and stored pairing contain neither) |
| Pairing persists across restarts; the code is new each start (by design: in memory) | **new test** | `15` cycles test |
| **D. Standalone** | | |
| Default binding is loopback only | **new test** | `15` (nothing listens on the network address) |
| Bound to all interfaces, still refuses every non-loopback request | done | `09` standalone test; `lan-guard-pairing` |
| No alternate path gets past the guard (`/API`, `//`, encoded, trailing slash, `./`) | **new test** | `15` (all `/api` spellings 403; non-API paths return no API data) |
| **E. HTTPS and pinning** | | |
| Pin enforced; wrong certificate refused before any data is sent | done | `pinned-client`, `09` |
| The verified socket is the request's socket (no second connection) | done (`9224544`) | `pinned-client` (relay to impostor gets nothing) |
| Socket failures handled; no unhandled errors | done | `pinned-client` reset tests; full suites: 0 unhandled errors |
| Request and connection timeouts work | **fixed (`054fcce`)** | `pinned-client` timeout tests |
| **F. Data integrity over LAN** | done | `10` (50 parallel sales over pinned HTTPS from 3 paired clients: no oversell, stock ≥ 0, unique invoices); `09` idempotent sale replay; `07` crash durability; `13` payment integrity sweep; `14` invoice numbers (30 parallel sales); `lan.e2e` (simultaneous host+client sales of the last unit, double payment accepted once, invoice numbers across computers, host crash after commit → exactly once) |
| **G. Failure and recovery** | done, except where noted | Host unavailable, host switched off and back, host crash during a sale: `lan.e2e`. Connection timeouts: `pinned-client`. Wrong certificate: `09` and `pinned-client`. "Client starts before host" and real network drops: not automated (see the manual plan) |
| **H. Windows stability** | done on Windows for earlier commits; **this round pending** | Owner's Windows run: 29 files / 387 tests, one worker, at `58ada4e`. This round's commits not yet run on Windows |

**Phase 8 items found, not done:** live refresh of other computers' screens after a change (SSE). Today each screen reloads data when opened (`ARCHITECTURE.md` §17).

## C. Fixes in detail
1. **Pinned client used an unverified second connection** (`9224544`, earlier).
   - *Cause:* `agent: false` makes Node ignore `createConnection`, so requests went over a new, unpinned TLS socket. The verified socket stayed open with no error listener, and Windows reset it at server exit, producing the unhandled `read ECONNRESET`.
   - *Fix:* removed `agent: false`.
   - *Tests:* `pinned-client` (one connection per request; a relay to an impostor gets nothing).
2. **Request timeouts did not fire** (`054fcce`, this round). File: `server/lan/pinnedClient.ts`.
   - *Cause:* without an agent, Node never applies the `timeout` request option to the socket. A host that accepted a connection but stopped answering made the heartbeat (3 s), the API proxy (30 s) and the default (15 s) wait indefinitely.
   - *Fix:* `req.setTimeout()` arms the idle timeout explicitly. On timeout the caller gets `ETIMEDOUT` ("did not answer in time") rather than "socket hang up".
   - *Tests:* new timeout tests. On the previous code the "server never answers" test hung for 30 s; it now fails over in about 0.6 s.

## D. Test results (Linux container; the desktop tests run Electron under xvfb)

| Command | Result |
|---|---|
| `npm run lint` (`tsc --noEmit`) | clean |
| Targeted: `pinned-client`, `lan-guard-pairing`, `server-helper`, `09`, `15`, `10`, `13`, `14`, `07` | 9 files, 73/73 passed |
| `npx vitest run --maxWorkers=1 --minWorkers=1` | **30 files, 395/395 passed, 0 failed, 0 unhandled errors, 0 skipped**, 266.8 s |
| `xvfb-run -a npm run test:e2e` (standalone, payments, draft cart, LAN host+client) | **4 files, 44/44 passed**, 0 unhandled errors, 92.9 s |

No server or Electron process was left running after any run.

**Parallel 30-second timeout in `09` (standalone test):** not reproduced. Five runs of `09` under full CPU load on the code before `054fcce` all passed (13/13). Until `054fcce`, a pinned request to a server that accepted but stalled had no request timeout and would wait for Vitest's 30 s limit, which matches the symptom. What made the server stall on Windows is unknown. With `054fcce`, the same situation fails at the request's own timeout with a clear `ETIMEDOUT`. **Not confirmed fixed**; the one-worker baseline remains the reference.

## E. Security review (summary)
- **Network exposure:** standalone listens on loopback only. Host mode requires TLS and accepts only private-LAN addresses.
- **Access control:** every `/api` route except health and pairing needs a paired, unrevoked client token, which the host stores only as a hash. Local administration needs loopback **and** the local token.
- **Pairing:** an HMAC of an 8-character code, bound to the certificate fingerprint. Sessions can't be replayed, the code rotates after 5 failures and expires after 10 minutes, and attempts are limited per address.
- **Pinning:** the SHA-256 pin is checked before any data is sent, and the verified socket carries the request.
- **No weakening:** nothing was weakened, and no TLS check is disabled.

## F. Database safety (summary)
- Every write is one transaction (`BEGIN IMMEDIATE`). Sales and payments carry a required transaction id, so a replay returns the first result.
- Stock is guarded by database checks (`qty_on_hand >= 0`) and allocated FEFO.
- Invoice numbers come from a sequence that never goes down.
- Payment records are append-only (triggers).

The concurrency, crash and replay tests are listed in section B. No database or migration change was made in this round.

## G. Remaining limitations
1. **Windows verification of this round's commits** (`054fcce`, the new tests): pending, to be run by the owner.
2. **Physical two-PC LAN test:** not performed. Every host/client test ran on one computer over `127.0.0.1`. UDP discovery, real Wi-Fi or cable drops and the Windows Firewall prompt are untested. Manual plan below.
3. **Parallel-run timeout in `09`:** not reproduced and not confirmed fixed (section D).
4. **Pairing input validation** is checked by the Electron IPC schema and exercised in E2E, but has no isolated unit test (the module requires Electron).
5. **Repository roadmap Phase 7 (POS)** items still open and out of scope: cash drawer/shifts, soft-void with audit, receipt templates and native thermal printing.
6. **Phase 8 (not started):** live refresh of other computers' screens.

## H. Manual two-PC test (isolated test data only)
Prepare **both** PCs as in `PAYMENTS.md` §7: a separate code folder, and `BRAINTECH_DATA_ROOT` / `BRAINTECH_USER_DATA` pointing to `C:\PharmacyTest\...` folders. Never use the real `C:\ProgramData\BrainTechPharmacyAI`.

**PC 1 (host), with test folders `C:\PharmacyTest\HostData` and `C:\PharmacyTest\HostProfile`:**
1. Start with `npm.cmd run desktop`. Choose **Main pharmacy server › Start a new pharmacy**, with sample data.
2. Allow **Private networks** when Windows Firewall asks.
3. Open **File › Connection & Server Settings** and note the address, port 3747 and the pairing code.
4. Check `curl.exe -k https://127.0.0.1:3747/api/health` → `"mode":"host","apiProtocol":4`.

**PC 2 (client), with test folders `C:\PharmacyTest\ClientData` and `C:\PharmacyTest\ClientProfile`:**
1. Start the app and choose **Connect to the pharmacy server**.
2. Pick PC 1 from the list or type its address, enter the code, then **Pair and connect**.
3. Sign in with PC 1's administrator.
4. A **wrong code** must fail with "code is wrong or the connection is being intercepted".

**Checks:**
1. A sale on PC 2 appears in PC 1's Sales Register with the same invoice number. Stock drops once on both computers.
2. The same customer payment saved twice from PC 2 (double-click, retry) is recorded once.
3. Both PCs sell the last unit of a medicine at the same moment: exactly one succeeds, and stock is 0 on both.
4. Unplug PC 2's network cable or switch off its Wi-Fi. PC 2 shows "Pharmacy server unreachable" and blocks selling. Reconnect: it recovers by itself.
5. **File › Exit** on PC 1 while PC 2 is open. PC 2 blocks. Start PC 1 again: PC 2 reconnects, and every earlier sale is still there.
6. On PC 1, revoke PC 2 under **Paired computers**. PC 2 is refused until it pairs again.
7. **Afterwards:** `Get-FileHash` of the real database must be unchanged (`PAYMENTS.md` §7).

## I. Git summary
- **Commits:**
  - `9224544`, `63c67f0`, `58ada4e` (earlier, already on Windows).
  - `054fcce`: timeout fix and tests.
  - The commit carrying this report and the `15-lan-host` tests.
- **Files changed this round:**
  - `server/lan/pinnedClient.ts`;
  - `tests/unit/pinned-client.test.ts` (3 new tests);
  - `tests/characterization/15-lan-host.test.ts` (new, 5 tests);
  - `docs/PHASE7_LAN_COMPLETION_REPORT.md` (new).
- **Not changed:** no database schema, migration, UI or other production module. The working tree had no local modifications to preserve: `git status` was clean before the work.

## Final status
**PHASE 7 NOT COMPLETE**

Evidence and what remains:
- **Done and evidenced:** every automatable item in the brief (A–H) is implemented and covered by passing tests on Linux. That's 395/395 backend and 44/44 desktop E2E, with 0 unhandled errors.
- **Still required:**
  1. Run this round's commits on Windows 11: `npx.cmd vitest run --maxWorkers=1 --minWorkers=1`, expecting 30 files and 395 tests. Once that passes, the status becomes **PHASE 7 COMPLETE — MANUAL LAN VERIFICATION PENDING**.
  2. The physical two-PC test (section H). When it also passes, the status is **PHASE 7 COMPLETE**.
- **Scope note:** the repository roadmap's own Phase 7 (POS: shifts, soft-void, printing) stays open regardless; see the note at the top.
