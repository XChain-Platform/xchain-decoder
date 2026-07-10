DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
    tx_index       BIGINT UNSIGNED PRIMARY KEY,
    tx_hash_id     BIGINT UNSIGNED,           -- id of record in index_transactions
    block_index    BIGINT UNSIGNED,
    source_id      BIGINT UNSIGNED,           -- id of record in index_addresses
    destination_id BIGINT UNSIGNED,           -- id of record in index_addresses
    amount         BIGINT,                     -- Not authoritative: the decoder writes NULL (parseTransaction emits no amount). The indexer derives COIN_AMOUNT from transaction_outputs.
    fee            BIGINT,                     -- Not authoritative: the decoder hardcodes 0 (miner fee is not tracked here). The indexer sets FEE via setActionParams for the actions that use it.
    data           MEDIUMTEXT,                 -- Decoded action string
    raw_data       MEDIUMBLOB                  -- Raw payload bytes (FILE rawData, etc.)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE UNIQUE INDEX tx_hash_id     ON transactions (tx_hash_id);
CREATE        INDEX block_index    ON transactions (block_index);
CREATE        INDEX source_id      ON transactions (source_id);
CREATE        INDEX destination_id ON transactions (destination_id);
