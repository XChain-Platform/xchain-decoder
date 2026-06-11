# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `src/BlockchainConnector.js` — `getRawTransactions()` now fetches with bounded concurrency instead of firing every request at once. `updateMempool` hands it chunks of up to 1000 txids, and `Promise.all` over the full chunk held up to 1000 simultaneous sockets against the operator's own coin node — file-descriptor pressure plus RPC work-queue churn (`-429` work-queue rejections on BTC/LTC, outright connection drops on Dogecoin v1.14), with each failed call retried up to 10×, which could stall mempool processing on a large mempool. Requests now run in order-preserving sub-batches of `DECODER_RPC_CONCURRENCY` (default 50). Result order, the all-or-nothing rejection contract, and per-call retry behavior are unchanged. Unit tests assert the in-flight bound (override and default), order preservation, the empty-list case, and batch-failure propagation.
- `src/XChainBlockDecoder.js` — the Litecoin `blockFromBuffer` path sanity-bounds the varint transaction count before looping. A forged count previously failed only via an incidental buffer over-read inside `Transaction.fromBuffer` (an unguarded loop with an unnamed exit); a count exceeding `remaining_bytes / 10` — structurally impossible, since the smallest serialized transaction is well over 10 bytes — now throws a named `invalid transaction count` error before the loop starts. Defense-in-depth only: block bytes come from the operator's own trusted node. Unit tests cover the forged count and the honest single-tx block.
- `src/sql/pubkeys.sql` — collation aligned to `utf8_unicode_ci`, matching every other decoder table (it was the lone `utf8_general_ci` outlier). No data impact — the table stores a BIGINT key and ASCII hex pubkeys, both collation-insensitive — and no migration is needed: existing databases keep working as-is, the DDL only affects fresh installs.

- `src/db.js` — `verifyTables()` now reconciles declared indexes on existing tables, not just columns (new `parseExpectedIndexes()` / `reconcileTableIndexes()` / `dedupeForUniqueIndex()`, ported from the indexer's equivalents). The decoder's startup drift path previously handled existing tables with `alterTableForDrift()` (columns/nullability only), so any `CREATE [UNIQUE] INDEX` statement added to a `src/sql/` source after a table's initial creation was silently never applied to existing databases — six table sources declare standalone indexes today, and a missing UNIQUE index silently degrades any `INSERT … ON DUPLICATE KEY UPDATE` relying on it into a plain INSERT that accumulates duplicate rows (the structural root of the 2026-05-28 unique-index migration gap). Reconciliation matches live indexes by ordered column set (a renamed-but-equivalent index counts as present), leaves name collisions alone, and for a UNIQUE add blocked by pre-existing duplicates dedupes first (keeping the highest-`id` row per group, NULL tuples preserved to match UNIQUE semantics) then retries; it never throws — failures log and startup continues, and on an up-to-date table it is a single `information_schema` read. Unit coverage: index parsing (regular/unique/multi-column/other-table/commented-out), missing-index add, renamed-equivalent no-op, name-collision skip, dedupe-then-retry, no-`id`-column skip, and unreadable-source non-fatality.
- `src/XChainDecoder.js` — input/block hash buffers are now copied before byte-reversal at the three remaining bare sites (`Buffer.from(outputTransaction.ins[0].hash).reverse()` in the P2SH/P2WSH funding-tx lookup, `Buffer.from(transaction.ins[0].hash).reverse()` in `parseTransaction`, and `Buffer.from(block.prevHash).reverse()` in the block loop), matching the defensive form already used in `XChainBlockDecoder.js`. `Buffer.prototype.reverse()` mutates in place and returns the same buffer; the bare `.reverse()` calls flipped the shared decoded-block/transaction buffers in place. The block-loop site was the root cause behind the `previous_block_hash` double-reverse regression (R-BUG-001) — previously worked around by reusing the already-computed `previousBlockHash` variable rather than reversing a second time; copying before reversal fixes it at the source. The other two sites were latent: `transaction.ins[0].hash` and `outputTransaction.ins[0].hash` were mutated for any future code that re-reads them after the txid is computed. The R-BUG-001 regression test continues to pass.
- `src/sql/dispensers.sql` — corrected the leading `DROP TABLE IF EXISTS dispenser;` (singular) to `DROP TABLE IF EXISTS dispensers;` (plural) so it targets the `dispensers` table the file actually creates. The mismatched DROP silently no-opped, so running the file directly against an existing database (a manual schema rebuild during disaster recovery) left the old `dispensers` table in place and the subsequent `CREATE TABLE dispensers` then failed with "table already exists". `verifyTables()` only runs this file when the table is absent, so the bug never affected a running service — the change is a manual-rebuild safety fix.
- `src/sql/pubkeys.sql` — normalized to the `DROP TABLE IF EXISTS pubkeys; CREATE TABLE pubkeys (…)` reset pattern used by every other table's DDL in this service. It previously opened with `CREATE TABLE IF NOT EXISTS` and no preceding `DROP`, so running the file directly against an existing database (a manual schema rebuild during disaster recovery or fresh-environment setup) silently no-opped instead of resetting the table, masking a failed rebuild. `verifyTables()` skips already-existing tables, so this path is never exercised on a running service — the change is purely a manual-rebuild safety and consistency fix.
- `src/api.js` — `AUX_POW` is now parsed as an explicit boolean (`process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'`) instead of being passed through as the raw environment string. The value flows into `XChainDecoder` and is consumed in bare truthy checks, so any non-empty string — including `AUX_POW=false`, `AUX_POW=0`, or `AUX_POW=no` — previously evaluated as truthy and *enabled* AuxPoW mode, the opposite of operator intent. Setting `AUX_POW=false` now correctly disables it on every chain.

### Removed
- `src/BlockchainConnector.js` — removed the unused `getMempoolEntry(txid)` method (wrapping the `getmempoolentry` JSON-RPC call) along with its dedicated unit tests and chaos-helper stub. The method had no caller anywhere in the service; leaving an unexercised RPC wrapper on the connector risked silently drifting out of sync with coin-node response shapes (e.g. Bitcoin Core's `fee` → `fees.base` field rename) for any future consumer. Removing it shrinks the connector surface to what the service actually uses.

### Changed
- `package.json` — pinned `mariadb` 3.5.2, `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions (dropped the `^` caret ranges) so every install resolves a byte-identical dependency tree across operator nodes, matching the versions already frozen in `package-lock.json`. No source changes.
- `src/sql/*.sql` — widened every `INTEGER UNSIGNED` id/key column in the schema to `BIGINT UNSIGNED` across all eight tables (`blocks`, `transactions`, `index_addresses`, `index_transactions`, `dispensers`, `transaction_outputs`, `mempool_transactions`, `pubkeys`). The two `AUTO_INCREMENT` surrogate keys — `index_addresses.id` and `index_transactions.id` — were the binding constraint: at ~4.3 billion unique interned rows the 32-bit counter would wrap and the next `INSERT` would fail with a duplicate-key error, halting address/hash interning and therefore all block ingestion; every foreign-key column that references those ids shared the same 32-bit ceiling. No live bug exists today (every column is internally consistent and row counts are far below the limit) — this is a forward-looking upgrade that removes the overflow ceiling and aligns the decoder with the indexer schema, which already uses `BIGINT UNSIGNED` for the same columns. `block_time` (a unix timestamp) and `transaction_outputs.vout` are not id columns but were widened too, for schema-wide type consistency and — for `block_time` — to lift the year-2106 32-bit-epoch limit. These edits only affect a **fresh** database (`verifyTables()` creates tables from these files but never alters the type of an existing column). A one-time migration for existing databases ships at `migrations/2026-06-02-widen-ids-to-bigint.sql` — it `MODIFY`s each of the 20 columns to `BIGINT UNSIGNED`, respecifying `AUTO_INCREMENT`/`NOT NULL` per column and wrapping the run in `SET FOREIGN_KEY_CHECKS=0/1` so the real `pubkeys.address_id -> index_addresses.id` foreign key (which MariaDB requires to have matching column types) does not transiently mismatch mid-migration (run with the decoder stopped; take a backup; safe to re-run). **Validator note:** `xchain-sync` replicates the decoder database to validator nodes, so after this lands on the canonical node, validator operators should run the same migration against their replica (or re-sync it) so replica and canonical schemas match.
- `src/api.js` — migrated the `rateLimit()` configuration from the deprecated `max` option to its canonical `limit` replacement (renamed in `express-rate-limit` v8, which this service already runs). `max` remains a backward-compatible alias today, so this is a behavior-preserving rename that forward-protects against a future major release dropping it.
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.

### Added
- `src/sql/migrations/2026-05-28-unique-index-tables.sql` — added the one-time `mode=manual` migration that upgrades an existing database to the full-column UNIQUE indexes on `index_addresses (address)` and `index_transactions (hash)` that fresh installs already get from the DDL. Both DDL files have pointed operators at this migration by name since the UNIQUE indexes were introduced, but the file itself was never shipped — the documented upgrade path ended in a file-not-found, and since the startup drift reconciler reconciles columns but never indexes, pre-existing databases silently kept their legacy non-unique prefix indexes (`address(10)` / `hash(20)`) and lacked the constraint that the `INSERT IGNORE` race-safety in `createAddress()` / `createTransaction()` relies on. The migration de-duplicates any accumulated rows keeping the lowest id per address/hash, first repointing every referencing column (`transactions.source_id`/`destination_id`/`tx_hash_id`, `blocks.block_hash_id`/`previous_block_hash_id`, `transaction_outputs.destination_id`, `mempool_transactions.tx_hash_id`/`source_id`/`destination_id`, `dispensers.address_id`, `pubkeys.address_id`) to the kept row so no dangling ids are left behind (columns under a UNIQUE/PRIMARY KEY constraint use `UPDATE IGNORE` and the collided rows — themselves duplicate records — are then deleted), then drops the legacy prefix index and creates the full-column UNIQUE index. One deliberate exception: two confirmed `transactions` rows sharing the same hash abort the run with a duplicate-key error for operator review instead of being silently deleted. Apply via `npm run migrate` with the decoder stopped; take a backup first; safe to re-run. **Validator note:** `xchain-sync` replicates the decoder database to validator nodes, so validator operators should run the same migration against their replica (or re-sync it) after it lands on the canonical node.
- `src/db.js` — `verifyTables()` now reconciles column drift on existing tables at startup, mirroring the indexer. Each table's live columns are compared against its SQL source (new `parseExpectedColumns()` / `alterTableForDrift()` helpers) and any column present in the source but missing from the live table is added with `ALTER TABLE ... ADD COLUMN`, reusing the source definition verbatim so its `DEFAULT` clause backfills existing rows; a `NOT NULL` column with no `DEFAULT` is skipped with a warning rather than aborting startup, and nullability drift is relaxed in the safe direction only (`NOT NULL` → `NULL`). Previously an already-existing table was left untouched, so a column added to the schema after a stack was first installed (e.g. `transactions.raw_data`) was never applied on upgrade and any query referencing it failed with a hard `Unknown column` error until a migration was hand-authored. Fresh installs are unaffected (tables are still created in full from the SQL source).
- `src/api.js`, `.env.example` — the API rate limit is now tunable via the `DECODER_RATE_LIMIT_RPM` environment variable (default `100` requests/minute per IP — unchanged from the previously hardcoded value, so deployments that do not set it see no behavior change). The decoder previously had no runtime override path at all; it now follows the platform-wide per-service `<SERVICE>_RATE_LIMIT_RPM` rate-limit naming convention.
- `src/api.js` — the `health()` JSON-RPC response now includes a `lag_blocks` field: `max(0, node_height - last_processed_block)`, null-guarded for the pre-first-sync window. Previously the response carried the node tip and last-processed block but no single clamped block-count delta, so an operator (or an alerting threshold) could not read "how far behind" directly during a long initial sync — only derive it. `lag_blocks` gives a non-negative numeric lag operators can threshold an alert on and use to estimate sync ETA.
- `.env.example` — added a configuration template enumerating every environment variable the decoder reads (coin/network, coin-node RPC, decoder database, API port), with safe regtest/placeholder defaults and inline comments, so operators have a single reference for configuring the service instead of discovering variables by reading the source.
- `src/db.js` — the MariaDB connection pool now sets `queryTimeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000`. Without a query timeout a slow or lock-blocked statement had no upper bound and could hang a pooled connection indefinitely; during a large block storm or schema-lock contention the decoder could stall on the block-processing hot path with no timeout-based recovery. A query now aborts after the configured timeout (30s default, overridable via `DB_QUERY_TIMEOUT`) instead of hanging. Matches the pattern already used by `xchain-hub`.

### Fixed
- `src/XChainDecoder.js` — `blocks.previous_block_hash` is now persisted in big-endian display format instead of little-endian wire bytes. The block loop reversed the raw previous-hash buffer once to compute the display-format value used for reorg detection, then reversed the *same* buffer a second time when building the `insertBlock` payload — and `Buffer.prototype.reverse()` mutates in place, so the second reverse undid the first and the stored value was the little-endian wire bytes. Every block row written since the service was first deployed carries the wrong byte order. Reorg detection was unaffected (it used the already-computed local variable, not the re-reversed buffer), so the chain was always processed correctly; only the persisted `previous_block_hash` was wrong. The fix reuses the already-computed display-format variable in the `insertBlock` payload, which also removes the in-place-mutation hazard. A corrective one-time migration for existing rows ships at `migrations/2026-06-02-fix-previous-block-hash-byte-order.sql` — it repoints each block's `previous_block_hash_id` at the parent block's already-correct `block_hash_id` (run with the decoder stopped; take a backup; safe to re-run). **Validator note:** because `previous_block_hash_id` is replicated to validator nodes via `xchain-sync`, validator-decoder replicas contain the same corrupted values; after this fix lands, validator operators must either re-sync their decoder database or run the same migration against their replica. Regression test added in `test/unit/blockPrevHashByteOrder.test.js`.
- `src/db.js` — `dropDatabase()` (the test-only schema reset helper) now also drops `transaction_outputs`, `dispensers`, `mempool_transactions`, and `pubkeys`. It previously dropped only `blocks`, `transactions`, `index_addresses`, `index_transactions`, and `events`, leaving the other four tables intact. A test suite that called this helper to reset state between runs therefore accumulated stale rows in those tables, producing non-deterministic failures in dispenser-lookup and pubkey-dedup assertions on re-runs against the same database. The four new drops run before the parent-table drops — `pubkeys` carries a foreign key onto `index_addresses`, so it must be dropped before `index_addresses` or the `DROP` would fail with a constraint error.
- `src/XChainDecoder.js` — the node tip (`blockchainInfoLastBlock`) is now re-polled on a wall-clock interval (≤30s) during a long catch-up, so the reported sync lag stays accurate throughout. Previously `getBlockchainInfo()` was only called when `lastProcessedBlockIndex >= blockchainInfoLastBlock`, a condition that is never true during a multi-thousand-block catch-up — the tip stayed frozen at the value captured at loop entry while the indexer advanced toward it, so the lag derived from it (`node_height - last_processed_block`, surfaced as `health().lag_blocks` and `getSyncStatus().lag`) converged toward zero even as the live chain kept producing blocks and the real gap remained nonzero. An operator polling `/status` or the JSON-RPC `health` endpoint during catch-up would see a false "caught up" reading and could suppress alerts for a genuine sync delay. A new `BLOCKCHAIN_INFO_REFRESH_MS` (30s) is OR'd into the refresh guard and the tip is re-fetched periodically regardless of progress, at the cost of one extra `getblockchaininfo` RPC per interval during catch-up. The risk was confined to this service's own observational endpoints — `blockchainInfoLastBlock` is never propagated to the indexer or hub.
- `src/XChainDecoder.js` — `verifyReorg()` now records the correct rolled-back block hash in every `REORG` event. When building the `blocksDeleted` payload, the push read `lastBlock["hash"]`, but `getBlockByIndex()` aliases the column as `block_hash` (`it.hash AS block_hash` in `src/db.js`), so the `"hash"` key was always `undefined` and serialised to `null` in the JSON stored in `events.data`. Every `REORG` event therefore recorded `null` for the invalidated block hashes, making it impossible to identify which blocks were rolled back or confirm the fork point from the audit log alone. Live reorg processing was unaffected — downstream consumers read only `block_index` from these records — so the impact was confined to the forensic audit trail (historical rows already written remain `null` and are unrecoverable). The push now reads the correct `block_hash` key, matching the comparison one line above that already used it. Regression test added in `test/chaos/CE06-chainReorg.chaos.js` asserts each entry in the `REORG` payload carries the actual non-null block hash.
- `src/db.js` — `deleteBlockByIndex()` no longer leaks the internal transaction lock when one of its `DELETE` queries fails. The method opens a transaction (acquiring the single-writer transaction lock) and ran its four deletes with no error handling; if any query threw — DB timeout, deadlock, disk full — the exception escaped with the lock still held and the connection still open. Every subsequent caller that tried to acquire the lock (including `verifyReorg()`'s own 3s-backoff retry loop) then waited forever on a promise that was never resolved, permanently halting block ingestion until a manual restart and starving every downstream reader. The deletes are now wrapped in a `try/catch` that rolls back and releases the lock via `endTransaction()` before re-throwing — matching the error handling already used by `insertBlock`/`insertTransaction` in the same file — so the reorg path can recover from a transient DB fault on retry instead of deadlocking. Regression tests added in `test/security/connectionHandling.security.test.js`.
- `src/XChainDecoder.js` — `verifyReorg()` no longer crashes when a reorg invalidates every processed block. The function walks backward deleting mismatched blocks until a hash matches; once the last block was deleted, `getLastBlockIndex()` returns `-1` (MAX over an empty table) and `getBlockByIndex(-1)` returns no row, so the unconditional `lastBlock["block_hash"]` comparison threw an uncaught `TypeError` — terminating the process before the `REORG` event was written and leaving the decoder in an inconsistent restart state. A guard now stops the walk cleanly when the blocks table is exhausted or the walk retreats past the configured start height (`!lastBlock || lastBlockIndex < startBlockIndex`), so the `REORG` event is always recorded for the blocks that were rolled back. Trivially reproducible on regtest by invalidating the first parsed height; also reachable by a fresh decoder or a deep production reorg. Regression test added in `test/chaos/CE06-chainReorg.chaos.js`.

### Security
- `package.json` — added a `form-data` override pinning the package to `^4.0.5` across the whole dependency tree. The direct dependency (via axios) already resolves to a patched `4.0.5`, so this changes no currently-resolved version; it is a defensive guard that prevents any future transitive dependency from reintroducing a pre-4.0.5 `form-data`, which used `Math.random()` rather than a CSPRNG for multipart boundary generation (GHSA-fjxv-7rqg-78g4).

### Changed
- Several `catch` blocks in `src/XChainDecoder.js` now append the caught error to their `console.log` / `console.error` call instead of logging only a fixed message string. The block-hash retry, network-info retry, invalid-UTF-8 decode, mempool-fetch, and batch-skip paths now carry the error (and its stack) on the message line, so an operator reading logs after an incident can see what actually failed.
- The P2SH and P2WSH data-extraction paths in `src/XChainDecoder.js` now use the decompiled redeem-script element directly instead of wrapping it in `Buffer.from(decodedRedeemScript[0], "hex")`. The element is already a `Buffer` (guarded one line earlier by `Buffer.isBuffer`), so `Buffer.from` only made a redundant copy and the `"hex"` encoding argument was silently ignored — misleadingly implying the input was a hex string. No functional change; the value is fed straight into the following `Buffer.concat`.

### Fixed
- `src/XChainBlockDecoder.js` — `blockFromBuffer` now strips the Litecoin MWEB marker+flag from a block's final transaction when the flag is the combined segwit+MWEB value `0x09`, not only the pure-MWEB `0x08`. The single-transaction decode path (`transactionFromHex`) already handled both flag values, but the block-level last-transaction check matched only `0x08`; a Litecoin block whose final (HogEx) transaction carried `0x09` would have been handed unstripped marker bytes and thrown a `Transaction.fromBuffer` parse error, stalling block processing. HogEx extension transactions are observed to use `0x08` in practice, so this is a defensive consistency fix with no behavioural change on current data.

## [1.11.10] - 2026-05-30

### Fixed
- `src/sql/events.sql` — added a composite index `code_id` on `events (code, id)`. Reorg-detection looks up the most recent event of a given code with `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1`, which runs once per block cycle. Without an index on `code`, MariaDB had to full-scan the entire `events` table to evaluate the `WHERE` filter before it could apply the `ORDER BY id DESC LIMIT 1` — a cost that grows linearly as the table accumulates hundreds of thousands of rows over months of mainnet operation. The composite `(code, id)` index lets the engine satisfy both the filter and the descending-id ordering in a single backward index scan, with no separate sort step. Schema-source change only; existing deployments need a one-time `ALTER TABLE events ADD INDEX code_id (code, id)`.

## [1.11.9] - 2026-05-29

### Fixed
- `BlockchainConnector.getRawTransaction` no longer rejects when `getrawtransaction` returns an empty result. A mempool transaction can be mined or evicted between `getRawMempool` listing it and the per-tx fetch — a common race during high mempool churn. The method previously `reject`ed in that case, and because `getRawTransactions` fans the fetches out through `Promise.all`, a single missing tx propagated the rejection and caused `updateMempool` to silently skip its entire batch of up to `MEMPOOL_BATCH_SIZE` (1000) txids, leaving temporary gaps in `mempool_transactions`. It now resolves `null` for an empty result; the existing null-filter in `updateMempool` drops only the one missing tx and the rest of the batch is processed normally. This matches the long-standing behaviour of the UTXO tracker's connector.

## [1.11.8] - 2026-05-29

### Fixed
- `BlockchainConnector.getRawTransaction` retry back-off now correctly detects RPC work-queue overflow. The previous `error.response?.status === 429` check was dead code — Bitcoin Core and Litecoin Core never return HTTP 429 for a full work queue; they return HTTP 500 with a JSON body carrying `error.code === -429` (which the second arm already handled). That unreachable arm has been removed. In addition, Dogecoin v1.14 closes the TCP connection outright when its RPC queue fills, surfacing as an `ECONNRESET`/`ECONNREFUSED` socket error with no HTTP response; these are now also treated as work-queue-full, so the connector applies the 5s back-off instead of hammering an overwhelmed daemon with rapid 500ms retries.

## [1.11.7] - 2026-05-29

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a container image can no longer silently pick up newer transitive dependency versions than were tested.

## [1.11.6] - 2026-05-29

### Fixed
- Litecoin's `dustThreshold` in `CryptoNetworks.js` was set to `546` (the Bitcoin value) for all three network variants (`litecoin-mainnet`, `litecoin-testnet`, `litecoin-regtest`). Litecoin's dust threshold is `5460` satoshis (10× Bitcoin's), and the encoder already uses that value. The decoder now reports `5460` for all three LTC variants, so any classification or validation that reads `network.dustThreshold` applies the correct floor and no longer treats LTC outputs between 546 and 5459 satoshis as non-dust.

## [1.11.5] - 2026-05-29

### Fixed
- `updateMempool` no longer freezes mempool tracking for the rest of the process lifetime when a database or parse operation fails mid-cycle. The `mempoolBusy` guard flag was set at the start of each cycle but only cleared on the happy path and on a `getRawMempool` failure; an exception from any of the three post-sort `await`s (`deleteAndCompareTxsNotInList`, `parseTransaction`, `insertMempoolTransaction`) escaped the function as an unhandled rejection and left the flag stuck `true`, so every subsequent interval tick short-circuited on the busy check and silently stopped updating `mempool_transactions` until the process was restarted. The post-sort body is now wrapped in a `try/finally` that always resets the flag, and the `setInterval` callback has a `.catch()` so any such exception is logged instead of suppressed. Added CE-05 chaos scenarios covering a DB throw after the sort phase and verifying the next tick resumes normally.

## [1.11.4] - 2026-05-29

### Fixed
- Block deletion during a chain reorganization now also removes the dependent `transaction_outputs` and `dispensers` rows (both keyed by `tx_index`), not just `transactions` and `blocks`. Previously those child rows were orphaned, so when the decoder reprocessed the reorged block it re-inserted the same `(tx_index, vout)` / `(tx_index, address_id)` pairs, hit a duplicate-key error, and silently kept the stale pre-reorg rows — which the indexer then read as valid, producing wrong dispense destinations and amounts.
- Fixed the `DUPLICATED_TRANSACTION` sentinel, which was declared as a constructor-local `const` and never reachable as `this.DUPLICATED_TRANSACTION` (always `undefined`). Duplicate-key inserts of transaction outputs are now detected and logged with a warning (block index, tx index, vout) instead of being swallowed.

## [1.11.3] - 2026-05-28

### Removed
- Dropped a redundant "Connected to database!" status line printed at startup. The database connection is already verified (and any failure throws) immediately before it, and the subsequent "Parsing..." line signals that startup succeeded, so the extra confirmation added only log noise.

## [1.11.2] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0`. The installed version was already patched, but the stale lower bound left a path by which a clean install against an older registry snapshot could resolve a pre-1.8.2 release affected by GHSA-q8qp-cvcw-x6jj (prototype-pollution read-side gadgets in the HTTP adapter enabling credential injection / request hijacking). Tightening the floor closes that gap and silences the recurring audit warning.

## [1.11.1] - 2026-05-28

### Fixed
- MULTISIGN transactions whose final 64-byte chunk ended in a `0x00` ciphertext byte were silently decoded into corrupt data (~1 in 256 affected). The decoder stripped trailing zero bytes from the concatenated pubkey payload *before* decrypting, to remove the zero-padding the encoder adds to partial final chunks. On a *full* 64-byte chunk no padding exists, so the last byte is live AES-128-CTR ciphertext; when it was `0x00` the strip dropped a real byte, `removeObfuscation` decrypted one byte short, `bitcoin.script.decompile` returned `null` on the truncated buffer, and the raw incomplete buffer was written as the decoded action with no error surfaced. The strip is removed entirely: the full chunk is now decrypted, and because AES-CTR is a stream cipher any genuine plaintext zero-padding decrypts back to `0x00` (valid `OP_0`) and falls outside the payload's self-describing compiled-script length, so it is discarded harmlessly at reassembly. Added regression test `R-SCR-005` and regenerated the multisig test fixture to reflect real encoder output.

## [1.11.0] - 2026-05-28

### Fixed
- `index_addresses` / `index_transactions` lookup tables could accumulate duplicate rows for the same address or hash. Each carried only a non-unique 10/20-char prefix index, and `createAddress` / `createTransaction` upserted with a SELECT-then-INSERT — a time-of-check/time-of-use race in which two concurrent callers both see "no row" and both insert, producing duplicate ids for the same key. The schema now declares full-column **UNIQUE** indexes (also restoring exact, non-prefix lookup selectivity at scale), and both upserts now use `INSERT IGNORE` + refetch, which is race-safe without a wrapping transaction.

### Migration
- `migrations/2026-05-28-unique-index-tables.sql` upgrades an existing database: the schema files only run on a fresh DB (`verifyTables` skips existing tables), so run this script once against a live database to de-duplicate any accumulated rows (keep lowest id, repoint all foreign-key references, delete duplicates) before the UNIQUE indexes can be applied. Run with the decoder stopped; take a backup first.

## [1.10.2] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths, including the legacy `qs@6.5.5` pulled in by the deprecated `request` package.

## [1.10.1] - 2026-05-28

### Removed
- Unused `mysql` dependency — the service connects via the `mariadb` driver only; the legacy `mysql` package was never imported and carried known CVEs in its SSL-handling layer.

## [1.10.0] - 2026-04-08

### Added
- `PRICE` added to `VALID_ACTION_NAMES` in `XChainDecoder.js` — enables decoding of on-chain validator (PRICE v0) and user oracle (PRICE v1) price actions on all supported chains. Deploy to BTC, LTC, and DOGE decoder instances.

## [1.9.0] - 2026-04-07

### Added
- `src/sql/pubkeys.sql` — new `pubkeys` table for storing address-to-public-key mappings
- `extractPubkeyFromInput()` method in `XChainDecoder` — extracts public keys from P2PKH scriptSig, P2WPKH witness, and P2SH-P2WPKH witness data
- `hasPubkey()` and `insertPubkey()` methods in `Database` for public key storage
- Public key extraction during XChain transaction parsing — automatically stores the source address public key on first encounter

## [1.8.3] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.8.2] - 2026-04-05

### Removed
- Deleted unused `bufferutils.js` from project root (vendored bitcoinjs-lib copy with no local references)

## [1.8.1] - 2026-04-05

### Changed
- Moved Stryker mutation configs (`stryker.config.mjs`, `stryker.phase2.config.mjs`) and mocharc files (`.mocharc.mutation.yml`, `.mocharc.mutation-phase2.yml`) from project root into `test/mutation/`
- Updated `test:mutation` and `test:mutation:phase2` npm scripts to reference new config paths

## [1.8.0] - 2026-04-02

### Added
- 9 new actions to VALID_ACTION_NAMES: CLAIM_REWARDS, DELEGATE, DEPLOY, DEPOSIT, EXECUTE, REVOKE_DELEGATION, STAKE, UNSTAKE, WITHDRAW

## [1.7.3] - 2026-04-02

### Changed
- Rewrote README.md with badges, features, documentation links, quick start, scripts table, and full test suite breakdown to match indexer/SDK format

## [1.7.2] - 2026-04-02

### Added
- Regression test suite with tiered execution (P0 Critical, P1 High, P2 Standard)
- 76 tests tagged with `[REGRESSION P0/P1/P2]` across unit, boundary, and security test files
- `npm run test:regression:critical` (P0 only, 47 tests, <1s)
- `npm run test:regression` (P0+P1, 57 tests, <1s)
- `npm run test:regression:full` (all tiers, 76 tests, ~5s)
- `test/regression/` directory with setup and bug-fix regression test template
- Regression testing plan document (`claude/reports/XCHAIN_DECODER_REGRESSION_TESTING_PLAN.md`)

## [1.7.1] - 2026-04-02

### Added
- Mutation testing with Stryker Mutator (`npm run test:mutation`, `npm run test:mutation:phase2`)
- Phase 1 config (`stryker.config.mjs`) targets unit tests against 5 core source files
- Phase 2 config (`stryker.phase2.config.mjs`) targets unit + security tests
- Mocha timeout configs for mutation runs (`.mocharc.mutation.yml`, `.mocharc.mutation-phase2.yml`)
- HTML mutation report output to `reports/mutation/`
- `.stryker-tmp/` and `stryker.log` added to `.gitignore`

## [1.7.0] - 2026-04-02

### Added
- Chaos engineering test suite (50 tests across 8 experiment files) covering node unavailability, RPC timeouts, DB pool exhaustion, mid-transaction failures, malformed mempool data, chain reorgs, concurrent instances, signal handling, unhandled rejections, and fire-and-forget DB calls
- Chaos test infrastructure: mock factories (createMockDatabase, createMockConnector), fault injection helpers (failNTimes, intermittentFault, withLatency), console capture utility
- `npm run test:chaos` script
- Health check endpoint (`health` JSON-RPC method) reporting decoder running state, sync status, and error details
- Process signal handlers (SIGTERM, SIGINT) for graceful decoder shutdown
- Global `unhandledRejection` handler in api.js
- Error handler on `decoder.start()` in api.js to track decoder crash state

### Fixed
- `decoder.start()` had no `.catch()` handler — unhandled rejection could leave Express serving healthy pings while decoder was dead
- `insertTransactionOutput()` was called without `await` — failures were silently lost, causing missing dispenser output records
- `transactionFromHex()` in mempool loop was unprotected — single malformed tx hex could crash the entire decoder process
- `beginTransaction()` leaked connection on `beginTransaction()` call failure — connection released but not returned to pool
- Mempool tx processing loop used fragile `while` with manual index — null entries or `insertMempoolTransaction` failures caused infinite loops; replaced with `for` loop
- Mempool `parseTransaction` returning null for coinbase txs caused crash — added null check before accessing result properties
- `start()` unconditionally created new Database instance — prevented testability; now skips if `this.db` already set

## [1.6.0] - 2026-04-02

### Added
- Performance and load testing benchmark suite with 7 scenarios: deobfuscation, parse-transaction, block-processing, sustained-sync, spike-load, large-payload, mempool-stress
- Benchmark infrastructure: MockBlockchainConnector, MockDatabase, DataGenerator (builds valid blocks with encrypted XChain payloads), MetricsCollector (perf_hooks timing, memory/CPU snapshots, event loop lag)
- CLI harness with --quick, --json, --compare, --save-baseline, --scenario flags
- Initial baseline captured from full run
- `npm run test:bench` and per-scenario scripts (`test:bench:quick`, `test:bench:micro`, `test:bench:blocks`, `test:bench:sustained`, `test:bench:spike`, `test:bench:payload`, `test:bench:mempool`, `test:bench:save`, `test:bench:compare`)

## [1.5.0] - 2026-04-02

### Added
- Fuzz test suite with 5 harness files covering removeObfuscation, parseTransaction, blockDecoder, dispenserParsing, and full pipeline
- 3 mutation engines: bitFlip, byteManipulate, and protocol-aware structureAware mutators
- Fuzz infrastructure: invariant checkers, crash reporter (logs failing inputs to disk), seed corpus support
- `npm run test:fuzz` and per-harness scripts (`test:fuzz:quick`, `test:fuzz:deobfuscation`, `test:fuzz:parse`, `test:fuzz:block`, `test:fuzz:dispenser`, `test:fuzz:pipeline`)

## [1.4.0] - 2026-04-02

### Added
- Security test suite (75 tests) covering SQL parameterization, deobfuscation robustness, ACTION validation, P2SH/P2WSH bounds safety, DISPENSER field validation, connection handling, error sanitization, and connector security
- `npm run test:security` script
- Post-decryption ACTION validation: max payload length (8192), known ACTION name whitelist, strict UTF-8 decoding
- Transaction lock (mutex) to prevent async interleaving between block commits and mempool updates
- Connection pool timeout (30s) replacing infinite retry loop in `getConnection()`
- Rate limiting (100 req/min) and body size limit (100kb) on Express API
- HTTPS URL support in BlockchainConnector

### Fixed
- SQL injection risk in `createDatabase()` — added database name whitelist and backtick-quoting
- SQL injection risk in `deleteAndCompareTxsNotInList()` — replaced string concatenation with parameterized placeholders
- P2SH data extraction crash when scriptSig has fewer than 3 elements — added bounds check
- P2WSH data extraction crash when witness has fewer than 3 elements or non-Buffer at index 2 — added bounds check
- DISPENSER expiration accepting non-numeric values — now validated with `Number()`, rejects NaN/negative/overflow
- `parseInt(commandVersion)` missing radix — changed to `parseInt(commandVersion, 10)`
- Verbose error logging in `db.js` and `BlockchainConnector.js` potentially leaking credentials — now logs `e.code` / `error.message` only

## [1.3.0] - 2026-04-02

### Added
- Boundary test suite (78 tests) covering AES deobfuscation, script type detection, multisig zero-trim, DISPENSER field extraction, expiration values, and satoshi conversion edge cases
- 4 boundary test files under `test/unit/boundary/`

### Fixed
- `bigIntSatoshiToDecimalsString` producing malformed output for negative inputs (e.g. `-100` → `"0.0000-100"`)
- Short DISPENSER strings (< 13 fields) creating immortal dispensers due to `undefined != ""` evaluating to true
- Crash in `parseTransaction` when `bitcoin.script.decompile(dataBuffer)` returns null for non-script data
- Crash in multisig parsing when decompiled pubkey elements are opcodes (integers) instead of Buffers

## [1.2.0] - 2026-04-02

### Added
- End-to-end test suite (50+ tests) validating the complete decoder pipeline
- 5 E2E test files: actionDecoding, dispenserLifecycle, multiBlockProcessing, errorHandling, indexerContract
- E2E test helpers: extended txBuilder (mempool, reorg, decoder restart), extended assertions (dispenser, mempool, normalization integrity)
- `npm run test:e2e` script (requires bitcoind regtest + MariaDB)
- E2E testing plan document (`reports/XCHAIN_DECODER_E2E_TESTING_PLAN.md`)

## [1.1.0] - 2026-04-02

### Added
- Smoke test suite (52 tests) for rapid service health checks
- 8 smoke test files covering module loading, crypto networks, deobfuscation, OP_RETURN parsing, multisig parsing, block decoding, API ping, and database initialization
- `npm run test:smoke` script (runs in ~50ms, no external services required)
- Optional MariaDB smoke tests gated by `SMOKE_DB=1` environment variable
- Smoke testing plan document (`reports/XCHAIN_DECODER_SMOKE_TESTING_PLAN.md`)

## [1.0.0] - 2026-04-02

### Changed
- Bump to 1.0.0

## [0.0.4] - 2026-04-02

### Added
- Integration test suite (30 tests) verifying decoder→DB pipeline against regtest
- Test helpers: txBuilder (tx construction/broadcasting), assertions (indexer contract query)
- `npm run test:integration` script (requires bitcoind regtest + MariaDB)
- Integration test plan document (`reports/XCHAIN_DECODER_INTEGRATION_TESTING_PLAN.md`)

## [0.0.3] - 2026-04-02

### Added
- Unit test suite (143 tests) covering all core modules in isolation
- Test fixtures for AES-128-CTR deobfuscation and synthetic transactions
- `npm run test:unit` script for running unit tests without regtest/MariaDB
- sinon and mocha as devDependencies
