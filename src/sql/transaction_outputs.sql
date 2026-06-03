DROP TABLE IF EXISTS transaction_outputs;
CREATE TABLE transaction_outputs (
    tx_index       BIGINT UNSIGNED,
    vout           BIGINT UNSIGNED,
    destination_id BIGINT UNSIGNED, -- id of record in index_addresses
    amount         VARCHAR(250),     -- COIN amount sent
    PRIMARY KEY(tx_index, vout)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

