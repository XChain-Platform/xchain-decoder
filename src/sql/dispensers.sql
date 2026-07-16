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

DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    tx_index             BIGINT UNSIGNED,
    address_id           BIGINT UNSIGNED,
    expiration           BIGINT UNSIGNED,          -- unix timestamp of dispenser expiration (raw seconds; matches xchain-indexer dispensers.expiration). Stored raw, NOT via FROM_UNIXTIME — a DATETIME/FROM_UNIXTIME round-trip silently NULLs any expiration past 2038 (Y2038), yet the protocol accepts values up to 4294967295 (year 2106).
    expired_block_index  BIGINT UNSIGNED DEFAULT NULL,  -- NULL = open. Set to the block height that expired this dispenser instead of hard-deleting the row (soft-expire). A reorg's deleteBlockByIndex clears the mark for orphaned heights, so a dispenser expired by a now-orphaned block's (non-monotonic) timestamp is restored rather than lost. Rows are hard-purged once they are reorg-safe-deep (see DISPENSER_EXPIRE_SAFE_DEPTH in XChainDecoder.js), bounding table growth.
    PRIMARY KEY(tx_index, address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE INDEX dispensers_expired_block_index ON dispensers (expired_block_index);
CREATE INDEX dispensers_expiration ON dispensers (expiration);
