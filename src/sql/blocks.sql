DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    block_index              BIGINT UNSIGNED PRIMARY KEY,
    block_time               BIGINT UNSIGNED,
    block_hash_id            BIGINT UNSIGNED,  -- id of record in index_transactions table
    previous_block_hash_id   BIGINT UNSIGNED   -- id of record in index_transactions table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE INDEX block_hash_id          ON blocks (block_hash_id);
CREATE INDEX previous_block_hash_id ON blocks (previous_block_hash_id);
