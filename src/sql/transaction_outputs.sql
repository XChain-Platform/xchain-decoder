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

DROP TABLE IF EXISTS transaction_outputs;
CREATE TABLE transaction_outputs (
    tx_index       BIGINT UNSIGNED,
    vout           BIGINT UNSIGNED,
    destination_id BIGINT UNSIGNED, -- id of record in index_addresses
    amount         VARCHAR(250),     -- COIN amount sent
    PRIMARY KEY(tx_index, vout)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

