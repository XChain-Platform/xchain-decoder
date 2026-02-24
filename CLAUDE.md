# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the decoder + API server
npm run api

# Run all tests (requires running bitcoind regtest + MariaDB — see Tests section)
npm test

# Docker
docker-compose up --build
```

The `npm test` command has no granular single-test option; mocha runs all `test/*.test.js` files. `prepareRegtest.test.js` is a mocha root hook (not a test file itself) that sets up the regtest environment before the tests run.

## Architecture Overview

The decoder is a single long-running Node.js process that polls a Bitcoin-compatible node via JSON-RPC, decodes XChain protocol data from transactions, and writes results to MariaDB.

### Data Flow

```
Coin node (bitcoind/litecoind/dogecoind)
    ↓  JSON-RPC (BlockchainConnector.js)
XChainDecoder.js  ←→  XChainBlockDecoder.js (coin-specific block parsing)
    ↓  MariaDB (db.js)
MariaDB tables: blocks, transactions, mempool_transactions, dispensers, ...
    ↑
Express JSON-RPC API (api.js) — currently only exposes a `ping` method
```

### Key Source Files

- **`src/api.js`** — Entry point. Reads env vars, instantiates `XChainDecoder`, calls `decoder.start()`, and starts an Express JSON-RPC API.
- **`src/XChainDecoder.js`** — Core class. Runs a polling loop: waits for node sync (`verificationprogress >= 0.99`), fetches blocks in order, calls `parseTransaction()` per tx, commits to DB. Also handles mempool updates (every 60s when synced) and chain reorg detection.
- **`src/XChainBlockDecoder.js`** — Wraps bitcoinjs-lib block parsing with coin-specific fixes. Litecoin has special handling to strip the HogEx flag (`0x08`) before parsing the last transaction.
- **`src/BlockchainConnector.js`** — Thin JSON-RPC client for coin node calls (`getblockchaininfo`, `getblock`, `getrawtransaction`, etc.). `getBlockWithoutAuxPow()` strips AuxPoW headers for coins like Dogecoin before passing to bitcoinjs-lib.
- **`src/db.js`** — MariaDB layer using `mariadb` connection pools. Auto-creates the database and tables from `src/sql/*.sql` on startup. Addresses and tx hashes are normalized into `index_addresses` / `index_transactions` tables and referenced by integer ID everywhere else.
- **`src/CryptoNetworks.js`** — Returns `bitcoinjs-lib` network config objects and `startBlockIndex` for each supported network (`bitcoin`, `litecoin`, `dogecoin` × `mainnet`/`testnet`/`regtest`).

### XChain Transaction Encoding

XChain data embedded in transactions is AES-128-CTR obfuscated:
- **Key**: first 16 hex chars of the first input's txid
- **IV**: next 16 hex chars of the first input's txid

After deobfuscation, valid XChain data starts with the magic bytes `XCHN`. The payload after `XCHN` is decoded based on the output script type:

| Script type | How data is carried |
|---|---|
| OP_RETURN | Data directly in the OP_RETURN push |
| OP_RETURN with `XCHNp2sh` | Data reassembled from P2SH redeem scripts across all inputs |
| OP_RETURN with `XCHNp2wsh` | Data reassembled from P2WSH witness scripts across all inputs |
| 1-of-3 multisig | Data packed into pubkeys 1 & 2 (first byte stripped), trailing zeros removed |

The source address is resolved by looking up the output spent by the transaction's first input. P2SH sources chase one level deeper to the first input of the redeeming transaction.

### DISPENSER Protocol

When a decoded transaction's data starts with `DISPENSER|0|...`, the decoder parses the pipe-delimited fields and writes a row to the `dispensers` table (keyed by source address + expiration). On every new block, expired dispensers are deleted. When any output of a subsequent transaction pays to an active dispenser's address, that output is recorded in `transaction_outputs`.

### Database Tables

| Table | Purpose |
|---|---|
| `blocks` | One row per parsed block |
| `transactions` | XChain-relevant confirmed transactions |
| `mempool_transactions` | Unconfirmed XChain-relevant transactions |
| `dispensers` | Open (unexpired) dispensers by address |
| `transaction_outputs` | Outputs that paid to a dispenser address |
| `index_addresses` | Normalized address → integer ID lookup |
| `index_transactions` | Normalized tx/block hash → integer ID lookup |
| `events` | Reorg events (JSON payload) |

### Environment Variables

Configure via `.env` file (loaded with `dotenv`):

```
NETWORK=bitcoin-regtest          # or bitcoin-mainnet, litecoin-mainnet, dogecoin-mainnet, etc.
NODE_URL=127.0.0.1
NODE_PORT=8333
NODE_USER=rpc
NODE_PASSWORD=rpc
DECODER_DB_HOST=127.0.0.1
DECODER_DB_PORT=3306
DECODER_DB_NAME=xchain_decoder
DECODER_DB_USER=root
DECODER_DB_PASS=
DECODER_API_PORT=3000
AUX_POW=                         # Set to any truthy value for networks with AuxPoW (e.g. Dogecoin)
```

## Tests

Tests use Mocha with no timeout (`--timeout 0`). The test suite requires:
- `bitcoind` and `bitcoin-cli` in PATH (for bitcoin regtest)
- A running MariaDB instance accessible with the env vars above

`prepareRegtest.test.js` is a Mocha root hook that:
1. Drops and recreates the `<DB_NAME>_regtest` database
2. Stops any running `bitcoind -regtest`, wipes `~/.bitcoin/regtest`, and restarts it fresh
3. Creates a wallet, generates 101 blocks to fund it, then starts the decoder

`XChainDecoder.test.js` tests `parseRawTransaction()` against hardcoded transaction hex strings (no node needed for these unit tests).

`RegtestParsing.test.js` broadcasts real transactions to the regtest node and verifies the decoder picks them up from the DB.
