-- Migration: widen all 32-bit unsigned id/key columns to 64-bit
-- Date: 2026-06-02
--
-- WHY
-- ---
-- Every primary-key, foreign-key, and id-reference column in the decoder schema
-- was declared INTEGER UNSIGNED (32-bit, max 4,294,967,295). The two
-- AUTO_INCREMENT surrogate keys — index_addresses.id and index_transactions.id —
-- are the binding constraint: once either table accumulates ~4.3 billion unique
-- rows, AUTO_INCREMENT wraps and the next INSERT fails with a duplicate-key
-- error, halting address/hash interning and therefore all block ingestion. The
-- pubkeys, transactions, blocks, dispensers, transaction_outputs and
-- mempool_transactions tables all store these ids as foreign keys, so they share
-- the same 32-bit ceiling.
--
-- There is no live bug today — every column is internally consistent and the row
-- counts are nowhere near the limit. This is a forward-looking schema upgrade: it
-- lifts the whole decoder schema to BIGINT UNSIGNED (64-bit, max ~1.8e19),
-- removing the overflow ceiling and aligning the decoder with the indexer schema,
-- which already uses BIGINT UNSIGNED for the same columns.
--
-- WHAT IT DOES
-- ------------
-- ALTERs every INTEGER UNSIGNED column across all eight tables to BIGINT
-- UNSIGNED, one MODIFY per column. AUTO_INCREMENT and NOT NULL attributes are
-- respecified on each MODIFY (MODIFY COLUMN redefines the column wholesale, so an
-- omitted attribute would be dropped). block_time (a unix timestamp) and
-- transaction_outputs.vout are not id columns but are widened too, both for
-- schema-wide type consistency and — for block_time — to lift the year-2106
-- 32-bit-epoch limit.
--
-- pubkeys.address_id carries a real FOREIGN KEY onto index_addresses(id); MariaDB
-- requires a foreign key's two columns to have identical types, so altering one
-- side while the other still differs would error. FOREIGN_KEY_CHECKS is therefore
-- disabled for the duration and re-enabled at the end; both sides end at the same
-- BIGINT UNSIGNED type, so the constraint is valid again once checks are restored.
--
-- HOW TO RUN
-- ----------
--   mysql -u <user> -p <decoder_db> < migrations/2026-06-02-widen-ids-to-bigint.sql
--
-- Take a backup first. Run while the decoder process is STOPPED — each ALTER
-- TABLE rebuilds the table and takes a metadata lock; on a large table this can
-- take a while and must not race the running service. Safe to re-run: a MODIFY to
-- a type the column already has is a no-op.
--
-- The schema source files in src/sql/ now declare BIGINT UNSIGNED directly, so a
-- FRESH database created by verifyTables() starts with the correct types and does
-- not need this migration. verifyTables()/alterTableForDrift() only reconciles
-- missing columns and nullability — never column types — so an EXISTING database
-- must be upgraded with this script.
--
-- VALIDATOR NOTE
-- --------------
-- xchain-sync replicates the decoder database to validator nodes. The replicated
-- column types follow the source schema, so after this upgrade lands on the
-- canonical node, validator operators should run this same migration against
-- their decoder replica (or re-sync it) so replica and canonical schemas match.

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
-- index_addresses  (AUTO_INCREMENT surrogate key — primary overflow constraint)
-- ============================================================================
ALTER TABLE index_addresses    MODIFY id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

-- ============================================================================
-- index_transactions  (AUTO_INCREMENT surrogate key — primary overflow constraint)
-- ============================================================================
ALTER TABLE index_transactions MODIFY id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

-- ============================================================================
-- pubkeys  (PK + FOREIGN KEY -> index_addresses.id)
-- ============================================================================
ALTER TABLE pubkeys            MODIFY address_id             BIGINT UNSIGNED NOT NULL;

-- ============================================================================
-- blocks
-- ============================================================================
ALTER TABLE blocks             MODIFY block_index            BIGINT UNSIGNED NOT NULL;
ALTER TABLE blocks             MODIFY block_time             BIGINT UNSIGNED;
ALTER TABLE blocks             MODIFY block_hash_id          BIGINT UNSIGNED;
ALTER TABLE blocks             MODIFY previous_block_hash_id BIGINT UNSIGNED;

-- ============================================================================
-- transactions
-- ============================================================================
ALTER TABLE transactions       MODIFY tx_index               BIGINT UNSIGNED NOT NULL;
ALTER TABLE transactions       MODIFY tx_hash_id             BIGINT UNSIGNED;
ALTER TABLE transactions       MODIFY block_index            BIGINT UNSIGNED;
ALTER TABLE transactions       MODIFY source_id              BIGINT UNSIGNED;
ALTER TABLE transactions       MODIFY destination_id         BIGINT UNSIGNED;

-- ============================================================================
-- dispensers  (composite PRIMARY KEY (tx_index, address_id))
-- ============================================================================
ALTER TABLE dispensers         MODIFY tx_index               BIGINT UNSIGNED NOT NULL;
ALTER TABLE dispensers         MODIFY address_id             BIGINT UNSIGNED NOT NULL;

-- ============================================================================
-- transaction_outputs  (composite PRIMARY KEY (tx_index, vout))
-- ============================================================================
ALTER TABLE transaction_outputs MODIFY tx_index              BIGINT UNSIGNED NOT NULL;
ALTER TABLE transaction_outputs MODIFY vout                  BIGINT UNSIGNED NOT NULL;
ALTER TABLE transaction_outputs MODIFY destination_id        BIGINT UNSIGNED;

-- ============================================================================
-- mempool_transactions
-- ============================================================================
ALTER TABLE mempool_transactions MODIFY tx_hash_id           BIGINT UNSIGNED;
ALTER TABLE mempool_transactions MODIFY source_id            BIGINT UNSIGNED;
ALTER TABLE mempool_transactions MODIFY destination_id       BIGINT UNSIGNED;

SET FOREIGN_KEY_CHECKS = 1;
