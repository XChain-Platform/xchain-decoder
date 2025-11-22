DROP TABLE IF EXISTS open_dispensers;
CREATE TABLE open_dispensers (
    tx_index       INTEGER UNSIGNED,
    address_id     INTEGER UNSIGNED,
    expiration     DATETIME,
    PRIMARY KEY(tx_index, address_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

