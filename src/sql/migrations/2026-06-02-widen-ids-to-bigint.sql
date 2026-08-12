--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

-- xchain:migration mode=manual
-- (manual: a one-time column TYPE change across all id/key columns -- run with
--  the decoder stopped, take a backup first; see HOW TO RUN below.)
-- Migration: widen all 32-bit unsigned id/key columns to 64-bit
-- Date: 2026-06-02
--
-- WHY
-- ---
-- Every primary-key, foreign-key, and id-reference column in the decoder schema
-- was declared INTEGER UNSIGNED (32-bit, max 4,294,967,295). The two
-- AUTO_INCREMENT surrogate keys -- index_addresses.id and index_transactions.id --
-- are the binding constraint: once either table accumulates ~4.3 billion unique
-- rows, AUTO_INCREMENT wraps and the next INSERT fails with a duplicate-key
-- error, halting address/hash interning and therefore all block ingestion. The
-- pubkeys, transactions, blocks, dispensers, and transaction_outputs tables all
-- store these ids as foreign keys, so they share the same 32-bit ceiling.
-- (mempool_transactions was de-id'd by 2026-06-15-mempool-raw-strings.sql and
-- no longer holds widenable FK ids.)
--
-- There is no live bug today -- every column is internally consistent and the row
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
-- schema-wide type consistency and -- for block_time -- to lift the year-2106
-- 32-bit-epoch limit.
--
-- pubkeys.address_id carries a real FOREIGN KEY onto index_addresses(id); MariaDB
-- requires a foreign key's two columns to have identical types, so altering one
-- side while the other still differs would error. SET FOREIGN_KEY_CHECKS = 0 does
-- NOT lift that rule for the referenced side: on a legacy DB where both sides are
-- still INT, widening index_addresses.id fails with errno 1833 ("Cannot change
-- column 'id': used in a foreign key constraint 'pubkeys_ibfk_1'") even with
-- checks disabled (observed on MariaDB 10.11 with production-sized databases).
-- The constraint is therefore dropped up front and re-added at the end, once both
-- sides are BIGINT UNSIGNED. IF EXISTS keeps the drop a no-op on fresh DBs, and
-- the paired drop before ADD keeps a manual re-run of this file safe.
--
-- Applies to databases created before 2026-06-02. Fresh installs get BIGINT
-- UNSIGNED directly from src/sql/*.sql and do not need this migration (it stays
-- pending and harmless on a fresh DB since each ALTER is already a no-op).
--
-- HOW TO RUN
-- ----------
--   npm run migrate        # node src/migrate.js -- reads DECODER_DB_* from .env
--
-- Take a backup first. Run while the decoder process is STOPPED -- each ALTER
-- TABLE rebuilds the table and takes a metadata lock; on a large table this can
-- take a while and must not race the running service. Safe to re-run: a MODIFY to
-- a type the column already has is a no-op.
--
-- Validator note: xchain-sync replicates the decoder database to validator
-- nodes, so validator operators should run this same migration against their
-- replica (or re-sync it) after it lands on the canonical node.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop the pubkeys FK so the referenced index_addresses.id can be widened while
-- the two sides temporarily differ (see WHY above); re-added at the end.
ALTER TABLE pubkeys DROP FOREIGN KEY IF EXISTS pubkeys_ibfk_1;

-- ============================================================================
-- index_addresses  (AUTO_INCREMENT surrogate key -- primary overflow constraint)
-- ============================================================================
ALTER TABLE index_addresses    MODIFY id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;

-- ============================================================================
-- index_transactions  (AUTO_INCREMENT surrogate key -- primary overflow constraint)
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

-- Restore the pubkeys FK now that both sides are BIGINT UNSIGNED. The extra
-- IF EXISTS drop makes the ADD safe on a manual re-run of this file.
ALTER TABLE pubkeys DROP FOREIGN KEY IF EXISTS pubkeys_ibfk_1;
ALTER TABLE pubkeys ADD CONSTRAINT pubkeys_ibfk_1 FOREIGN KEY (address_id) REFERENCES index_addresses (id);

SET FOREIGN_KEY_CHECKS = 1;
