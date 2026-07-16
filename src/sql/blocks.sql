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

DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    block_index              BIGINT UNSIGNED PRIMARY KEY,
    block_time               BIGINT UNSIGNED,
    block_hash_id            BIGINT UNSIGNED,  -- id of record in index_transactions table
    previous_block_hash_id   BIGINT UNSIGNED   -- id of record in index_transactions table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE INDEX block_hash_id          ON blocks (block_hash_id);
CREATE INDEX previous_block_hash_id ON blocks (previous_block_hash_id);
