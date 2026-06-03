DROP TABLE IF EXISTS index_transactions;
CREATE TABLE index_transactions (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hash VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- Full-column UNIQUE index: enforces one row per hash at the database level and
-- gives exact (not prefix) lookup selectivity. Combined with the INSERT IGNORE upsert
-- in db.js createTransaction(), this makes hash creation race-safe — two concurrent
-- callers can never produce duplicate ids for the same hash.
-- NOTE: this file only runs on a FRESH database (verifyTables skips existing tables).
-- To upgrade an existing database, run migrations/2026-05-28-unique-index-tables.sql
-- first (it de-duplicates any accumulated rows before applying this UNIQUE index).
CREATE UNIQUE INDEX hash ON index_transactions (hash);

-- Create record for blank/empty transaction
INSERT INTO index_transactions (id,hash) values (1,'');
