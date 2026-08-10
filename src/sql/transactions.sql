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

DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
    tx_index       BIGINT UNSIGNED PRIMARY KEY,
    tx_hash_id     BIGINT UNSIGNED,           -- id of record in index_transactions
    block_index    BIGINT UNSIGNED,
    source_id      BIGINT UNSIGNED,           -- id of record in index_addresses
    destination_id BIGINT UNSIGNED,           -- id of record in index_addresses
    amount         BIGINT,                     -- Not authoritative: the decoder writes NULL (parseTransaction emits no amount). The indexer derives COIN_AMOUNT from transaction_outputs.
    fee            BIGINT,                     -- Not authoritative: the decoder hardcodes 0 (miner fee is not tracked here). The indexer sets FEE via setActionParams for the actions that use it.
    -- utf8mb4 per column, not per table: the encoder validates and emits any valid UTF-8
    -- (a four-byte emoji in a MEMO), which a utf8mb3 column rejects with errno 1366, and
    -- that errno is deterministic so the fee-paid tx is quarantined with no ACTION row.
    -- The table default stays utf8mb3 so no indexed VARCHAR grows past the 767-byte
    -- InnoDB key limit on a COMPACT-row-format table. Migration: 2026-08-10-action-data-utf8mb4.sql.
    data           MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,   -- Decoded action string
    raw_data       MEDIUMBLOB                  -- Raw payload bytes (FILE rawData, etc.)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE UNIQUE INDEX tx_hash_id     ON transactions (tx_hash_id);
CREATE        INDEX block_index    ON transactions (block_index);
CREATE        INDEX source_id      ON transactions (source_id);
CREATE        INDEX destination_id ON transactions (destination_id);
