# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
