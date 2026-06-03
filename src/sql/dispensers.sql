DROP TABLE IF EXISTS dispensers;
CREATE TABLE dispensers (
    tx_index       INTEGER UNSIGNED,
    address_id     INTEGER UNSIGNED,
    expiration     DATETIME,
    PRIMARY KEY(tx_index, address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

