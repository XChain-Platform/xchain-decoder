DROP TABLE IF EXISTS dispenser_outputs;
CREATE TABLE dispenser_outputs (
    tx_index       INTEGER UNSIGNED,
    vout           INTEGER UNSIGNED,
    destination_id INTEGER UNSIGNED, -- id of record in index_addresses
    amount         BIGINT,           -- BTC amount sent
    PRIMARY KEY(tx_index, vout)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

