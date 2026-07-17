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
-- vout carries two disjoint domains under one (tx_index, vout) primary key:
--   * vout <  FUNDING_VOUT_BASE (1000000): a real on-chain output of THIS transaction.
--   * vout >= FUNDING_VOUT_BASE (1000000): a native-coin fee output attributed to a
--     P2SH/P2WSH reveal action but physically living on the FUNDING (commit) tx; stored at
--     (funding vout + FUNDING_VOUT_BASE) so it can never collide with a real reveal-tx vout.
-- The base offset is defined/enforced in the decoder (XChainDecoder.js FUNDING_VOUT_BASE).
CREATE TABLE transaction_outputs (
    tx_index       BIGINT UNSIGNED,
    vout           BIGINT UNSIGNED,
    destination_id BIGINT UNSIGNED, -- id of record in index_addresses
    amount         VARCHAR(250),     -- COIN amount sent
    PRIMARY KEY(tx_index, vout)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

