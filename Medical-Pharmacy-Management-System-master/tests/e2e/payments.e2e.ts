/**
 * Phase 7 Batch 2c, real desktop app (standalone): split payments at the POS with the receipt, customer payment
 * with server preview and advance, retry after a lost answer (same transaction id), double-click protection,
 * invoice payment and admin reversal in the Sales Register, staff permissions, and the administrator's balance
 * review (Q1). Pharmacy date 2026-06-01 (test only). Screenshots go to the test's temp folder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, printOff, Instance } from './helpers';

const ADMIN = { store: 'Noor Pharmacy', owner: 'Sara Ahmed', user: 'owner', password: 'Str0ngPass!', demo: true };
let base: string;
let inst: Instance;
export let SHOTS: string;
const shot = (name: string) => inst.win.screenshot({ path: path.join(SHOTS, name) });

beforeAll(async () => {
  base = tempRoot('payments');
  SHOTS = path.join(base, 'shots');
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(base), 'bt-e2e-payments-shots.txt'), SHOTS); // where the screenshots are (for the report)
  inst = await launch(base);
  await runWizardLocal(inst.win, 'standalone', ADMIN);
  await loginUi(inst.win, ADMIN.user, ADMIN.password);
  await printOff(inst.win);
}, 180_000);
afterAll(async () => { if (inst) await quit(inst); }, 60_000);

const nav = async (label: string) => { await inst.win.click(`button:has-text("${label}")`); };
const customerId = async (name: string) => (await apiFromRenderer(inst.win, 'GET', '/customers')).body.find((c: any) => c.name === name).id as number;
const balance = async (name: string) => (await apiFromRenderer(inst.win, 'GET', '/customers')).body.find((c: any) => c.name === name).current_balance as number;

describe('POS split payments', () => {
  it('cash 500 + card 80 on a 380 bill: change 200 from cash only; the receipt lists each payment', async () => {
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('AG-442'); // Augmentin Rs. 380
    await search.press('Enter');
    await inst.win.waitForSelector('input[title="Click to type quantity manually"]');
    await inst.win.click('button:has-text("CASH")');
    await inst.win.waitForSelector('[data-testid="server-grand-total"]:has-text("Rs. 380.00")');
    await inst.win.fill('input[aria-label="Payment 1 amount"]', '500');
    await inst.win.click('[data-testid="add-payment-row"]');
    await inst.win.selectOption('select[aria-label="Payment 2 method"]', 'CARD');
    await inst.win.fill('input[aria-label="Payment 2 amount"]', '80');
    await inst.win.fill('input[aria-label="Payment 2 reference"]', 'POS-7781');
    expect(await inst.win.locator('[data-testid="pay-change"]').innerText()).toBe('Rs. 200.00');
    expect(await inst.win.locator('[data-testid="pay-total-paid"]').innerText()).toBe('Rs. 380.00');
    await shot('01-pos-split-payment.png');
    await inst.win.click('button:has-text("Complete Sale & Print Receipt")');
    await inst.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    const rec = await inst.win.locator('[data-testid="receipt-payments"]').innerText();
    expect(rec).toMatch(/Card \(POS-7781\):\s*Rs\. 80\.00/);
    expect(rec).toMatch(/Cash:\s*Rs\. 300\.00/);
    expect(rec).toMatch(/Cash received:\s*Rs\. 500\.00/);
    expect(rec).toMatch(/Change:\s*Rs\. 200\.00/);
    await shot('02-receipt-split.png');
    await inst.win.click('button:has-text("Close")');
  }, 120_000);

  it('a walk-in customer must pay in full: the window explains and Complete stays disabled', async () => {
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('BF-109'); // Brufen 175
    await search.press('Enter');
    await inst.win.click('button:has-text("CASH")');
    await inst.win.waitForSelector('[data-testid="server-grand-total"]:has-text("Rs. 175.00")');
    await inst.win.fill('input[aria-label="Payment 1 amount"]', '100');
    await expect.poll(async () => inst.win.locator('[data-testid="payment-row-errors"]').innerText()).toMatch(/Walk-in customer must pay the full bill \(Rs\. 75\.00/);
    expect(await inst.win.locator('button:has-text("Complete Sale & Print Receipt")').isDisabled()).toBe(true);
    await shot('03-walkin-must-pay-full.png');
    await inst.win.click('[aria-label="Close payment"]');
    await inst.win.click('button:has-text("Remove")');
  }, 60_000);
});

describe('Customers: payment with preview, advance, retry and double-click protection', () => {
  it('Tariq (opening balance 1200) pays 1500: preview, a lost answer, safe retry, recorded once; Rs. 300 kept as advance', async () => {
    await nav('Customers & Udhar');
    await inst.win.click('text=Tariq Mahmood >> visible=true');
    await inst.win.click('button:has-text("Receive Payment")');
    const modal = inst.win.locator('[data-testid="customer-payment-modal"]');
    await modal.waitFor();
    await inst.win.fill('input[aria-label="Payment amount"]', '1500');
    await inst.win.selectOption('select[aria-label="Payment method"]', 'MOBILE_WALLET');
    await inst.win.selectOption('select[aria-label="Wallet"]', 'JazzCash');
    await inst.win.fill('input[aria-label="Payment reference"]', 'JC-90011');
    const preview = inst.win.locator('[data-testid="payment-preview"]');
    await expect.poll(async () => preview.innerText(), { timeout: 10_000 }).toMatch(/Opening balance \(owes Rs\. 1200\.00\)\s*Rs\. 1200\.00/);
    expect(await preview.innerText()).toMatch(/Kept as customer advance\s*Rs\. 300\.00/);
    await shot('04-customer-payment-preview.png');

    // the answer is lost after the host saved the payment (simulated in the page: request sent, reply dropped)
    await inst.win.evaluate(() => {
      const orig = window.fetch.bind(window);
      (window as any).__dropNext = true;
      window.fetch = (async (input: any, init?: any) => {
        const r = await orig(input, init);
        if ((window as any).__dropNext && init?.method === 'POST' && String(input).includes('/payment')) {
          (window as any).__dropNext = false;
          throw new TypeError('Failed to fetch (simulated lost answer)');
        }
        return r;
      }) as any;
    });
    await inst.win.click('[data-testid="record-payment"]');
    await inst.win.waitForSelector('[data-testid="payment-unconfirmed"]', { timeout: 15_000 });
    await shot('05-payment-not-confirmed.png');
    const tariq = await customerId('Tariq Mahmood');
    expect((await apiFromRenderer(inst.win, 'GET', `/customers/${tariq}/payments`)).body).toHaveLength(1); // it WAS saved
    await inst.win.click('button:has-text("Retry (same payment)")');
    const result = inst.win.locator('[data-testid="payment-result"]');
    await result.waitFor({ timeout: 15_000 });
    expect(await result.innerText()).toMatch(/already saved earlier - not recorded twice/);
    expect(await inst.win.locator('[data-testid="payment-new-balance"]').innerText()).toBe('Rs. -300.00');
    await shot('06-payment-result-after-retry.png');
    expect((await apiFromRenderer(inst.win, 'GET', `/customers/${tariq}/payments`)).body).toHaveLength(1); // still exactly one

    // double-click on a new payment records it once
    await inst.win.click('button:has-text("Record another payment")');
    await inst.win.fill('input[aria-label="Payment amount"]', '10');
    await inst.win.dblclick('[data-testid="record-payment"]');
    await result.waitFor({ timeout: 15_000 });
    await inst.win.waitForTimeout(500);
    const pays = (await apiFromRenderer(inst.win, 'GET', `/customers/${tariq}/payments`)).body;
    expect(pays.map((p: any) => p.amount)).toEqual([10, 1500]);
    await inst.win.click('button:has-text("Done")');
    expect(await balance('Tariq Mahmood')).toBe(-310);

    // Open invoices tab: nothing owed, advance 310; Payment history tab lists both
    await inst.win.click('button[role="tab"]:has-text("Open invoices")');
    await expect.poll(async () => inst.win.locator('[data-testid="customer-advance"]').innerText()).toBe('Rs. 310.00');
    await inst.win.click('button[role="tab"]:has-text("Payment history")');
    await expect.poll(async () => inst.win.locator('[data-testid="payment-row"]').count()).toBe(2);
    expect(await inst.win.locator('[data-testid="payment-history"]').innerText()).toMatch(/JazzCash[\s\S]*Ref JC-90011[\s\S]*Settled Opening balance: Rs\. 1200\.00/);
    await shot('07-customer-payment-history.png');
  }, 180_000);

  it('the advance settles the customer\'s next credit sale automatically', async () => {
    await nav('Billing / POS');
    const search = inst.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('BF-109'); // 175
    await search.press('Enter');
    const tariq = await customerId('Tariq Mahmood');
    const p = (await apiFromRenderer(inst.win, 'GET', '/inventory')).body.find((x: any) => x.batch_number === 'BF-109');
    // the same sale through the API that the POS uses (customer selection UI is unchanged from earlier phases)
    const r = await apiFromRenderer(inst.win, 'POST', '/sales', { items: [{ product: p, quantity: 1, discount_percent: 0 }], customer_id: tariq, payment_method: 'UDHAR', payments: [], client_txn_id: 'e2e-advance-sale-0001' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ amount_due: 175, balance_due: 0, new_balance: -135 });
    await inst.win.click('button:has-text("Remove")');
  }, 60_000);
});

describe('Batch 2d: transaction id after a failed response', () => {
  it('a failed answer (server error, nothing saved) keeps the SAME transaction id for the retry; the saved payment carries it; a new payment gets a new one', async () => {
    await nav('Customers & Udhar');
    await inst.win.click('text=Tariq Mahmood >> visible=true');
    const tariq0 = await customerId('Tariq Mahmood');
    const before = (await apiFromRenderer(inst.win, 'GET', `/customers/${tariq0}/payments`)).body.length;
    await inst.win.click('button:has-text("Receive Payment")');
    await inst.win.fill('input[aria-label="Payment amount"]', '25');
    const txnText = async () => (await inst.win.locator('text=/^Transaction /').innerText()).replace('Transaction ', '').trim();
    const firstTxn = await txnText();
    // the next payment request is answered with a server error without reaching the host (simulated in the page)
    await inst.win.evaluate(() => {
      const orig = window.fetch.bind(window);
      (window as any).__failNext = true;
      window.fetch = (async (input: any, init?: any) => {
        if ((window as any).__failNext && init?.method === 'POST' && String(input).includes('/payment')) {
          (window as any).__failNext = false;
          return new Response(JSON.stringify({ code: 'PAYMENT_FAILED', error: 'simulated server error, nothing saved' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return orig(input, init);
      }) as any;
    });
    await inst.win.click('[data-testid="record-payment"]');
    await inst.win.waitForSelector('[data-testid="payment-error"]', { timeout: 10_000 });
    expect(await inst.win.locator('[data-testid="payment-error"]').innerText()).toMatch(/simulated server error/);
    expect(await txnText()).toBe(firstTxn); // unchanged after the failure
    expect((await apiFromRenderer(inst.win, 'GET', `/customers/${tariq0}/payments`)).body).toHaveLength(before); // nothing was saved
    await inst.win.click('[data-testid="record-payment"]');
    await inst.win.waitForSelector('[data-testid="payment-result"]', { timeout: 15_000 });
    const saved = (await apiFromRenderer(inst.win, 'GET', `/customers/${tariq0}/payments`)).body;
    expect(saved).toHaveLength(before + 1);
    expect(saved.filter((p: any) => p.client_txn_id === firstTxn)).toHaveLength(1); // the retry used the same id
    await inst.win.click('button:has-text("Record another payment")');
    expect(await txnText()).not.toBe(firstTxn); // a new payment, a new id
    await inst.win.click('[aria-label="Close payment"]');
  }, 120_000);
});

describe('Sales Register: invoice payment and administrator reversal', () => {
  it('pay 1000 on INV-1001 (owes 2450) by bank transfer; then reverse it with a reason; the original stays', async () => {
    await nav('Sales Register');
    const panel = inst.win.locator('[data-testid="invoice-payments-INV-1001"]');
    await panel.waitFor({ timeout: 20_000 });
    expect(await panel.locator('[data-testid="balance-due"]').innerText()).toBe('Rs. 2450.00');
    await panel.locator('button:has-text("Record payment")').click();
    await inst.win.fill('input[aria-label="Invoice payment amount"]', '2450.01');
    expect(await inst.win.locator('[data-testid="record-invoice-payment"]').isDisabled()).toBe(true); // more than owed
    await inst.win.fill('input[aria-label="Invoice payment amount"]', '1000');
    await inst.win.selectOption('select[aria-label="Invoice payment method"]', 'BANK_TRANSFER');
    await inst.win.fill('input[aria-label="Invoice payment reference"]', 'HBL-55');
    await inst.win.click('[data-testid="record-invoice-payment"]');
    await inst.win.waitForSelector('[data-testid="invoice-balance-after"]:has-text("Rs. 1450.00 (PARTIAL)")', { timeout: 15_000 });
    await shot('08-invoice-payment.png');
    await inst.win.click('[data-testid="invoice-payment-modal"] button:has-text("Done")');
    await expect.poll(async () => panel.locator('[data-testid="balance-due"]').innerText()).toBe('Rs. 1450.00');
    expect(await panel.locator('[data-testid="settlement-status"]').innerText()).toBe('Now: PARTIAL');

    // reversal: administrator, reason required
    await expect.poll(async () => panel.locator('[data-testid="payment-row"]').count()).toBeGreaterThanOrEqual(2);
    await panel.locator('[data-testid="payment-row"]', { hasText: 'Bank Transfer' }).locator('button:has-text("Reverse")').click();
    expect(await inst.win.locator('[data-testid="confirm-reverse"]').isDisabled()).toBe(true);
    await inst.win.fill('input[aria-label="Reversal reason"]', 'entered on the wrong invoice');
    await shot('09-reverse-with-reason.png');
    await inst.win.click('[data-testid="confirm-reverse"]');
    await inst.win.waitForSelector('[data-testid="reverse-result"]', { timeout: 15_000 });
    await inst.win.click('[data-testid="reverse-modal"] button:has-text("Done")');
    await expect.poll(async () => panel.locator('[data-testid="balance-due"]').innerText()).toBe('Rs. 2450.00');
    expect(await panel.locator('[data-testid="reversed-badge"]').innerText()).toMatch(/REVERSED: entered on the wrong invoice/);
    expect(await panel.innerText()).toMatch(/Reversal[\s\S]*money out/);
    await shot('10-after-reversal.png');
  }, 120_000);
});

describe('roles: staff', () => {
  it('a staff cashier can record payments but sees no reversal and no balance review', async () => {
    expect((await apiFromRenderer(inst.win, 'POST', '/users', { username: 'counter2', password: 'Counter123', fullName: 'Counter Two', role: 'STAFF' })).status).toBe(200);
    const login = await apiFromRenderer(inst.win, 'POST', '/auth/login', { username: 'counter2', password: 'Counter123' });
    await inst.win.evaluate((b: any) => { localStorage.setItem('khushi_token', b.token); localStorage.setItem('khushi_user', JSON.stringify(b.user)); }, login.body);
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, 'counter2', 'Counter123');
    await nav('Sales Register');
    const panel = inst.win.locator('[data-testid="invoice-payments-INV-1001"]');
    await panel.waitFor({ timeout: 20_000 });
    await panel.locator('button:has-text("Payments")').click();
    await expect.poll(async () => panel.locator('[data-testid="payment-row"]').count()).toBeGreaterThanOrEqual(1);
    expect(await panel.locator('button:has-text("Reverse")').count()).toBe(0);
    await nav('Customers & Udhar');
    await inst.win.click('text=Chaudhry Muhammad Ali >> visible=true');
    await inst.win.waitForSelector('button:has-text("Receive Payment")');
    expect(await inst.win.locator('button:has-text("Balance review")').count()).toBe(0);
    // the host refuses anyway
    const pid = (await apiFromRenderer(inst.win, 'GET', '/payments')).body[0].id;
    expect((await apiFromRenderer(inst.win, 'POST', `/payments/${pid}/reverse`, { reason: 'x', client_txn_id: 'e2e-staff-rev-0001' })).status).toBe(403);
    expect((await apiFromRenderer(inst.win, 'GET', '/payments/reconciliation')).status).toBe(403);
    await shot('11-staff-no-reverse.png');
    // back to the owner
    await inst.win.evaluate(() => { localStorage.removeItem('khushi_token'); localStorage.removeItem('khushi_user'); });
    await inst.win.goto('app://braintech/index.html');
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await printOff(inst.win);
  }, 120_000);
});

describe('administrator balance review (Q1)', () => {
  it('an unexplained balance (from before payment tracking) is listed and confirmed with a reason; the stored balance is not changed', async () => {
    // simulate an old database: the app is closed and one balance is raised directly in the file (test only)
    await quit(inst);
    const req = createRequire(__filename);
    const Database = req('better-sqlite3');
    const db = new Database(path.join(inst.dataRoot, 'data', 'pharmacy.sqlite'));
    db.prepare("UPDATE customers SET current_balance = current_balance + 500 WHERE name = 'Dr. Rashid Ahmad'").run();
    db.close();
    inst = await launch(base);
    await inst.win.waitForURL('app://braintech/index.html', { timeout: 60_000 });
    await loginUi(inst.win, ADMIN.user, ADMIN.password);
    await printOff(inst.win);
    await nav('Customers & Udhar');
    await inst.win.click('text=Dr. Rashid Ahmad >> visible=true');
    await inst.win.click('button:has-text("Balance review")');
    const row = inst.win.locator('[data-testid="mismatch-row"]', { hasText: 'Dr. Rashid Ahmad' });
    await row.waitFor({ timeout: 15_000 });
    expect(await row.innerText()).toMatch(/Rs\. 500\.00[\s\S]*Rs\. 0\.00[\s\S]*Rs\. 500\.00/);
    const btn = row.locator('button:has-text("Confirm Rs. 500.00 as carried-over balance")');
    expect(await btn.isDisabled()).toBe(true); // reason required
    await row.locator('input').fill('Balance from the paper notebook');
    await shot('12-balance-review.png');
    await btn.click();
    await row.locator('[data-testid="confirm-result"]').waitFor({ timeout: 15_000 });
    expect(await balance('Dr. Rashid Ahmad')).toBe(500); // unchanged
    const rec = (await apiFromRenderer(inst.win, 'GET', '/payments/reconciliation')).body;
    expect(rec.mismatches).toEqual([]);
    expect(rec.carried_over_balances).toEqual([expect.objectContaining({ amount: 500, reason: 'Balance from the paper notebook' })]);
    await inst.win.click('[aria-label="Close balance review"]');
    await inst.win.click('button[role="tab"]:has-text("Open invoices")');
    await expect.poll(async () => inst.win.locator('[data-testid="open-item"]').first().innerText()).toMatch(/Confirmed carried-over balance #\d+[\s\S]*Rs\. 500\.00/);
    await shot('13-carried-over-open-item.png');
  }, 180_000);
});
