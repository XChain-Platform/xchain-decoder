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
-- (manual: a one-time column TYPE change with a value conversion. Run with the
--  decoder stopped, take a backup first; see HOW TO RUN below.)
-- Migration: dispensers.expiration  DATETIME  ->  BIGINT UNSIGNED (raw unix seconds).
--
-- Applies to databases created from an older schema whose dispensers.expiration
-- was a DATETIME populated via FROM_UNIXTIME(). Fresh installs already get
-- BIGINT UNSIGNED from src/sql/dispensers.sql and never need this migration.
--
-- Do NOT read mode=manual as a safety property. It withholds this file from the
-- unattended startup run only; the blanket `npm run migrate` this header used to
-- advertise applies every PENDING manual file, and on a column
-- that is already BIGINT the UPDATE below reads raw epoch seconds as a date-form
-- number, yields NULL for ordinary 10-digit values, and the drop plus rename then
-- replace the good column with those NULLs. What actually makes the file safe on
-- such a database is the runner-side entry in Database.MIGRATION_PRECONDITIONS
-- (src/db.js): it reads information_schema before applying and records the file
-- as applied without running a statement when the column is already an integer
-- type. Keep that entry. This header is not the guard.
--
-- WHY
-- ---
-- The DISPENSER parser accepts an expiration unix timestamp up to 4294967295
-- (year 2106; XChainDecoder.js). insertDispenser stored it with
-- FROM_UNIXTIME(?), and deleteOpenDispensers compared with FROM_UNIXTIME(?).
-- FROM_UNIXTIME() caps at 2147483647 (Y2038) and returns NULL above it, so any
-- expiration in 2038–2106 was silently stored as NULL. A NULL expiration is
-- never `< block_time`, so such dispensers were NEVER expired by the decoder's
-- per-block sweep, diverging from xchain-indexer, which stores the same field
-- as a raw BIGINT UNSIGNED and expires it correctly. Storing/comparing the raw
-- unix integer removes the Y2038 cap and aligns the two schemas.
--
-- WHAT IT DOES
-- ------------
--   1. Add a BIGINT UNSIGNED holding column (expiration_unix).
--   2. Convert existing DATETIME values with UNIX_TIMESTAMP(). Rows whose
--      expiration is already NULL (the corrupted >2038 rows; the original
--      unix value is unrecoverable) stay NULL. Those dispensers were never
--      going to be expired by the old code either, and the table only holds
--      still-open dispensers, so on a live node this set is typically empty.
--   3. Drop the old DATETIME column.
--   4. Rename the holding column to `expiration`.
-- The IF [NOT] EXISTS guards make each statement individually re-runnable, which
-- is NOT the same as the sequence being resumable. The ledger row is written only
-- after the last statement, so a crash after step 4 leaves a database whose
-- `expiration` is already BIGINT with this file still PENDING, and a bare re-run
-- would add an empty holding column and NULL it over the converted data. The
-- precondition entry named above is what makes that state safe, by baselining the
-- file rather than re-running it. A crash between steps 3 and 4 leaves no
-- `expiration` column at all; that state is deliberately NOT baselined, and it
-- needs an operator.
--
-- HOW TO RUN
-- ----------
--   node src/migrate.js --file 2026-06-13-dispensers-expiration-bigint.sql
--
-- Scope the run to this file so a fleet rollout does not also apply every other
-- pending manual migration in the tree. Take a backup first, and run while the
-- decoder process is stopped.
--
-- Validator note: xchain-sync replicates the decoder database to validator
-- nodes, so validator operators should run this same migration against their
-- replica (or re-sync it) after it lands on the canonical node.

ALTER TABLE dispensers ADD COLUMN IF NOT EXISTS expiration_unix BIGINT UNSIGNED NULL AFTER address_id;

UPDATE dispensers SET expiration_unix = UNIX_TIMESTAMP(expiration) WHERE expiration IS NOT NULL;

ALTER TABLE dispensers DROP COLUMN IF EXISTS expiration;

ALTER TABLE dispensers CHANGE COLUMN IF EXISTS expiration_unix expiration BIGINT UNSIGNED NULL;
