/**
 * Synthetic legacy databases produced by the ORIGINAL application.
 * These become the migration test inputs for Phase 3. This file also records
 * the facts the FK audit and migrations must handle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateFixtures, salvageReport, FixtureManifestEntry } from '../legacy/generate-fixtures';
import { ORIGINAL_SERVER, PROJECT_ROOT } from '../helpers/server';

export const FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', '.fixtures', 'legacy');
const ORIGINAL_SHA256 = '8c2babb7a8d26bc57cd414c90fd233f8a3450be8608a3e95ef964f9c68aa7f76';

let manifest: Record<string, FixtureManifestEntry>;

beforeAll(async () => {
  manifest = await generateFixtures(FIXTURE_DIR);
}, 600_000);

describe('frozen original backend', () => {
  it('tests/legacy/server.original.ts is byte-identical to the audited server.ts (rev ec90af3)', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(ORIGINAL_SERVER)).digest('hex');
    expect(sha).toBe(ORIGINAL_SHA256);
  });
});

describe('generated legacy fixtures', () => {
  it('all fixtures exist and pass integrity_check', () => {
    expect(Object.keys(manifest).sort()).toEqual([
      'after-restart', 'busy-store', 'fresh-first-boot', 'multi-tenant', 'orphans', 'pre-tenant-migrated-by-original', 'pre-tenant-raw',
    ]);
    for (const [name, m] of Object.entries(manifest)) {
      expect(fs.existsSync(path.join(FIXTURE_DIR, m.file)), name).toBe(true);
      expect(m.integrity, name).toEqual([]);
    }
  });

  it('fresh-first-boot: every seeded row has tenant_id NULL', () => {
    const m = manifest['fresh-first-boot'];
    expect(m.nullTenantRows.products).toBe(12);
    expect(m.nullTenantRows.users).toBe(5);
  });

  it('after-restart: tenant_id backfilled except SUPER_ADMIN users', () => {
    const m = manifest['after-restart'];
    expect(m.nullTenantRows.products).toBe(0);
    expect(m.nullTenantRows.users).toBe(2);
  });

  it('busy-store: realistic volumes', () => {
    const m = manifest['busy-store'];
    expect(m.rowCounts.sales_headers).toBe(40); // 1 seed + 40 - 1 voided
    expect(m.rowCounts.purchase_headers).toBe(5);
    expect(m.rowCounts.stock_adjustments).toBe(2);
    expect(m.invariants.ledgerRows).toBeGreaterThan(8);
  });

  it('orphans: FK violations exist for sale_items->products and sales_headers->customers', () => {
    const v = manifest['orphans'].foreignKeyViolations;
    expect(v).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'sale_items', parent: 'products' }),
      expect.objectContaining({ table: 'sales_headers', parent: 'customers' }),
    ]));
  });

  it('multi-tenant: deleting a store leaves orphaned sale_items (their sales_headers were deleted)', () => {
    const v = manifest['multi-tenant'].foreignKeyViolations;
    expect(v).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'sale_items', parent: 'sales_headers' })]));
  });

  it('pre-tenant: the original app migrates the oldest schema, keeping every row and dropping the role CHECK', () => {
    const raw = manifest['pre-tenant-raw'];
    const mig = manifest['pre-tenant-migrated-by-original'];
    for (const t of ['products', 'customers', 'sales_headers', 'sale_items', 'customer_ledger', 'categories', 'suppliers']) {
      expect(mig.rowCounts[t], t).toBe(raw.rowCounts[t]);
    }
    expect(mig.invariants.productStockSum).toBe(raw.invariants.productStockSum);
    expect(mig.invariants.customerBalanceSum).toBe(raw.invariants.customerBalanceSum);
    // [LEGACY-SECURITY S2] the original app adds its two SUPER_ADMIN accounts to an existing customer database
    expect(mig.rowCounts.users).toBe(raw.rowCounts.users + 2);
    expect(mig.rowCounts.tenants).toBe(1);
  });

  it('writes a manifest.json next to the fixtures', () => {
    expect(fs.existsSync(path.join(FIXTURE_DIR, 'manifest.json'))).toBe(true);
  });
});

describe('repository corrupt sample (read through a copy only)', () => {
  it('the sample file is malformed; the original file is left byte-identical', async () => {
    const sample = path.join(PROJECT_ROOT, 'data', 'khushi_pharmacy.sqlite.corrupt.1785024578279');
    const before = crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');
    const report = await salvageReport(sample);
    const after = crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');
    expect(after).toBe(before);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'corrupt-sample-salvage.json'), JSON.stringify(report, null, 2));
    const failed = report.integrity.startsWith('error') || report.integrity.startsWith('cannot') || !report.integrity.includes('"ok"');
    expect(failed).toBe(true);
  });
});
