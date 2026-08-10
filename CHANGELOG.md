# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Action text columns are utf8mb4, so a valid non-BMP MEMO is stored instead of quarantining the fee-paid transaction with no ACTION row ().
- Pending mempool rows carry `raw_data`, so FILE content and gated ciphertext appear immediately instead of only after confirmation ().
- Corrected a protocol-constants header that claimed a cross-repo tripwire which does not exist ().
- Reorg-depth ceiling and the UTXO-tracker undo window are reconciled rather than hand-mirrored ().
- review review-round fixes: reorg verify errors propagate on the equal-height branch, start() fails fast with bounded DB retries, coin-prefixed cadence logs, pubkeys widened to VARCHAR(130) with migration, migration guard on early returns, manifest alias conformance test, safe-depth changelog correction.

### Added
- Bind `OP_RETURN_PUSH_OVERHEAD` by name from the vendored constants, with a conformance test pinning the value against what `compiledPushSize` adds ().

### Changed
- CI gate now declares `xchain-encoder` in `.ci-siblings` so the cross-repo conformance tests (`roundtripConformance` byte-identity drift-guard, `compiledPushSizeConformance`) run against the canonical encoder fixture checked out at `origin/master`, instead of skipping — or, worse, failing on whatever non-canonical `xchain-encoder` checkout happened to be left in the venue's shared `work/` directory. The gate `rm -rf`s and re-clones the sibling each run, so it also self-heals a contaminated leftover.
- Consolidated all migrations under `src/sql/migrations/` (the only directory the runner reads) and deleted the stale root `migrations/` duplicates, one of which shipped the pre-fix widen-ids script that operator docs pointed at and failed with FK error 1833 on legacy databases.
- Document that MAX_ACTION_DATA_LENGTH bounds the wire form only, with a boundary test pinning alias expansion at the ceiling ().

### Fixed
- DISPENSER opens are now gated on coin parity with the indexer: a v0 dispenser is registered only when both `GIVE_COIN` and `GET_COIN` name this chain's native coin. The previous gate opened a dispenser whenever either field was merely non-empty, so it registered dispensers the indexer rejects (one coin field empty, or either field naming a foreign network) and then reclassified later ordinary native-coin payments to that address as failed dispenses instead of plain sends.
- DISPENSER opens now fail loud on a compacted `^<id>` `GET_ADDRESS` instead of silently registering a dead dispenser. The decoder cannot resolve an `^<id>` index-address reference into its own address id space, so such an open would be keyed on the literal token, never match a payment output, and silently never dispense (while creating a junk address row). The open is now skipped and logged as a parse error identifying the tx index and the unresolved token; the SDK no longer compacts this field, so a residual token indicates a third-party composer or a historical replay.
- P2SH/P2WSH reveal fee outputs: the native-coin fee output attributed from a reveal's funding (commit) transaction is now stored at `vout + FUNDING_VOUT_BASE` under the reveal's `tx_index`, a domain disjoint from the reveal tx's own vouts. Previously it kept the funding tx's raw vout and could collide on the `transaction_outputs` `(tx_index, vout)` primary key with a reveal-tx dispense/COINPAY output at the same vout number; the duplicate insert was silently dropped, so the indexer saw no fee output and wrongly rejected the action on LTC/DOGE (or fell back to XCHAIN balance deduction on BTC) even though the fee was paid on-chain. Forward-only: block ranges already processed with a dropped fee row must be re-indexed to recover them.
- Database gains a `_createConnection` test seam so verifyDatabase/createDatabase unit tests stub it instead of mariadb's non-configurable `createConnection` export (5 sinon failures fixed).
- Prevout/fee-output RPC lookup failures now throw tagged errors and the block loop retries the block indefinitely, so committed block contents can no longer depend on which instance's RPC happened to succeed.
- The block loop aborts and retries on every rollback-signalling `false` db return, re-deriving its block/tx cursors from the DB so a retried block assigns the same `tx_index` values as a clean instance.
- `getAllOpenDispenserAddresses` returns null on query error so a failed read can no longer decode a block against a silently-empty dispenser set.
- The `health` and `GET /status` probes use a new `db.ping()` on a dedicated pooled connection; they previously grabbed (and released!) the block loop's open transaction connection mid-block, letting any monitor poll break per-block atomicity.
- `DISPENSER_EXPIRE_SAFE_DEPTH` raised from a flat 100 to 126 (the deepest per-chain reorg-recovery window, DOGE = 120 undo blocks, plus a 6-block safety margin; mirrored by `xchain-utxo-tracker` `MAX_SAFE_UNDO_BLOCKS = 126`); at 100 a soft-expired dispenser was hard-purged before a legal in-window DOGE reorg could restore it, permanently losing a money-bearing dispenser on the reorged node. Pinned by a regression test.
- `getBlockByIndex` retries then throws instead of returning null on a DB error, so a transient fault can no longer end verifyReorg's rollback walk early and report a false "rollback complete" ().
- Transport faults no longer count toward the AuxPoW-reassembly escalation, so node overload is not misread as a malformed block and amplified into a per-tx refetch storm ().

## [1.11.16] - 2026-07-16

### Fixed
- Wire-format coin allowlist: construction fails fast on a coin outside KNOWN_WIRE_COINS instead of decoding with wrong byte params ().
- migrate.js CLI covered by unit tests (env-guard exit 2, includeManual, exitCode 1, pool close) ().
- Committed-migration DDL guard splits statements quote-aware via splitOf(raw) ().


## [1.11.14] - 2026-06-20

### Added
- `src/api.js`, `.env.example`: add `DECODER_RATE_LIMIT_RPM` env var to tune the API rate limit at runtime (default 100 req/min).
- `src/api.js`: add `lag_blocks` field to `health()` response (clamped non-negative block-count delta for alerting).
- `.env.example`: add configuration template enumerating every decoder environment variable with safe regtest defaults.
- `src/db.js`: add `queryTimeout` on the MariaDB connection pool via `DB_QUERY_TIMEOUT` (default 30000 ms).

### Changed
- `package.json`: pin `mariadb` 3.5.2, `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions so every install resolves a byte-identical dependency tree.
- `src/sql/*.sql`: widen every `INTEGER UNSIGNED` id/key column to `BIGINT UNSIGNED` across all eight tables; migration ships at `migrations/2026-06-02-widen-ids-to-bigint.sql` for existing databases.
- `src/api.js`: migrate `rateLimit()` from the deprecated `max` option to its canonical `limit` replacement (behavior-preserving rename for express-rate-limit v8).
- `package.json`: align `mariadb` driver to the `^3.5.2` range used platform-wide (was `~3.4.5`).
- Several `catch` blocks in `src/XChainDecoder.js` now append the caught error object to their log call so the error and stack appear in the output.
- The P2SH and P2WSH paths in `src/XChainDecoder.js` now use the decompiled redeem-script element directly instead of re-wrapping it in `Buffer.from(..., "hex")` (no functional change, removes misleading encoding hint).

### Removed
- `src/BlockchainConnector.js`: remove the unused `getMempoolEntry(txid)` method and its unit tests.

### Fixed
- `src/db.js`, `src/sql/mempool_transactions.sql`: `insertMempoolTransaction` no longer pre-allocates rows in `index_addresses` / `index_transactions`; `mempool_transactions` now stores raw strings, keeping lookup-id assignment deterministic and replication-safe.
- `src/XChainDecoder.js`: accept the five documented ACTION-name aliases (`TRANSFER`, `ADDR`, `DROP`, `CAST`, `MSG`) by normalizing them to canonical names before the allowlist gate, and apply the same normalization on the mempool path.
- `src/XChainDecoder.js`, `src/db.js`: load the full set of open-dispenser addresses once per block into a `Set` via `getAllOpenDispenserAddresses()` instead of issuing one `SELECT COUNT(*)` per transaction output.
- `src/CryptoNetworks.js`: correct the Litecoin dust threshold from `546` to `5460` litoshis for all three `litecoin-*` networks.
- `src/BlockchainConnector.js`: `getRawTransactions()` now fetches with bounded concurrency (`DECODER_RPC_CONCURRENCY`, default 50) instead of firing all requests at once.
- `src/XChainBlockDecoder.js`: sanity-bound the varint transaction count in `blockFromBuffer` before looping, throwing a named error on a structurally impossible count.
- `src/sql/pubkeys.sql`: align collation to `utf8_unicode_ci` to match every other decoder table (was `utf8_general_ci`).
- `src/db.js`: `verifyTables()` now reconciles declared indexes on existing tables (new `parseExpectedIndexes()` / `reconcileTableIndexes()` / `dedupeForUniqueIndex()`), fixing the silent omission of post-creation `CREATE [UNIQUE] INDEX` statements.
- `src/XChainDecoder.js`: copy input/block hash buffers before byte-reversal at the three remaining bare sites so in-place mutation no longer corrupts shared decoded-block buffers (root fix for R-BUG-001).
- `src/sql/dispensers.sql`: correct the leading `DROP TABLE IF EXISTS dispenser;` (singular) to `DROP TABLE IF EXISTS dispensers;` so a manual schema rebuild targets the right table.
- `src/sql/pubkeys.sql`: normalize to the `DROP TABLE IF EXISTS pubkeys; CREATE TABLE pubkeys` reset pattern so a manual rebuild resets the table instead of silently no-opping.
- `src/api.js`: parse `AUX_POW` as an explicit boolean so `AUX_POW=false` / `AUX_POW=0` correctly disables AuxPoW mode (any non-empty string was previously truthy).
- `src/XChainDecoder.js`: re-poll the node tip on a wall-clock interval (30s) during catch-up so `health().lag_blocks` stays accurate instead of converging to zero prematurely.
- `src/XChainDecoder.js`: `verifyReorg()` now reads `block_hash` (not `hash`) from `getBlockByIndex()` output so reorg audit events record the actual invalidated block hash instead of `null`.
- `src/db.js`: `deleteBlockByIndex()` now wraps its deletes in `try/catch` that rolls back and releases the lock before re-throwing, preventing a permanent deadlock on any query failure.
- `src/XChainDecoder.js`: `verifyReorg()` guards against an empty blocks table so it no longer throws a `TypeError` when a reorg invalidates every processed block.
- `src/XChainBlockDecoder.js`: `blockFromBuffer` now strips the Litecoin MWEB marker+flag when the flag is `0x09` (segwit+MWEB), not only the pure-MWEB `0x08`.
- `src/db.js`: `verifyTables()` now reconciles column drift on existing tables at startup via `parseExpectedColumns()` / `alterTableForDrift()`, adding any column present in the SQL source but missing from the live table.
- `src/sql/migrations/2026-05-28-unique-index-tables.sql`: ship the missing one-time migration that upgrades an existing database to full-column UNIQUE indexes on `index_addresses (address)` and `index_transactions (hash)`.
- `src/XChainDecoder.js`: `blocks.previous_block_hash` is now persisted in big-endian display format; the previous double-reverse stored little-endian wire bytes (fix reuses the already-computed variable; migration at `migrations/2026-06-02-fix-previous-block-hash-byte-order.sql`).
- `src/db.js`: `dropDatabase()` now also drops `transaction_outputs`, `dispensers`, `mempool_transactions`, and `pubkeys` so test suites reset all tables between runs.

### Security
- `package.json`: add a `form-data` override pinning to `^4.0.5` to prevent any future transitive dependency from reintroducing pre-4.0.5 `form-data` (GHSA-fjxv-7rqg-78g4, weak multipart boundary CSPRNG).

## [1.11.10] - 2026-05-30

### Fixed
- `src/sql/events.sql`: add a composite `(code, id)` index on `events` so the reorg-detection `SELECT ... WHERE code='REORG' ORDER BY id DESC LIMIT 1` uses an index scan instead of a full-table scan.

## [1.11.9] - 2026-05-29

### Fixed
- `BlockchainConnector.getRawTransaction`: resolve `null` (instead of rejecting) when `getrawtransaction` returns an empty result, so a single evicted mempool tx no longer causes `updateMempool` to drop its entire batch.

## [1.11.8] - 2026-05-29

### Fixed
- `BlockchainConnector.getRawTransaction`: remove the dead `error.response?.status === 429` arm (Bitcoin/Litecoin Core return HTTP 500 with `error.code === -429`) and treat `ECONNRESET`/`ECONNREFUSED` from Dogecoin v1.14 as work-queue-full so the 5s back-off applies instead of rapid retries.

## [1.11.7] - 2026-05-29

### Changed
- Commit `package-lock.json` (previously git-ignored) and build the Docker image with `npm ci` so container images resolve a byte-identical dependency tree.

## [1.11.6] - 2026-05-29

### Fixed
- Correct Litecoin's `dustThreshold` in `CryptoNetworks.js` from `546` to `5460` satoshis for all three LTC network variants.

## [1.11.5] - 2026-05-29

### Fixed
- `updateMempool` no longer freezes mempool tracking when a post-sort `await` throws; the `mempoolBusy` flag is now cleared in a `try/finally` and the interval callback logs instead of swallowing exceptions.

## [1.11.4] - 2026-05-29

### Fixed
- Block deletion during reorg now also removes dependent `transaction_outputs` and `dispensers` rows so the decoder does not re-insert stale pre-reorg rows on reprocessing.
- Fix the `DUPLICATED_TRANSACTION` sentinel, which was declared as a constructor-local `const` and unreachable via `this.DUPLICATED_TRANSACTION`; duplicate-key inserts are now detected and logged with a warning.

## [1.11.3] - 2026-05-28

### Removed
- Drop the redundant "Connected to database!" startup log line (the subsequent "Parsing..." line already confirms successful startup).

## [1.11.2] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0` to close GHSA-q8qp-cvcw-x6jj (prototype-pollution credential-injection gadgets) against older registry snapshots.

## [1.11.1] - 2026-05-28

### Fixed
- Fix corrupt MULTISIGN decoding when a full 64-byte final chunk ends in `0x00`: remove the trailing-zero strip entirely so live ciphertext bytes are never dropped before AES-128-CTR decryption.

## [1.11.0] - 2026-05-28

### Fixed
- `index_addresses` / `index_transactions` could accumulate duplicate rows due to a SELECT-then-INSERT race; both tables now declare full-column UNIQUE indexes and use `INSERT IGNORE` + refetch for race-safe upserts.

### Migration
- `migrations/2026-05-28-unique-index-tables.sql` upgrades an existing database: the schema files only run on a fresh DB (`verifyTables` skips existing tables), so run this script once against a live database to de-duplicate any accumulated rows (keep lowest id, repoint all foreign-key references, delete duplicates) before the UNIQUE indexes can be applied. Run with the decoder stopped; take a backup first.

## [1.10.2] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry to remediate GHSA-q8mj-m7cp-5q26 (DoS in `qs.stringify` on null entries in comma-format arrays).

## [1.10.1] - 2026-05-28

### Removed
- Remove unused `mysql` dependency; the service uses the `mariadb` driver only and `mysql` carried known CVEs in its SSL layer.

## [1.10.0] - 2026-04-08

### Added
- `PRICE` added to `VALID_ACTION_NAMES` in `XChainDecoder.js`: enables decoding of on-chain validator (PRICE v0) and user oracle (PRICE v1) price actions on all supported chains. Deploy to BTC, LTC, and DOGE decoder instances.

## [1.9.0] - 2026-04-07

### Added
- `src/sql/pubkeys.sql`: new `pubkeys` table for storing address-to-public-key mappings
- `extractPubkeyFromInput()` method in `XChainDecoder`: extracts public keys from P2PKH scriptSig, P2WPKH witness, and P2SH-P2WPKH witness data
- `hasPubkey()` and `insertPubkey()` methods in `Database` for public key storage
- Public key extraction during XChain transaction parsing, automatically stores the source address public key on first encounter

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
- `decoder.start()` had no `.catch()` handler, unhandled rejection could leave Express serving healthy pings while decoder was dead
- `insertTransactionOutput()` was called without `await`: failures were silently lost, causing missing dispenser output records
- `transactionFromHex()` in mempool loop was unprotected, single malformed tx hex could crash the entire decoder process
- `beginTransaction()` leaked connection on `beginTransaction()` call failure, connection released but not returned to pool
- Mempool tx processing loop used fragile `while` with manual index, null entries or `insertMempoolTransaction` failures caused infinite loops; replaced with `for` loop
- Mempool `parseTransaction` returning null for coinbase txs caused crash, added null check before accessing result properties
- `start()` unconditionally created new Database instance, prevented testability; now skips if `this.db` already set

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
- SQL injection risk in `createDatabase()`: added database name whitelist and backtick-quoting
- SQL injection risk in `deleteAndCompareTxsNotInList()`: replaced string concatenation with parameterized placeholders
- P2SH data extraction crash when scriptSig has fewer than 3 elements, added bounds check
- P2WSH data extraction crash when witness has fewer than 3 elements or non-Buffer at index 2, added bounds check
- DISPENSER expiration accepting non-numeric values, now validated with `Number()`, rejects NaN/negative/overflow
- `parseInt(commandVersion)` missing radix, changed to `parseInt(commandVersion, 10)`
- Verbose error logging in `db.js` and `BlockchainConnector.js` potentially leaking credentials, now logs `e.code` / `error.message` only

## [1.3.0] - 2026-04-02

### Added
- Boundary test suite (78 tests) covering AES deobfuscation, script type detection, multisig zero-trim, DISPENSER field extraction, expiration values, and satoshi conversion edge cases
- 4 boundary test files under `test/unit/boundary/`

### Fixed
- `bigIntSatoshiToDecimalsString` producing malformed output for negative inputs (e.g. `-100` -> `"0.0000-100"`)
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
- Integration test suite (30 tests) verifying decoder->DB pipeline against regtest
- Test helpers: txBuilder (tx construction/broadcasting), assertions (indexer contract query)
- `npm run test:integration` script (requires bitcoind regtest + MariaDB)
- Integration test plan document (`reports/XCHAIN_DECODER_INTEGRATION_TESTING_PLAN.md`)

## [0.0.3] - 2026-04-02

### Added
- Unit test suite (143 tests) covering all core modules in isolation
- Test fixtures for AES-128-CTR deobfuscation and synthetic transactions
- `npm run test:unit` script for running unit tests without regtest/MariaDB
- sinon and mocha as devDependencies
