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

DROP TABLE IF EXISTS mempool_transactions;
CREATE TABLE mempool_transactions (
    tx_hash     VARCHAR(250),     -- raw transaction hash (NOT an index_transactions id)
    source      VARCHAR(120),     -- raw source address (NOT an index_addresses id)
    destination VARCHAR(120),     -- raw destination address (NOT an index_addresses id)
    amount      BIGINT,           -- BTC amount sent
    fee         BIGINT,           -- BTC Fee paid (miners fee)
    -- utf8mb4 per column, mirroring transactions.data: a pending row must accept exactly
    -- what its confirmed twin accepts, or a non-BMP ACTION fails the mempool INSERT with
    -- errno 1366 and the tx is skipped on every poll. The table default stays utf8mb3 so
    -- the indexed tx_hash VARCHAR(250) stays at 750 bytes, under InnoDB's 767-byte key
    -- limit on a COMPACT-row-format table. Migration: 2026-08-10-action-data-utf8mb4.sql.
    data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,   -- Decoded data
    -- Mirrors transactions.raw_data so the pending row carries the encoder's second push
    -- (FILE bytes, gated ciphertext) instead of only revealing it at confirmation.
    raw_data    MEDIUMBLOB,
    -- When THIS decoder first observed the tx in its node's mempool. Local,
    -- non-deterministic observation time (like everything in this table); the
    -- explorer's pending-actions feed renders it as the row's Time column.
    -- Server-side default so updateMempool's insert-once/delete-on-departure
    -- cycle stamps it with no writer change. Migration: 2026-08-22-mempool-first-seen.sql.
    first_seen  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- Mempool rows hold raw strings rather than index_addresses/index_transactions ids.
-- Mempool observation order is node-local and non-deterministic, so allocating shared
-- lookup ids here would let two nodes assign different ids to the same address/hash.
-- Those lookup tables are part of the replicated decoder set, so the id namespaces
-- would diverge across nodes. Ids are therefore only ever allocated during deterministic
-- block-confirmation processing; this transient table keeps the raw values verbatim.
CREATE UNIQUE INDEX mempool_tx_hash     ON mempool_transactions (tx_hash);
CREATE        INDEX mempool_source      ON mempool_transactions (source);
CREATE        INDEX mempool_destination ON mempool_transactions (destination);
