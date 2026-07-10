DROP TABLE IF EXISTS index_addresses;
CREATE TABLE index_addresses (
    id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- Full-column UNIQUE index: enforces one row per address at the database level and
-- gives exact (not prefix) lookup selectivity. Combined with the INSERT IGNORE upsert
-- in db.js createAddress(), this makes address creation race-safe — two concurrent
-- callers can never produce duplicate ids for the same address.
-- NOTE: this file only runs on a FRESH database (verifyTables skips existing tables).
-- To upgrade an existing database, run `npm run migrate` (or src/sql/migrations/2026-05-28-unique-index-tables.sql)
-- first (it de-duplicates any accumulated rows before applying this UNIQUE index).
CREATE UNIQUE INDEX address ON index_addresses (address);

-- Create record for blank/empty address
INSERT INTO index_addresses (id,address) values (1,'');
