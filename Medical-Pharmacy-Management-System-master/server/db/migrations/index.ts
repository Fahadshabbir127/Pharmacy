import type { Migration } from '../migrate';
import { baseline } from './0001_baseline';
import { indexes } from './0002_indexes';
import { restoreLegacyColumns } from './0003_restore_legacy_columns';
import { archiveSupport } from './0004_archive_support';
import { fkPlaceholders } from './0005_fk_placeholders';
import { lanAndIdempotency } from './0006_lan_and_idempotency';
import { batchInventory } from './0007_batch_inventory';
import { payments } from './0008_payments';
import { carriedOverBalances } from './0009_carried_over_balances';
import { applyExistingAdvances } from './0010_apply_existing_advances';
import { invoiceSequences } from './0011_invoice_sequences';

/** Append new migrations here. Never edit or reorder an applied one. */
export const MIGRATIONS: Migration[] = [baseline, indexes, restoreLegacyColumns, archiveSupport, fkPlaceholders, lanAndIdempotency, batchInventory, payments, carriedOverBalances, applyExistingAdvances, invoiceSequences];
