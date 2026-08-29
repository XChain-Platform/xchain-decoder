<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Decoder

<p align="center">
  <img src="https://img.shields.io/badge/version-0.11.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1300%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20benchmarks%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

Transaction extraction service for the XChain Platform. Polls the coin nodes of every supported chain (Bitcoin, Litecoin, and Dogecoin today) via JSON-RPC, parses every block, identifies XChain-encoded transactions, deobfuscates the embedded ACTION payloads using AES-128-CTR, and writes the raw decoded data to a MariaDB database for the indexer to process.

## Features

- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin today on mainnet, testnet, and regtest
- **AES-128-CTR deobfuscation**: derives key and IV from the first input's txid
- **Four encoding formats**: OP_RETURN, P2SH (reassembled from scriptSigs), P2WSH (reassembled from witness data), and 1-of-3 multisig
- **Chain-specific parsing**: Litecoin MWEB/HogEx flag stripping; Dogecoin AuxPoW header stripping
- **Block reorganization detection**: identifies chain tip changes and rolls back affected blocks
- **DISPENSER protocol**: tracks active dispensers with soft-expiry, hard-purge after reorg-safe depth, and incoming payment detection
- **Mempool tracking**: indexes unconfirmed transactions every 60 seconds when synced
- **Normalized storage**: addresses and hashes stored as integer IDs for join efficiency
- **ACTION validation**: 34-name allowlist plus 5 short-form aliases (e.g. TRANSFER -> SEND) expanded before database writes
- **Parse-failure quarantine**: tx-level decode failures retry up to 3 times, then are quarantined as PARSE_ERROR events rather than halting the block
- **Source pubkey capture**: records the source address pubkey per transaction in a dedicated table for downstream use by the indexer
- **Native-coin fee tracking**: when FEE_DESTINATION is set, outputs paying that address are persisted to transaction_outputs for indexer fee validation
- **Graceful shutdown**: SIGTERM/SIGINT handlers complete in-flight work
- **Node RPC failover**: rotates through `NODE_URL_FALLBACK` endpoints after `NODE_FAILOVER_THRESHOLD` consecutive connection failures, round-robin, so a recovered primary is retried again if the fallback also dies
- **1300+ tests**: unit, integration, e2e, security, fuzz, chaos, mutation, regression, benchmarks, smoke

## Documentation

Full decoder documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/decoder) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/decoder/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/decoder/architecture.md) | Data pipeline, internal components, polling loop, deobfuscation, reorg handling |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/decoder/configuration.md) | Environment variables, internal constants, network-specific settings |
| [Database](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/decoder/database.md) | Full schema reference: 8 tables covering blocks, transactions, dispensers, indexes, events |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/decoder/operations.md) | Running, Docker, API endpoints, reorg handling, mempool, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-decoder.git
cd xchain-decoder
npm install
```

Create a `.env` file:

```env
NETWORK=bitcoin-regtest
NODE_URL=127.0.0.1
NODE_PORT=18443
NODE_USER=rpc
NODE_PASSWORD=rpc
DECODER_DB_HOST=127.0.0.1
DECODER_DB_PORT=3306
DECODER_DB_NAME=XChain_BTC_Regtest_Decoder
DECODER_DB_USER=root
DECODER_DB_PASS=
DECODER_API_PORT=3000
```

Start the decoder:

```bash
npm run api
```

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub. Edit it there and
re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the parity
check CI runs across the vendored copies.

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the decoder and API server |
| `npm run migrate` | Apply pending database migrations (auto + manual; `--file <name>` scopes to specific migration(s)) |
| `npm run ci` | The full no-external-services gate: unit, security, smoke, regression, chaos, and a 100-iteration fuzz pass (about a minute) |
| `npm run test:smoke` | Smoke tests (58 tests, no external services) |
| `npm run test:unit` | Unit tests (954 tests, no external services) |
| `npm run test:security` | Security tests (83 tests, no external services) |
| `npm run test:integration` | Integration tests (30 tests; brings up its own throwaway regtest node and MariaDB, requires Docker) |
| `npm run test:e2e` | End-to-end tests (72 tests; brings up its own throwaway regtest node and MariaDB on separate ports, requires Docker) |
| `npm run test:fuzz` | Fuzz tests (5 harnesses, 1000-5000 iterations each depending on harness) |
| `npm run test:fuzz:quick` | Quick fuzz (100 iterations) |
| `npm run test:chaos` | Chaos engineering tests (59 tests) |
| `npm run test:regression` | Regression tests P0+P1 (85 tests) |
| `npm run test:regression:critical` | Regression tests P0 only (54 tests, <1s) |
| `npm run test:regression:full` | Full regression suite (104 tests) |
| `npm run test:bench` | Performance benchmarks (7 scenarios) |
| `npm run test:bench:quick` | Quick benchmarks |
| `npm run test:mutation` | Mutation testing (Stryker Mutator) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Smoke | 58 | Module loading, network configs, deobfuscation, parsing, API ping, DB init |
| Unit | 954 | Core modules: BlockchainConnector, CryptoNetworks, parseTransaction, removeObfuscation, XChainBlockDecoder, util, boundary tests |
| Security | 83 | SQL parameterization, deobfuscation robustness, ACTION validation, DISPENSER field validation, error sanitization, connection handling |
| Boundary | 81 | AES deobfuscation edge cases, script type detection, multisig zero-trim, DISPENSER parsing, satoshi conversion -- subset of Unit, no separate script |
| Integration | 30 | OP_RETURN, multisig, P2SH, P2WSH, dispensers, malformed data, indexer contract queries (runs against its own containerised regtest node and MariaDB; requires Docker) |
| E2E | 72 | Full decoder pipeline: action decoding, dispenser lifecycle, multi-block processing, error handling |
| Fuzz | 42 | 5 harnesses: removeObfuscation, parseTransaction, blockDecoder, dispenserParsing, pipeline |
| Chaos | 59 | Node unavailability, RPC timeouts, DB pool exhaustion, mid-transaction failures, chain reorgs, signal handling |
| Regression | 104 | Tiered: P0 critical (54), P1 high (31), P2 standard (19) -- tagged across all suites |
| Benchmarks | 7 | Deobfuscation, parse-transaction, block-processing, sustained-sync, spike-load, large-payload, mempool-stress |
| Mutation | 2 | Phase 1 (unit) and Phase 2 (unit + security) via Stryker Mutator |
| **Total** | **1300+** | |

Which tier runs in which gate is recorded in `test/tier-manifest.json`, including the
written reason the benchmark and mutation tiers are gated by nothing. The mapping is
enforced by `test/unit/tierManifest.test.js`, so a tier cannot quietly drop out of CI.

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
