DROP TABLE IF EXISTS mempool_transactions;
CREATE TABLE mempool_transactions (
    tx_hash_id     BIGINT UNSIGNED, -- id of record in index_transactions
    source_id      BIGINT UNSIGNED, -- id of record in index_addresses
    destination_id BIGINT UNSIGNED, -- id of record in index_addresses
    amount         BIGINT,           -- BTC amount sent
    fee            BIGINT,           -- BTC Fee paid (miners fee)
    data           MEDIUMTEXT        -- Decoded data
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE UNIQUE INDEX mempool_tx_hash_id     ON mempool_transactions (tx_hash_id);
CREATE        INDEX mempool_source_id      ON mempool_transactions (source_id);
CREATE        INDEX mempool_destination_id ON mempool_transactions (destination_id);
