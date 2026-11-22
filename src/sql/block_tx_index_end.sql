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

-- Local cursor bookkeeping, not replicated: the tx_index cursor at the end of each stored block,
-- counting carriers that consumed an index but wrote no row, so a restart resumes numbering there.
CREATE TABLE IF NOT EXISTS block_tx_index_end (
    block_index   BIGINT UNSIGNED PRIMARY KEY,  -- height of the stored block
    tx_index_end  BIGINT UNSIGNED NOT NULL      -- parse loop tx_index cursor once the block is parsed
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
