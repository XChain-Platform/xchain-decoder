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

DROP TABLE IF EXISTS events;
CREATE TABLE events (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    time DATETIME,
    code VARCHAR(32),
    data MEDIUMTEXT          -- Since M-12 each rolled-back block writes its OWN single-element [{block_index, block_hash}] REORG marker (db.js deleteBlockByIndex), so payload size is bounded and independent of reorg depth; the indexer takes the min across per-event markers and never assumes one event holds the whole range. MEDIUMTEXT is retained for consistency with transactions.data / mempool_transactions.data, not for any reorg-overflow reason.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE INDEX code_id ON events (code, id);

