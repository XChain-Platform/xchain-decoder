DROP TABLE IF EXISTS dispenser;
CREATE TABLE dispensers (
    tx_index       INTEGER UNSIGNED,
    address_id     INTEGER UNSIGNED,
    expiration     DATETIME,
    PRIMARY KEY(tx_index, address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

