-- xchain:migration mode=manual
-- (manual: de-duplicates interned rows and rebuilds two indexes — run with the
--  decoder stopped; see HOW TO RUN below.)
-- Migration: enforce full-column UNIQUE indexes on index_addresses (address)
-- and index_transactions (hash).
--
-- Applies to databases created from an older schema whose lookup indexes were
-- plain non-unique prefix indexes: `address(10)` on index_addresses and
-- `hash(20)` on index_transactions. Fresh installs already get the full-column
-- UNIQUE indexes from src/sql/index_addresses.sql / index_transactions.sql.
--
-- WHY
-- ---
-- db.js interns addresses and hashes with INSERT IGNORE + refetch
-- (createAddress / createTransaction), whose race-safety relies on a UNIQUE
-- index over the interned value. Without it, IGNORE never suppresses anything
-- and two concurrent callers can insert duplicate rows for the same address or
-- hash; getAddressId / getTransactionId then resolve the same value to
-- different ids on different calls, corrupting the id references stored in
-- transactions / blocks. The startup drift reconciler only reconciles columns,
-- never indexes, so existing databases must apply this migration explicitly.
--
-- WHAT IT DOES
-- ------------
-- For each of the two interning tables, in order:
--   1. Collect duplicate rows (same address/hash, higher id) into a temp
--      mapping of duplicate id -> kept id, keeping the LOWEST id per value
--      (the row that historical references were resolved against first; also
--      preserves the reserved id=1 blank-value row).
--   2. Repoint every referencing column from duplicate ids to the kept id.
--      Columns under a UNIQUE/PRIMARY KEY constraint use UPDATE IGNORE, then
--      the rows that collided (i.e. a row referencing the kept id already
--      exists, so the skipped row is itself a duplicate record) are deleted:
--      pubkeys.address_id, dispensers.(tx_index,address_id) and
--      mempool_transactions.tx_hash_id. Exception: transactions.tx_hash_id is
--      repointed WITHOUT ignore on purpose — two transactions rows for the
--      same hash would mean duplicated confirmed-transaction data, which this
--      migration must not silently delete. In that case the UPDATE fails with
--      a duplicate-key error, nothing is recorded in the ledger, and the
--      operator must review the affected rows manually before re-running.
--   3. Delete the now-unreferenced duplicate rows.
--   4. Drop the old prefix index and create the full-column UNIQUE index,
--      matching the fresh-install DDL.
--
-- On a database with no accumulated duplicates (the normal case) steps 1-3
-- find nothing and only the index rebuild does work.
--
-- HOW TO RUN
-- ----------
--   npm run migrate        # node src/migrate.js — reads DECODER_DB_* from .env
--
-- Take a backup first. Run while the decoder process is stopped. Safe to
-- re-run: the dedup steps are no-ops once duplicates are gone and the index
-- statements are guarded by IF [NOT] EXISTS.
--
-- Validator note: xchain-sync replicates the decoder database to validator
-- nodes, so validator operators should run this same migration against their
-- replica (or re-sync it) after it lands on the canonical node.

-- ============================ index_addresses ============================

DROP TEMPORARY TABLE IF EXISTS _dup_index_addresses;

CREATE TEMPORARY TABLE _dup_index_addresses (PRIMARY KEY (dup_id)) AS
SELECT dup.id AS dup_id, k.keep_id AS keep_id
  FROM index_addresses dup
  JOIN (SELECT address, MIN(id) AS keep_id
          FROM index_addresses
         GROUP BY address
        HAVING COUNT(*) > 1) k
    ON k.address = dup.address
 WHERE dup.id <> k.keep_id;

UPDATE transactions t
  JOIN _dup_index_addresses d ON t.source_id = d.dup_id
   SET t.source_id = d.keep_id;

UPDATE transactions t
  JOIN _dup_index_addresses d ON t.destination_id = d.dup_id
   SET t.destination_id = d.keep_id;

UPDATE transaction_outputs o
  JOIN _dup_index_addresses d ON o.destination_id = d.dup_id
   SET o.destination_id = d.keep_id;

UPDATE mempool_transactions m
  JOIN _dup_index_addresses d ON m.source_id = d.dup_id
   SET m.source_id = d.keep_id;

UPDATE mempool_transactions m
  JOIN _dup_index_addresses d ON m.destination_id = d.dup_id
   SET m.destination_id = d.keep_id;

-- pubkeys.address_id is the PRIMARY KEY: repoint, then drop rows that collided
-- (the same address already has a pubkeys row through the kept id).
UPDATE IGNORE pubkeys p
  JOIN _dup_index_addresses d ON p.address_id = d.dup_id
   SET p.address_id = d.keep_id;

DELETE p
  FROM pubkeys p
  JOIN _dup_index_addresses d ON p.address_id = d.dup_id;

-- dispensers PRIMARY KEY is (tx_index, address_id): same repoint-then-drop.
UPDATE IGNORE dispensers x
  JOIN _dup_index_addresses d ON x.address_id = d.dup_id
   SET x.address_id = d.keep_id;

DELETE x
  FROM dispensers x
  JOIN _dup_index_addresses d ON x.address_id = d.dup_id;

DELETE a
  FROM index_addresses a
  JOIN _dup_index_addresses d ON a.id = d.dup_id;

DROP TEMPORARY TABLE IF EXISTS _dup_index_addresses;

ALTER TABLE index_addresses DROP INDEX IF EXISTS address;
CREATE UNIQUE INDEX IF NOT EXISTS address ON index_addresses (address);

-- =========================== index_transactions ===========================

DROP TEMPORARY TABLE IF EXISTS _dup_index_transactions;

CREATE TEMPORARY TABLE _dup_index_transactions (PRIMARY KEY (dup_id)) AS
SELECT dup.id AS dup_id, k.keep_id AS keep_id
  FROM index_transactions dup
  JOIN (SELECT hash, MIN(id) AS keep_id
          FROM index_transactions
         GROUP BY hash
        HAVING COUNT(*) > 1) k
    ON k.hash = dup.hash
 WHERE dup.id <> k.keep_id;

UPDATE blocks b
  JOIN _dup_index_transactions d ON b.block_hash_id = d.dup_id
   SET b.block_hash_id = d.keep_id;

UPDATE blocks b
  JOIN _dup_index_transactions d ON b.previous_block_hash_id = d.dup_id
   SET b.previous_block_hash_id = d.keep_id;

-- transactions.tx_hash_id is UNIQUE. Deliberately NOT `UPDATE IGNORE`: a
-- collision here means two confirmed-transaction rows share one hash, and that
-- needs operator review, not silent deletion. The duplicate-key error aborts
-- the migration before anything is recorded; re-run after resolving the rows.
UPDATE transactions t
  JOIN _dup_index_transactions d ON t.tx_hash_id = d.dup_id
   SET t.tx_hash_id = d.keep_id;

-- mempool_transactions.tx_hash_id is UNIQUE, but mempool rows are transient:
-- repoint, then drop the rows that collided (already represented via kept id).
UPDATE IGNORE mempool_transactions m
  JOIN _dup_index_transactions d ON m.tx_hash_id = d.dup_id
   SET m.tx_hash_id = d.keep_id;

DELETE m
  FROM mempool_transactions m
  JOIN _dup_index_transactions d ON m.tx_hash_id = d.dup_id;

DELETE x
  FROM index_transactions x
  JOIN _dup_index_transactions d ON x.id = d.dup_id;

DROP TEMPORARY TABLE IF EXISTS _dup_index_transactions;

ALTER TABLE index_transactions DROP INDEX IF EXISTS hash;
CREATE UNIQUE INDEX IF NOT EXISTS hash ON index_transactions (hash);
