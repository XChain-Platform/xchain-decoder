# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-08-18

### Fixed
- Chain identity is re-proven on the reorg tip re-read, so a wrong-chain answer cannot slip in during a reorganization.
- Code-review round fixes across the decode path (two rounds, 14 files).

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `1.11.17` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [1.11.17] - 2026-08-13

### Fixed
- Action text columns are utf8mb4, so a non-BMP MEMO is stored instead of quarantining the transaction.
- Pending mempool rows carry `raw_data`, so FILE content and gated ciphertext appear before confirmation.
- Corrected a protocol-constants header that described a cross-repo tripwire which does not exist.
- Reorg-depth ceiling and the UTXO-tracker undo window are derived from one source instead of hand-mirrored.
- Reorg verify errors now propagate on the equal-height branch instead of being swallowed.
- `start()` fails fast after a bounded number of database retries.
- Cadence log lines are prefixed with the coin they belong to.
- `pubkeys` widened to VARCHAR(130), with a migration for existing databases.
- The migration guard now also covers early returns.

### Added
- `npm run ci` runs the smoke, regression, chaos and fuzz tiers alongside unit and security, and the docker-gated integration and e2e tiers run in a separate CI job.
- `test/tier-manifest.json` records the gate for every test tier, or a written reason it has none, enforced by `test/unit/tierManifest.test.js`.
- `OP_RETURN_PUSH_OVERHEAD` is bound by name from the vendored constants, with a conformance test pinning it to what `compiledPushSize` adds.
- A conformance test pins the ACTION-name aliases declared in the manifest.

### Changed
- The block and mempool loops share one storage gate, so the record a confirmed row holds and the one a pending row holds cannot drift apart.
- The roundtrip conformance suite drives encoder-built bytes through the real parse and storage gate to the stored record, instead of through a test-local copy of the decode arbiter.
- Test suites poll the decoder's own progress signal through a shared `waitUntil(predicate, timeout)` helper instead of fixed sleeps, removing a class of timing flakes.
- The CI gate declares `xchain-encoder` in `.ci-siblings` so cross-repo conformance tests run against a freshly cloned canonical encoder instead of a stale leftover checkout.
- All migrations live under `src/sql/migrations/`, the only directory the runner reads, and the stale root duplicates are gone.
- Documented that `MAX_ACTION_DATA_LENGTH` bounds the wire form only, with a boundary test pinning alias expansion at the ceiling.

### Fixed
- DISPENSER opens are gated on coin parity with the indexer, so a dispenser is registered only when both `GIVE_COIN` and `GET_COIN` name this chain's native coin.
- DISPENSER opens fail loud on a compacted `^<id>` `GET_ADDRESS` instead of silently registering a dispenser that can never match a payment.
- P2SH/P2WSH reveal fee outputs are stored at `vout + FUNDING_VOUT_BASE` so they can no longer collide with a reveal-tx output on the `(tx_index, vout)` primary key; already-processed ranges need re-indexing to recover dropped rows.
- `Database` gains a `_createConnection` seam so tests can stub connection creation.
- Removed `test/XChainDecoder.test.js`, a pre-fork file no gate ran whose fixtures used a superseded obfuscation scheme.
- Prevout and fee-output RPC lookup failures throw tagged errors and the block loop retries the block, so committed block contents no longer depend on which instance's RPC succeeded.
- The block loop aborts and retries on any rollback-signalling `false` from the database, re-deriving its cursors so a retried block assigns the same `tx_index` values.
- `getAllOpenDispenserAddresses` returns null on query error so a failed read cannot decode a block against a silently empty dispenser set.
- The `health` and `GET /status` probes use `db.ping()` on a dedicated pooled connection instead of borrowing the block loop's open transaction.
- `DISPENSER_EXPIRE_SAFE_DEPTH` raised from 100 to 126 so a soft-expired dispenser survives the deepest legal reorg-recovery window.
- `getBlockByIndex` retries then throws instead of returning null on a database error, so a transient fault cannot end a rollback walk early and report a false completion.
- Transport faults no longer count toward AuxPoW-reassembly escalation, so node overload is not misread as a malformed block.

## [1.11.16] - 2026-07-16

### Fixed
- Construction fails fast on a coin outside `KNOWN_WIRE_COINS` instead of decoding with the wrong byte parameters.
- The `migrate.js` CLI is covered by unit tests.
- The committed-migration DDL guard splits statements quote-aware.


## [1.11.14] - 2026-06-20

### Added
- `DECODER_RATE_LIMIT_RPM` tunes the API rate limit at runtime (default 100 req/min).
- `health()` reports a `lag_blocks` field, a clamped non-negative block-count delta for alerting.
- `.env.example` enumerates every decoder environment variable with safe regtest defaults.
- `DB_QUERY_TIMEOUT` sets `queryTimeout` on the MariaDB pool (default 30000 ms).

### Changed
- Pinned `mariadb`, `bitcoinjs-lib`, `ecpair`, `bip32` and `tiny-secp256k1` to exact versions so every install resolves the same dependency tree.
- Widened every id and key column to `BIGINT UNSIGNED` across all eight tables, with a migration for existing databases.
- `rateLimit()` uses the `limit` option in place of the deprecated `max`.
- Aligned the `mariadb` driver to the `^3.5.2` range used platform-wide.
- Several `catch` blocks in `src/XChainDecoder.js` log the caught error object so the stack appears in the output.
- The P2SH and P2WSH paths use the decompiled redeem-script element directly instead of re-wrapping it.

### Removed
- Removed the unused `getMempoolEntry(txid)` method from `src/BlockchainConnector.js`.

### Fixed
- `insertMempoolTransaction` no longer pre-allocates lookup rows, and `mempool_transactions` stores raw strings, keeping id assignment deterministic and replication-safe.
- The five documented ACTION-name aliases are normalized to canonical names before the allowlist gate, on both the block and mempool paths.
- Open-dispenser addresses are loaded once per block into a `Set` instead of one `SELECT COUNT(*)` per output.
- Corrected the Litecoin dust threshold from 546 to 5460 litoshis on all three networks.
- `getRawTransactions()` fetches with bounded concurrency, set by `DECODER_RPC_CONCURRENCY`.
- `blockFromBuffer` sanity-bounds the varint transaction count before looping.
- Aligned the `pubkeys` table collation to `utf8_unicode_ci` to match every other table.
- `verifyTables()` reconciles declared indexes on existing tables, fixing the silent omission of post-creation index statements.
- Input and block hash buffers are copied before byte-reversal so in-place mutation cannot corrupt shared decoded-block buffers.
- Corrected the leading `DROP TABLE` in `dispensers.sql` to target the right table name.
- `pubkeys.sql` uses the drop-then-create reset pattern so a manual rebuild resets the table.
- `AUX_POW` is parsed as an explicit boolean so `AUX_POW=false` and `AUX_POW=0` disable AuxPoW mode.
- The node tip is re-polled on a 30s wall-clock interval during catch-up so `lag_blocks` stays accurate.
- `verifyReorg()` reads `block_hash` from `getBlockByIndex()` so audit events record the real invalidated hash.
- `deleteBlockByIndex()` rolls back and releases its lock on any query failure instead of deadlocking.
- `verifyReorg()` guards against an empty blocks table when a reorg invalidates every processed block.
- `blockFromBuffer` strips the Litecoin MWEB marker and flag for the segwit+MWEB flag as well as the pure-MWEB one.
- `verifyTables()` reconciles column drift at startup, adding any column present in the SQL source but missing from the live table.
- Shipped the one-time migration that upgrades an existing database to full-column unique indexes.
- `blocks.previous_block_hash` is persisted in big-endian display format, with a migration for existing rows.
- `dropDatabase()` also drops `transaction_outputs`, `dispensers`, `mempool_transactions` and `pubkeys` so test suites reset cleanly.

### Security
- Added a `form-data` override pinning `^4.0.5` against GHSA-fjxv-7rqg-78g4 (weak multipart boundary CSPRNG).

## [1.11.10] - 2026-05-30

### Fixed
- Added a composite `(code, id)` index on `events` so reorg detection uses an index scan instead of a full-table scan.

## [1.11.9] - 2026-05-29

### Fixed
- `getRawTransaction` resolves null instead of rejecting on an empty result, so one evicted mempool tx no longer drops the whole batch.

## [1.11.8] - 2026-05-29

### Fixed
- `getRawTransaction` drops a dead HTTP 429 arm and treats `ECONNRESET`/`ECONNREFUSED` from Dogecoin v1.14 as work-queue-full, so the back-off applies.

## [1.11.7] - 2026-05-29

### Changed
- `package-lock.json` is committed and the Docker image builds with `npm ci`, so container images resolve the same dependency tree.

## [1.11.6] - 2026-05-29

### Fixed
- Corrected Litecoin's `dustThreshold` from 546 to 5460 satoshis on all three network variants.

## [1.11.5] - 2026-05-29

### Fixed
- `updateMempool` clears its busy flag in a `finally`, so a throwing `await` no longer freezes mempool tracking.

## [1.11.4] - 2026-05-29

### Fixed
- Block deletion during a reorg also removes dependent `transaction_outputs` and `dispensers` rows.
- The `DUPLICATED_TRANSACTION` sentinel is reachable on the instance, so duplicate-key inserts are detected and logged.

## [1.11.3] - 2026-05-28

### Removed
- Dropped the redundant "Connected to database!" startup log line.

## [1.11.2] - 2026-05-28

### Security
- Raised the minimum `axios` version to `^1.16.0` to close GHSA-q8qp-cvcw-x6jj (prototype-pollution credential-injection gadgets).

## [1.11.1] - 2026-05-28

### Fixed
- Removed the trailing-zero strip in MULTISIGN decoding so live ciphertext bytes are never dropped before decryption.

## [1.11.0] - 2026-05-28

### Fixed
- `index_addresses` and `index_transactions` declare full-column unique indexes and upsert race-safely, so duplicate rows can no longer accumulate.

### Migration
- `migrations/2026-05-28-unique-index-tables.sql` de-duplicates an existing database before the unique indexes can be applied; run it once with the decoder stopped, after taking a backup.

## [1.10.2] - 2026-05-28

### Security
- Pinned `qs` to `^6.15.2` to remediate GHSA-q8mj-m7cp-5q26 (denial of service in `qs.stringify`).

## [1.10.1] - 2026-05-28

### Removed
- Removed the unused `mysql` dependency; the service uses the `mariadb` driver only.

## [1.10.0] - 2026-04-08

### Added
- `PRICE` is a valid ACTION name, enabling validator and user oracle price actions on all supported chains.

## [1.9.0] - 2026-04-07

### Added
- New `pubkeys` table storing address-to-public-key mappings.
- `extractPubkeyFromInput()` recovers public keys from P2PKH scriptSig, P2WPKH witness, and P2SH-P2WPKH witness data.
- `hasPubkey()` and `insertPubkey()` on `Database` for public key storage.
- The source address public key is stored on first encounter during transaction parsing.

## [1.8.3] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README.

## [1.8.2] - 2026-04-05

### Removed
- Deleted the unreferenced vendored `bufferutils.js` from the project root.

## [1.8.1] - 2026-04-05

### Changed
- Moved the Stryker mutation configs and their mocharc files into `test/mutation/`.
- Updated the mutation npm scripts to the new config paths.

## [1.8.0] - 2026-04-02

### Added
- Nine staking and governance actions added to the valid ACTION names.

## [1.7.3] - 2026-04-02

### Changed
- Rewrote the README with badges, features, documentation links, quick start, and a scripts table.

## [1.7.2] - 2026-04-02

### Added
- Regression test suite with tiered execution across P0, P1 and P2 priorities.
- 76 tests tagged `[REGRESSION P0/P1/P2]` across the unit, boundary and security files.
- `npm run test:regression:critical` runs the P0 tier only.
- `npm run test:regression` runs the P0 and P1 tiers.
- `npm run test:regression:full` runs every tier.
- A `test/regression/` directory with its setup and a bug-fix regression template.

## [1.7.1] - 2026-04-02

### Added
- Mutation testing with Stryker Mutator.
- A phase 1 config targeting unit tests against the five core source files.
- A phase 2 config targeting unit and security tests together.
- Mocha timeout configs for mutation runs.
- HTML mutation report output under `reports/mutation/`.
- `.stryker-tmp/` and `stryker.log` added to `.gitignore`.

## [1.7.0] - 2026-04-02

### Added
- Chaos engineering suite of 50 tests covering node unavailability, RPC timeouts, pool exhaustion, mid-transaction failures, malformed mempool data, reorgs, concurrent instances, signal handling, unhandled rejections and fire-and-forget database calls.
- Chaos infrastructure: mock factories, fault injection helpers, and a console capture utility.
- `npm run test:chaos` script.
- A `health` JSON-RPC method reporting running state, sync status and error details.
- SIGTERM and SIGINT handlers for graceful decoder shutdown.
- A global `unhandledRejection` handler in the API process.
- An error handler on `decoder.start()` that tracks decoder crash state.

### Fixed
- `decoder.start()` gained a rejection handler, so a dead decoder can no longer serve healthy pings.
- `insertTransactionOutput()` is awaited, so failures are no longer silently lost.
- `transactionFromHex()` in the mempool loop is guarded, so one malformed tx hex cannot crash the process.
- `beginTransaction()` no longer leaks a connection when the call itself fails.
- The mempool processing loop uses a `for` loop, removing an infinite-loop path on null entries or insert failures.
- The mempool path null-checks `parseTransaction` output, which is null for coinbase transactions.
- `start()` reuses an existing `Database` instance instead of unconditionally creating one.

## [1.6.0] - 2026-04-02

### Added
- Performance and load benchmark suite with seven scenarios.
- Benchmark infrastructure: mock connector and database, a data generator building valid blocks with encrypted payloads, and a metrics collector.
- CLI harness with `--quick`, `--json`, `--compare`, `--save-baseline` and `--scenario` flags.
- An initial baseline captured from a full run.
- `npm run test:bench` and per-scenario scripts.

## [1.5.0] - 2026-04-02

### Added
- Fuzz suite with five harnesses covering deobfuscation, transaction parsing, block decoding, dispenser parsing and the full pipeline.
- Three mutation engines: bit flip, byte manipulation and a protocol-aware structure-aware mutator.
- Fuzz infrastructure: invariant checkers, a crash reporter that logs failing inputs, and seed corpus support.
- `npm run test:fuzz` and per-harness scripts.

## [1.4.0] - 2026-04-02

### Added
- Security suite of 75 tests covering SQL parameterization, deobfuscation robustness, ACTION validation, script bounds safety, DISPENSER field validation, connection handling, error sanitization and connector security.
- `npm run test:security` script.
- Post-decryption ACTION validation: a max payload length, a known-name allowlist, and strict UTF-8 decoding.
- A transaction mutex preventing async interleaving between block commits and mempool updates.
- A connection pool timeout replacing the infinite retry loop in `getConnection()`.
- Rate limiting and a body size limit on the Express API.
- HTTPS URL support in the blockchain connector.

### Fixed
- Closed a SQL injection risk in `createDatabase()` with a name allowlist and backtick quoting.
- Closed a SQL injection risk in `deleteAndCompareTxsNotInList()` by parameterizing the placeholders.
- Added bounds checks to P2SH and P2WSH data extraction so short scripts and witnesses no longer crash.
- DISPENSER expiration is validated numerically, rejecting NaN, negative and overflowing values.
- `parseInt(commandVersion)` gained its radix argument.
- Verbose error logging no longer risks leaking credentials; only the error code or message is logged.

## [1.3.0] - 2026-04-02

### Added
- Boundary suite of 78 tests covering deobfuscation, script type detection, multisig zero-trim, DISPENSER field extraction and satoshi conversion edge cases.
- Four boundary test files under `test/unit/boundary/`.

### Fixed
- `bigIntSatoshiToDecimalsString` no longer produces malformed output for negative inputs.
- Short DISPENSER strings no longer create immortal dispensers.
- `parseTransaction` no longer crashes when script decompilation returns null for non-script data.
- Multisig parsing no longer crashes when decompiled pubkey elements are opcodes rather than buffers.

## [1.2.0] - 2026-04-02

### Added
- End-to-end suite validating the complete decoder pipeline.
- Five end-to-end files covering action decoding, dispenser lifecycle, multi-block processing, error handling and the indexer contract.
- End-to-end helpers for building transactions and asserting dispenser, mempool and normalization state.
- `npm run test:e2e` script, which requires a regtest node and MariaDB.

## [1.1.0] - 2026-04-02

### Added
- Smoke suite of 52 tests for rapid service health checks.
- Eight smoke files covering module loading, crypto networks, deobfuscation, OP_RETURN and multisig parsing, block decoding, API ping and database initialization.
- `npm run test:smoke` script, which needs no external services.
- Optional MariaDB smoke tests gated by the `SMOKE_DB` environment variable.

## [1.0.0] - 2026-04-02

### Changed
- Bumped the version to 1.0.0.

## [0.0.4] - 2026-04-02

### Added
- Integration suite verifying the decoder-to-database pipeline against regtest.
- Test helpers for transaction construction and broadcast, and for indexer contract queries.
- `npm run test:integration` script, which requires a regtest node and MariaDB.

## [0.0.3] - 2026-04-02

### Added
- Unit suite covering all core modules in isolation.
- Test fixtures for deobfuscation and synthetic transactions.
- `npm run test:unit` script for running unit tests without external services.
- sinon and mocha as devDependencies.
