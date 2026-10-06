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

-- Local reorg bookkeeping, not replicated: the value each dispenser row held before the first
-- DISPENSE expiration extend of a block, so a reorg of that block can put it back.
CREATE TABLE IF NOT EXISTS dispenser_extension_undo (
    block_index                BIGINT UNSIGNED NOT NULL,  -- height of the block whose extend overwrote the row
    tx_index                   BIGINT UNSIGNED NOT NULL,
    address_id                 BIGINT UNSIGNED NOT NULL,
    prior_expiration           BIGINT UNSIGNED DEFAULT NULL,  -- dispensers.expiration before the block's first extend
    prior_expired_block_index  BIGINT UNSIGNED DEFAULT NULL,  -- dispensers.expired_block_index before the block's first extend
    PRIMARY KEY(block_index, tx_index, address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
