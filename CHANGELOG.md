# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
