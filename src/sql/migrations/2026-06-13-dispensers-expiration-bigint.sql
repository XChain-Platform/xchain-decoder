-- xchain:migration mode=manual
-- (manual: a one-time column TYPE change with a value conversion — run with the
--  decoder stopped, take a backup first; see HOW TO RUN below.)
-- Migration: dispensers.expiration  DATETIME  ->  BIGINT UNSIGNED (raw unix seconds).
--
-- Applies to databases created from an older schema whose dispensers.expiration
-- was a DATETIME populated via FROM_UNIXTIME(). Fresh installs already get
-- BIGINT UNSIGNED from src/sql/dispensers.sql and never need this migration
-- (which is why it is mode=manual: it stays pending and harmless on fresh DBs).
--
-- WHY
-- ---
-- The DISPENSER parser accepts an expiration unix timestamp up to 4294967295
-- (year 2106; XChainDecoder.js). insertDispenser stored it with
-- FROM_UNIXTIME(?), and deleteOpenDispensers compared with FROM_UNIXTIME(?).
-- FROM_UNIXTIME() caps at 2147483647 (Y2038) and returns NULL above it, so any
-- expiration in 2038–2106 was silently stored as NULL. A NULL expiration is
-- never `< block_time`, so such dispensers were NEVER expired by the decoder's
-- per-block sweep — diverging from xchain-indexer, which stores the same field
-- as a raw BIGINT UNSIGNED and expires it correctly. Storing/comparing the raw
-- unix integer removes the Y2038 cap and aligns the two schemas.
--
-- WHAT IT DOES
-- ------------
--   1. Add a BIGINT UNSIGNED holding column (expiration_unix).
--   2. Convert existing DATETIME values with UNIX_TIMESTAMP(). Rows whose
--      expiration is already NULL (the corrupted >2038 rows; the original
--      unix value is unrecoverable) stay NULL — those dispensers were never
--      going to be expired by the old code either, and the table only holds
--      still-open dispensers, so on a live node this set is typically empty.
--   3. Drop the old DATETIME column.
--   4. Rename the holding column to `expiration`.
-- Guarded with IF [NOT] EXISTS so a partial run is safe to resume. The
-- schema_migrations ledger records it once per DB, so it does not re-run (which
-- also protects an already-converted DB from UNIX_TIMESTAMP() on a BIGINT).
--
-- HOW TO RUN
-- ----------
--   npm run migrate        # node src/migrate.js — reads DECODER_DB_* from .env
--
-- Take a backup first. Run while the decoder process is stopped.
--
-- Validator note: xchain-sync replicates the decoder database to validator
-- nodes, so validator operators should run this same migration against their
-- replica (or re-sync it) after it lands on the canonical node.

ALTER TABLE dispensers ADD COLUMN IF NOT EXISTS expiration_unix BIGINT UNSIGNED NULL AFTER address_id;

UPDATE dispensers SET expiration_unix = UNIX_TIMESTAMP(expiration) WHERE expiration IS NOT NULL;

ALTER TABLE dispensers DROP COLUMN IF EXISTS expiration;

ALTER TABLE dispensers CHANGE COLUMN IF EXISTS expiration_unix expiration BIGINT UNSIGNED NULL;
