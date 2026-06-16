<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Decoder

<p align="center">
  <img src="https://img.shields.io/badge/version-1.8.3-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-500%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20boundary%20%7C%20smoke%20%7C%20security%20%7C%20regression-brightgreen" alt="Coverage">
</p>

Transaction extraction service for the XChain Platform. Polls cryptocurrency nodes (Bitcoin, Litecoin, Dogecoin) via JSON-RPC, parses every block, identifies XChain-encoded transactions, deobfuscates the embedded ACTION payloads using AES-128-CTR, and writes the raw decoded data to a MariaDB database for the indexer to process.

## Features

- **Multi-chain support** — Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest
- **AES-128-CTR deobfuscation** — derives key and IV from the first input's txid
- **Four encoding formats** — OP_RETURN, P2SH (reassembled from scriptSigs), P2WSH (reassembled from witness data), and 1-of-3 multisig
- **Chain-specific parsing** — Litecoin MWEB/HogEx flag stripping; Dogecoin AuxPoW header stripping
- **Block reorganization detection** — identifies chain tip changes and rolls back affected blocks
- **DISPENSER protocol** — tracks active dispensers with expiration, detects incoming payments
- **Mempool tracking** — indexes unconfirmed transactions every 60 seconds when synced
- **Normalized storage** — addresses and hashes stored as integer IDs for join efficiency
- **ACTION validation** — 33-name whitelist enforced before database writes
- **Graceful shutdown** — SIGTERM/SIGINT handlers complete in-flight work
- **500+ tests** — unit, integration, e2e, boundary, security, fuzz, chaos, regression, benchmarks, mutation

## Documentation

Full decoder documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/decoder) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/decoder/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/decoder/ARCHITECTURE.md) | Data pipeline, internal components, polling loop, deobfuscation, reorg handling |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/decoder/CONFIGURATION.md) | Environment variables, internal constants, network-specific settings |
| [Database](https://github.com/XChain-platform/xchain-documentation/blob/master/components/decoder/DATABASE.md) | Full schema reference — 8 tables covering blocks, transactions, dispensers, indexes, events |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/decoder/OPERATIONS.md) | Running, Docker, API endpoints, reorg handling, mempool, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-decoder.git
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

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the decoder and API server |
| `npm run test:smoke` | Smoke tests (52 tests, no external services) |
| `npm run test:unit` | Unit tests (221 tests, no external services) |
| `npm run test:security` | Security tests (75 tests, no external services) |
| `npm run test:integration` | Integration tests (requires bitcoind regtest + MariaDB) |
| `npm run test:e2e` | End-to-end tests (requires full stack) |
| `npm run test:fuzz` | Fuzz tests (5 harnesses, 1000 iterations each) |
| `npm run test:fuzz:quick` | Quick fuzz (100 iterations) |
| `npm run test:chaos` | Chaos engineering tests (50 tests) |
| `npm run test:regression` | Regression tests P0+P1 (57 tests) |
| `npm run test:regression:critical` | Regression tests P0 only (47 tests, <1s) |
| `npm run test:regression:full` | Full regression suite (76 tests) |
| `npm run test:bench` | Performance benchmarks (7 scenarios) |
| `npm run test:bench:quick` | Quick benchmarks |
| `npm run test:mutation` | Mutation testing (Stryker Mutator) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Smoke | 52 | Module loading, network configs, deobfuscation, parsing, API ping, DB init |
| Unit | 221 | Core modules: BlockchainConnector, CryptoNetworks, parseTransaction, removeObfuscation, XChainBlockDecoder, util, boundary tests |
| Security | 75 | SQL parameterization, deobfuscation robustness, ACTION validation, DISPENSER field validation, error sanitization, connection handling |
| Boundary | 78 | AES deobfuscation edge cases, script type detection, multisig zero-trim, DISPENSER parsing, satoshi conversion |
| Integration | 30+ | OP_RETURN, multisig, P2SH, P2WSH, dispensers, malformed data, indexer contract queries (requires bitcoind + MariaDB) |
| E2E | 50+ | Full decoder pipeline: action decoding, dispenser lifecycle, multi-block processing, error handling |
| Fuzz | 42 | 5 harnesses: removeObfuscation, parseTransaction, blockDecoder, dispenserParsing, pipeline |
| Chaos | 50 | Node unavailability, RPC timeouts, DB pool exhaustion, mid-transaction failures, chain reorgs, signal handling |
| Regression | 76 | Tiered: P0 critical (47), P1 high (10), P2 standard (19) — tagged across all suites |
| Benchmarks | 7 | Deobfuscation, parse-transaction, block-processing, sustained-sync, spike-load, large-payload, mempool-stress |
| Mutation | 2 | Phase 1 (unit) and Phase 2 (unit + security) via Stryker Mutator |
| **Total** | **500+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/licensing).

## License

XChain Platform is **open source**, dual-licensed under:

- the **[GNU Affero General Public License v3.0](./LICENSE.md)** (`AGPL-3.0-or-later`), free for everyone, and
- a **[commercial license](https://docs.xchain.io/legal/commercial-license)** for companies that need to keep modifications private.

See the **[licensing overview](https://docs.xchain.io/legal/licensing)** for which one applies to you. "XChain" is a trademark of Dankest, LLC. See the **[Trademark Policy](https://docs.xchain.io/legal/trademark)**.

Copyright © 2025-2026 Dankest, LLC.
