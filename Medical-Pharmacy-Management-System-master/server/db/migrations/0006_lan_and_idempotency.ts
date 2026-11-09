/**
 * 0006 LAN pairing and idempotency.
 *   paired_clients    computers paired with this host (only a hash of each client token is stored)
 *   idempotency_keys  result of each committed write keyed by the client's transaction id, so a retried
 *                     request returns the original result instead of recording it twice (C3)
 */
import type { DbAdapter } from '../adapter';
import type { Migration } from '../migrate';

export const lanAndIdempotency: Migration = {
  version: 6,
  name: 'lan_pairing_and_idempotency',
  up(db: DbAdapter) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS paired_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        last_ip TEXT,
        revoked_at TEXT,
        revoked_by INTEGER
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        route TEXT NOT NULL,
        user_id INTEGER,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
};
