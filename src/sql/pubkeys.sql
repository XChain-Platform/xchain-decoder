--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

DROP TABLE IF EXISTS pubkeys;
CREATE TABLE pubkeys (
  address_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- 130 hex chars: the producer (extractPubkeyFromInput) accepts BOTH compressed
  -- (33-byte -> 66 hex) and uncompressed (65-byte -> 130 hex) keys. A VARCHAR(66)
  -- here dropped or truncated every uncompressed key (legacy P2PKH), yielding a
  -- NULL/corrupted source_pubkey across the decoder->indexer seam.
  pubkey     VARCHAR(130) NOT NULL,
  -- Monotonic surrogate for id-ordered replication paging only (xchain-sync
  -- streamTableRowsById / _syncLookupTablesPaged). address_id is NOT monotonic
  -- with insert order: a pubkeys row is inserted at first-SPEND, but its
  -- address_id was assigned earlier at first-SEEN, so a freshly inserted row can
  -- carry an address_id below the replica's high-water and be permanently skipped
  -- by an address_id cursor. This AUTO_INCREMENT id increases with insert order
  -- (first-spend order), giving a correct paging cursor. It is replication-local
  -- ONLY and never enters any consensus hash preimage (the indexer hashes the
  -- resolved pubkey/address strings, not these ids), so it has no consensus effect.
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  FOREIGN KEY (address_id) REFERENCES index_addresses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
