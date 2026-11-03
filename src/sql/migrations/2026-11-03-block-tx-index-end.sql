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

-- xchain:migration mode=auto
-- (auto: one new table, no change to any existing table, no backfill.
--  Idempotent via CREATE TABLE IF NOT EXISTS.)
--
-- Migration: CREATE TABLE block_tx_index_end
--
-- WHY
-- ---
-- A carrier whose ACTION is skipped (unknown name, oversized) consumes a
-- tx_index but writes no transactions row. When it is the last storable
-- carrier of a block, MAX(transactions.tx_index) sits one below the parse
-- loop's cursor, so a decoder that restarted or rolled back right after
-- that block handed the consumed index to the next carrier. The decoder now
-- records the cursor at each block's end here and resumes from the larger of
-- the two.
--
-- LOCAL TABLE
-- -----------
-- Decoder bookkeeping only. xchain-sync never replicates this table, so it
-- changes no replicated schema and needs no replication schema version bump.
-- A reorg deletes a block's row with the block. Until the first block is
-- stored after this migration the table is empty and the cursor falls back
-- to MAX(transactions.tx_index) exactly as before.
--
-- IDEMPOTENT: a no-op once applied, and src/sql/block_tx_index_end.sql
-- creates the same table on fresh installs. Applies automatically at
-- decoder startup.

CREATE TABLE IF NOT EXISTS block_tx_index_end (
    block_index   BIGINT UNSIGNED PRIMARY KEY,
    tx_index_end  BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
