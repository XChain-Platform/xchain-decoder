-- Migration: enforce uniqueness on index_addresses / index_transactions
-- Date: 2026-05-28
--
-- WHY
-- ---
-- index_addresses and index_transactions previously carried only a NON-UNIQUE
-- prefix index (address(10) / hash(20)). The application upserted with a
-- SELECT-then-INSERT, which is a time-of-check/time-of-use race: two callers can
-- both observe "no row" and both INSERT, producing duplicate ids for the same
-- logical key. With no UNIQUE constraint those duplicates accumulated silently.
--
-- The schema files (src/sql/index_addresses.sql, src/sql/index_transactions.sql)
-- now declare full-column UNIQUE indexes, and db.js now upserts with INSERT IGNORE
-- + refetch. But those schema files only execute on a FRESH database — verifyTables
-- skips any table that already exists. This script upgrades an EXISTING database:
-- it consolidates any duplicate rows (keeping the lowest id and repointing every
-- foreign-key reference) and then swaps the prefix index for a full-column UNIQUE
-- index. ALTER would fail if run against duplicate data, so the dedup must run first.
--
-- HOW TO RUN
-- ----------
--   mysql -u <user> -p <decoder_db> < migrations/2026-05-28-unique-index-tables.sql
--
-- Take a backup first. Safe to re-run: if the data is already clean the dedup
-- statements are no-ops, and the CREATE UNIQUE INDEX steps are guarded by a drop
-- of the old index name. Run while the decoder process is stopped.

-- ============================================================================
-- index_addresses  (keyed by `address`)
-- ============================================================================

-- Repoint every foreign key from a duplicate address row to the canonical
-- (lowest-id) row for that address.
UPDATE transactions t
  JOIN index_addresses dup ON t.source_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET t.source_id = canon.keep_id
  WHERE t.source_id <> canon.keep_id;

UPDATE transactions t
  JOIN index_addresses dup ON t.destination_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET t.destination_id = canon.keep_id
  WHERE t.destination_id <> canon.keep_id;

UPDATE mempool_transactions m
  JOIN index_addresses dup ON m.source_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET m.source_id = canon.keep_id
  WHERE m.source_id <> canon.keep_id;

UPDATE mempool_transactions m
  JOIN index_addresses dup ON m.destination_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET m.destination_id = canon.keep_id
  WHERE m.destination_id <> canon.keep_id;

UPDATE dispensers d
  JOIN index_addresses dup ON d.address_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET d.address_id = canon.keep_id
  WHERE d.address_id <> canon.keep_id;

UPDATE transaction_outputs o
  JOIN index_addresses dup ON o.destination_id = dup.id
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  SET o.destination_id = canon.keep_id
  WHERE o.destination_id <> canon.keep_id;

-- Delete the now-unreferenced duplicate rows (keep the lowest id per address).
DELETE dup FROM index_addresses dup
  JOIN (SELECT address, MIN(id) AS keep_id FROM index_addresses GROUP BY address) canon
    ON canon.address = dup.address
  WHERE dup.id <> canon.keep_id;

-- Swap the non-unique prefix index for a full-column UNIQUE index.
DROP INDEX address ON index_addresses;
CREATE UNIQUE INDEX address ON index_addresses (address);

-- ============================================================================
-- index_transactions  (keyed by `hash`)
-- ============================================================================

UPDATE transactions t
  JOIN index_transactions dup ON t.tx_hash_id = dup.id
  JOIN (SELECT hash, MIN(id) AS keep_id FROM index_transactions GROUP BY hash) canon
    ON canon.hash = dup.hash
  SET t.tx_hash_id = canon.keep_id
  WHERE t.tx_hash_id <> canon.keep_id;

UPDATE blocks b
  JOIN index_transactions dup ON b.block_hash_id = dup.id
  JOIN (SELECT hash, MIN(id) AS keep_id FROM index_transactions GROUP BY hash) canon
    ON canon.hash = dup.hash
  SET b.block_hash_id = canon.keep_id
  WHERE b.block_hash_id <> canon.keep_id;

UPDATE blocks b
  JOIN index_transactions dup ON b.previous_block_hash_id = dup.id
  JOIN (SELECT hash, MIN(id) AS keep_id FROM index_transactions GROUP BY hash) canon
    ON canon.hash = dup.hash
  SET b.previous_block_hash_id = canon.keep_id
  WHERE b.previous_block_hash_id <> canon.keep_id;

UPDATE mempool_transactions m
  JOIN index_transactions dup ON m.tx_hash_id = dup.id
  JOIN (SELECT hash, MIN(id) AS keep_id FROM index_transactions GROUP BY hash) canon
    ON canon.hash = dup.hash
  SET m.tx_hash_id = canon.keep_id
  WHERE m.tx_hash_id <> canon.keep_id;

DELETE dup FROM index_transactions dup
  JOIN (SELECT hash, MIN(id) AS keep_id FROM index_transactions GROUP BY hash) canon
    ON canon.hash = dup.hash
  WHERE dup.id <> canon.keep_id;

DROP INDEX hash ON index_transactions;
CREATE UNIQUE INDEX hash ON index_transactions (hash);
