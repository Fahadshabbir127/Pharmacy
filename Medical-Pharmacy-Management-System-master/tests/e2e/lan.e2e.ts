/**
 * Two real desktop app instances on one machine: a HOST (owns the database) and a CLIENT
 * (no local database), paired over HTTPS through the real wizard.
 *
 * Limits of this environment (documented in TESTING_REPORT.md):
 *  - both instances run on one computer, so the client reaches the host over 127.0.0.1;
 *    the "paired client token required from the LAN" rule is covered by unit tests
 *  - UDP discovery cannot be exercised here (the container's only interface is not a private LAN)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, quit, tempRoot, runWizardLocal, loginUi, apiFromRenderer, Instance, sleep } from './helpers';

const ADMIN = { store: 'Shifa Medical Store', owner: 'Owner', user: 'owner', password: 'Str0ngPass!', demo: true };
let hostBase: string;
let clientBase: string;
let host: Instance;
let client: Instance;
let crashMarker: string;
const hostEnv = () => ({ PHARMACY_TEST_CRASH: 'after-commit:POST /api/sales', PHARMACY_TEST_CRASH_ONCE_FILE: crashMarker });

async function waitForState(i: Instance, status: string, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await i.win.evaluate(() => (window as any).braintech.getConnectionState());
    if (s.status === status) return s;
    if (Date.now() > until) throw new Error(`connection state stayed ${s.status} (wanted ${status})`);
    await sleep(500);
  }
}

beforeAll(async () => {
  hostBase = tempRoot('host');
  clientBase = tempRoot('client');
  crashMarker = path.join(hostBase, 'crash-once.marker');
  fs.writeFileSync(crashMarker, 'armed later'); // disarmed until the crash test removes it
  host = await launch(hostBase, hostEnv());
  await runWizardLocal(host.win, 'host', ADMIN);
  await loginUi(host.win, ADMIN.user, ADMIN.password);
  client = await launch(clientBase);
}, 240_000);

afterAll(async () => {
  if (client) await quit(client);
  if (host) await quit(host);
}, 90_000);

describe('pairing', () => {
  it('the host shows its pairing details; the client pairs through the wizard with the code', async () => {
    const st = await host.win.evaluate(() => (window as any).braintech.server.status());
    expect(st).toMatchObject({ running: true, mode: 'host', port: 3747 });
    expect(st.pairing.code).toMatch(/^[A-Z2-9]{8}$/);

    await client.win.click('[data-mode="client"]');
    await client.win.fill('#pairForm [name=host]', '127.0.0.1');
    await client.win.fill('#pairForm [name=port]', '3747');
    await client.win.fill('#pairForm [name=code]', 'WRONGCOD');
    await client.win.fill('#pairForm [name=computerName]', 'Billing Counter');
    await client.win.click('#pairForm button[type=submit]');
    await client.win.waitForSelector('#error:not(.hidden)');
    expect(await client.win.textContent('#error')).toMatch(/code is wrong|intercepted/);

    await client.win.fill('#pairForm [name=code]', st.pairing.code);
    await client.win.click('#pairForm button[type=submit]');
    await client.win.waitForSelector('#step-done:not(.hidden)', { timeout: 30_000 });
    expect(await client.win.textContent('#doneSummary')).toMatch(/Connected to/);
    await client.win.screenshot({ path: path.join(clientBase, '01-paired.png') });
    await client.win.click('#finish');
    await client.win.waitForURL('app://braintech/index.html');

    const after = await host.win.evaluate(() => (window as any).braintech.server.status());
    expect(after.clients.map((c: any) => c.name)).toEqual(['Billing Counter']);
    const cfg = JSON.parse(fs.readFileSync(path.join(client.dataRoot, 'config.json'), 'utf8'));
    expect(cfg.mode).toBe('client');
    expect(cfg.client.fingerprint).toBe(st.fingerprint);
    expect(fs.existsSync(path.join(client.dataRoot, 'data', 'pharmacy.sqlite'))).toBe(false); // a client keeps no database
  }, 120_000);
});

describe('shared data between the two computers', () => {
  it('the client signs in with the host\'s account and sees the host\'s stock', async () => {
    await loginUi(client.win, ADMIN.user, ADMIN.password);
    const inv = (await apiFromRenderer(client.win, 'GET', '/inventory')).body;
    expect(inv).toHaveLength(12);
    const state = await waitForState(client, 'CONNECTED');
    expect(state.isLocal).toBe(false);
  }, 60_000);

  it('a sale made in the client UI updates the host; a stock change on the host is seen by the client', async () => {
    await client.win.click('button:has-text("Print on Save: ON")');
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('RK-221'); // Risek, stock 60
    await search.press('Enter');
    await client.win.waitForTimeout(400);
    await client.win.click('button:has-text("CASH")');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await client.win.click('button:text-is("Close")');

    const onHost = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'RK-221');
    expect(onHost.stock).toBe(59);
    const hist = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body;
    expect(hist.length).toBe(2);

    const adj = await apiFromRenderer(host.win, 'POST', '/inventory/adjust', { product_id: onHost.id, adjustment_type: 'ADD', quantity: 10, reason: 'Delivery' });
    expect(adj.status).toBe(200);
    const onClient = (await apiFromRenderer(client.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'RK-221');
    expect(onClient.stock).toBe(69);
  }, 90_000);
});

describe('host crash after saving a sale, before answering (the hardest case)', () => {
  it('the client shows SALE NOT CONFIRMED, keeps the cart; "Check status" finds the saved sale exactly once', async () => {
    fs.rmSync(crashMarker); // arm the one-shot crash: the host backend dies right after COMMIT of the next sale
    const before = (await apiFromRenderer(client.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'HY-908').stock;
    const search = client.win.locator('input[placeholder^="Scan Barcode or Search Medicine"]');
    await search.fill('HY-908'); // Hydryllin
    await search.press('Enter');
    await client.win.waitForTimeout(400);
    await client.win.click('button:has-text("CASH")');
    await client.win.click('button:has-text("Complete Sale & Print Receipt")');

    await client.win.waitForSelector('text=SALE NOT CONFIRMED', { timeout: 40_000 });
    await client.win.screenshot({ path: path.join(clientBase, '02-not-confirmed.png') });
    expect(fs.existsSync(crashMarker)).toBe(true); // the host really crashed

    // the host app restarts its backend by itself; the client reconnects
    await waitForState(client, 'CONNECTED', 60_000);
    await client.win.click('button:has-text("Check status")');
    await client.win.waitForSelector('text=Invoice / Thermal Receipt', { timeout: 30_000 });
    await client.win.screenshot({ path: path.join(clientBase, '03-confirmed-after-check.png') });

    const after = (await apiFromRenderer(host.win, 'GET', '/inventory')).body.find((p: any) => p.batch_number === 'HY-908').stock;
    expect(after).toBe(before - 1); // recorded exactly once
    const sales = (await apiFromRenderer(host.win, 'GET', '/sales/history')).body;
    expect(sales.length).toBe(3);
  }, 180_000);
});

describe('host computer switched off', () => {
  it('the client blocks selling while the host is away and recovers when it is back', async () => {
    await quit(host);
    await waitForState(client, 'DISCONNECTED', 40_000);
    await client.win.waitForSelector('[data-testid="connection-overlay"]', { timeout: 10_000 });
    await client.win.screenshot({ path: path.join(clientBase, '04-host-away.png') });
    const attempt = await apiFromRenderer(client.win, 'GET', '/inventory');
    expect(attempt.status).toBe(503);
    expect(attempt.body).toMatchObject({ code: 'HOST_UNREACHABLE', outcome: 'UNKNOWN' });

    host = await launch(hostBase, hostEnv());
    await waitForState(client, 'CONNECTED', 60_000);
    await client.win.waitForSelector('[data-testid="connection-overlay"]', { state: 'detached', timeout: 10_000 });
    expect((await apiFromRenderer(client.win, 'GET', '/inventory')).status).toBe(200);
  }, 180_000);
});
