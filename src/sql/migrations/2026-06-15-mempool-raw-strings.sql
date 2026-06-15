-- xchain:migration mode=manual
-- (manual: drops and recreates mempool_transactions — a structural column change,
--  not an additive one. Safe because the table is transient.)
--
-- Migration: mempool_transactions FK-id columns -> raw string columns.
--
--   tx_hash_id     BIGINT (index_transactions id)  ->  tx_hash     VARCHAR(250)
--   source_id      BIGINT (index_addresses   id)  ->  source      VARCHAR(120)
--   destination_id BIGINT (index_addresses   id)  ->  destination VARCHAR(120)
--
-- WHY
-- ---
-- Mempool ingestion used to pre-allocate index_addresses / index_transactions rows
-- so it could store integer ids. But mempool arrival order is node-local and
-- non-deterministic, while those lookup tables are part of the replicated decoder
-- set. Two nodes therefore assigned different AUTO_INCREMENT ids to the same
-- address / tx-hash purely based on which they happened to see first. A follower
-- that snapshots its lookup tables from one source and then streams live block data
-- from another would mix two incompatible id namespaces, silently resolving
-- transactions.source_id / destination_id to the wrong address — and decoder sync
-- has no hash-rejection guard to catch the skew.
--
-- The fix stores raw strings in mempool_transactions (which is intentionally
-- excluded from replication) and allocates lookup ids only during deterministic
-- block-confirmation processing, where every node following the same chain assigns
-- identical ids. mempool_transactions is transient — it is rebuilt from the live
-- mempool on the next poll (within MEMPOOL_INTERVAL = 60s) — so dropping and
-- recreating it loses nothing durable.
--
-- This matches src/sql/mempool_transactions.sql exactly. Fresh installs get the new
-- structure from that file and never run this migration.

DROP TABLE IF EXISTS mempool_transactions;

CREATE TABLE mempool_transactions (
    tx_hash     VARCHAR(250),
    source      VARCHAR(120),
    destination VARCHAR(120),
    amount      BIGINT,
    fee         BIGINT,
    data        MEDIUMTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE UNIQUE INDEX mempool_tx_hash     ON mempool_transactions (tx_hash);
CREATE        INDEX mempool_source      ON mempool_transactions (source);
CREATE        INDEX mempool_destination ON mempool_transactions (destination);
