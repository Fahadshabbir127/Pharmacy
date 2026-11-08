import type { Migration } from '../migrate';
import { baseline } from './0001_baseline';
import { indexes } from './0002_indexes';
import { restoreLegacyColumns } from './0003_restore_legacy_columns';

/** Append new migrations here. Never edit or reorder an applied one. */
export const MIGRATIONS: Migration[] = [baseline, indexes, restoreLegacyColumns];
