DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    tx_index       BIGINT UNSIGNED,
    address_id     BIGINT UNSIGNED,
    expiration     BIGINT UNSIGNED,          -- unix timestamp of dispenser expiration (raw seconds; matches xchain-indexer dispensers.expiration). Stored raw, NOT via FROM_UNIXTIME — a DATETIME/FROM_UNIXTIME round-trip silently NULLs any expiration past 2038 (Y2038), yet the protocol accepts values up to 4294967295 (year 2106).
    PRIMARY KEY(tx_index, address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

