DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
    tx_index       INTEGER UNSIGNED PRIMARY KEY,
    tx_hash_id     INTEGER UNSIGNED, -- id of record in index_transactions
    block_index    INTEGER UNSIGNED,
    source_id      INTEGER UNSIGNED, -- id of record in index_addresses
    destination_id INTEGER UNSIGNED, -- id of record in index_addresses
    amount         BIGINT,           -- BTC amount sent
    fee            BIGINT,           -- BTC Fee paid (miners fee)
    data           MEDIUMTEXT        -- Decoded data
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE UNIQUE INDEX tx_hash_id     ON transactions (tx_hash_id);
CREATE        INDEX block_index    ON transactions (block_index);
CREATE        INDEX source_id      ON transactions (source_id);
CREATE        INDEX destination_id ON transactions (destination_id);
