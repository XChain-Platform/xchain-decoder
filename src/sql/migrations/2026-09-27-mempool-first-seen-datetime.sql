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

-- xchain:migration mode=manual
-- Manual only because the auto classifier refuses any MODIFY that restates NOT NULL.
--
-- WHY: TIMESTAMP stops at 2038. The SET keeps the stored UTC instant as the
-- DATETIME literal during conversion.
--
-- CONSENSUS NOTE: first_seen is local observation time only and is excluded from
-- xchain-sync replication.
--
-- IDEMPOTENT: MODIFY to the same type is a no-op. The runner baselines this file
-- wherever the column is already DATETIME.
--
-- HOW TO RUN: npm run migrate

SET time_zone = '+00:00';
ALTER TABLE mempool_transactions MODIFY first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
