# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- `src/BlockchainConnector.js` — removed the unused `getMempoolEntry(txid)` method (wrapping the `getmempoolentry` JSON-RPC call) along with its dedicated unit tests and chaos-helper stub. The method had no caller anywhere in the service; leaving an unexercised RPC wrapper on the connector risked silently drifting out of sync with coin-node response shapes (e.g. Bitcoin Core's `fee` → `fees.base` field rename) for any future consumer. Removing it shrinks the connector surface to what the service actually uses.

### Changed
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.

### Added
- `src/api.js`, `.env.example` — the API rate limit is now tunable via the `DECODER_RATE_LIMIT_RPM` environment variable (default `100` requests/minute per IP — unchanged from the previously hardcoded value, so deployments that do not set it see no behavior change). The decoder previously had no runtime override path at all; it now follows the platform-wide per-service `<SERVICE>_RATE_LIMIT_RPM` rate-limit naming convention.
- `src/api.js` — the `health()` JSON-RPC response now includes a `lag_blocks` field: `max(0, node_height - last_processed_block)`, null-guarded for the pre-first-sync window. Previously the response carried the node tip and last-processed block but no single clamped block-count delta, so an operator (or an alerting threshold) could not read "how far behind" directly during a long initial sync — only derive it. `lag_blocks` gives a non-negative numeric lag operators can threshold an alert on and use to estimate sync ETA.
- `.env.example` — added a configuration template enumerating every environment variable the decoder reads (coin/network, coin-node RPC, decoder database, API port), with safe regtest/placeholder defaults and inline comments, so operators have a single reference for configuring the service instead of discovering variables by reading the source.
- `src/db.js` — the MariaDB connection pool now sets `queryTimeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000`. Without a query timeout a slow or lock-blocked statement had no upper bound and could hang a pooled connection indefinitely; during a large block storm or schema-lock contention the decoder could stall on the block-processing hot path with no timeout-based recovery. A query now aborts after the configured timeout (30s default, overridable via `DB_QUERY_TIMEOUT`) instead of hanging. Matches the pattern already used by `xchain-hub`.

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
