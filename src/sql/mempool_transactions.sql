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
    data        MEDIUMTEXT        -- Decoded data
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
