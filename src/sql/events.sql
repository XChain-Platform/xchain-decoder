DROP TABLE IF EXISTS events;
CREATE TABLE events (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    time DATETIME,
    code VARCHAR(32),
    data MEDIUMTEXT          -- MEDIUMTEXT (16MB), not TEXT (64KB): a deep reorg serializes ~100 bytes per rolled-back block into a REORG event, so a >~650-block walk would overflow TEXT and silently lose the only audit record. Matches transactions.data / mempool_transactions.data.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE INDEX code_id ON events (code, id);

