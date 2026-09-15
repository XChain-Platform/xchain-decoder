// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const BlockchainConnector = require('../../../src/chain/blockchain_connector')

let connector
let axiosStub

function registerConnectorHooks() {
    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'testuser', 'testpass')
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(() => {
        sinon.restore()
    })
}

describe('BlockchainConnector', () => {
    registerConnectorHooks()

    describe('#getBlockWithoutAuxPow()', () => {
        it('[REGRESSION P2] R-NET-003: should strip AuxPoW data from block hex', async () => {
            // Header = 200 hex chars (100 bytes, includes 20 bytes of AuxPoW)
            // Standard bitcoin header = 160 hex chars (80 bytes)
            // So dataToRemove = 200 - 160 = 40 hex chars
            const auxPowHeader = 'a'.repeat(200)
            const blockBody = 'b'.repeat(100)
            const fullBlockHex = auxPowHeader.substring(0, 160) + 'x'.repeat(40) + blockBody

            // getBlockHeader returns the full header including AuxPoW
            axiosStub.onCall(0).resolves({ data: { result: auxPowHeader } }) // getBlockHeader
            axiosStub.onCall(1).resolves({ data: { result: fullBlockHex } })  // getBlock

            const result = await connector.getBlockWithoutAuxPow('hash')

            // Result should be first 160 chars + body (without the 40 AuxPoW chars)
            assert.strictEqual(result.length, 160 + blockBody.length)
            assert.strictEqual(result.substring(0, 160), fullBlockHex.substring(0, 160))
        })

        it('should not strip anything when header is exactly 160 hex chars (80 bytes)', async () => {
            const standardHeader = 'a'.repeat(160)
            const blockHex = standardHeader + 'bbbb'

            axiosStub.onCall(0).resolves({ data: { result: standardHeader } })
            axiosStub.onCall(1).resolves({ data: { result: blockHex } })

            const result = await connector.getBlockWithoutAuxPow('hash')
            assert.strictEqual(result, blockHex)
        })

        it('should propagate an RPC error unwrapped', async () => {
            // Wrapping every throw, transport faults included, in a
            // bare Error. That discarded error.code, so the decoder counted node overload
            // toward the malformed-AuxPoW escalation and pointed a per-tx reassembly
            // fan-out at the node that was already saturated. RPC faults propagate
            // untouched; only header-strip/parse faults are wrapped, and those are tagged
            // auxPowParseFailure (covered in auxpowReassembly.test.js).
            const rpcErr = new Error('network')
            rpcErr.code = 'ECONNRESET'
            axiosStub.rejects(rpcErr)

            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('hash'),
                (err) => {
                    assert.strictEqual(err.message, 'network', 'original message preserved')
                    assert.strictEqual(err.code, 'ECONNRESET', 'original error.code preserved')
                    assert.ok(!err.auxPowParseFailure, 'a transport fault is not a content fault')
                    return true
                }
            )
        })
    })
})

describe('BlockchainConnector', () => {
    registerConnectorHooks()

    describe('#getBlockWithoutAuxPow()', () => {
        it('[REGRESSION] R-NET-004: strips a structurally valid DOGE mainnet AuxPoW block and result parses via bitcoinjs-lib Block.fromBuffer', async () => {
            // Fixture constructed from a DOGE mainnet AuxPoW block.
            // DOGE mainnet blocks are merge-mined: getblockheader(hash, false) returns the
            // 80-byte base header PLUS the AuxPoW extension (more than 160 hex chars).
            // getblock(hash, 0) returns the same structure followed by transaction data.
            // After stripping, the result must be parseable by bitcoinjs-lib Block.fromBuffer.
            //
            // Base header: version 0x00620100 (LE: 00016200) has AuxPoW flag (bit 0x100) set.
            // The 80 bytes after stripping form a valid standard header that bitcoinjs-lib can parse.
            const BASE_HEADER_HEX =
                '00016200' +  // version 0x00620100 (LE), AuxPoW flag (0x100) set
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +  // prevHash 32 bytes
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +  // merkleRoot 32 bytes
                '00f15365' +  // timestamp 1700000000 (LE)
                'ffff001d' +  // bits
                '39300000'    // nonce

            // AuxPoW data: 342 bytes (684 hex chars) representative of a typical merge-mining
            // proof of work. The exact bytes do not affect the strip arithmetic test.
            const AUX_POW_HEX = 'cc'.repeat(342)

            // Minimal coinbase transaction (version=1, 1 input, 1 output, locktime=0)
            const COINBASE_TX_HEX = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0704ffff001d0104ffffffff0100f2052a010000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
            const N_TX_VARINT = '01'  // 1 transaction

            // getblockheader(hash, false): base header + AuxPoW (no tx data)
            const fullHeaderHex = BASE_HEADER_HEX + AUX_POW_HEX
            // getblock(hash, 0): base header + AuxPoW + tx count varint + coinbase tx
            const fullBlockHex  = BASE_HEADER_HEX + AUX_POW_HEX + N_TX_VARINT + COINBASE_TX_HEX

            axiosStub.onCall(0).resolves({ data: { result: fullHeaderHex } })  // getBlockHeader
            axiosStub.onCall(1).resolves({ data: { result: fullBlockHex  } })  // getBlock

            const stripped = await connector.getBlockWithoutAuxPow('doge-mainnet-block-hash')

            // After stripping, the AuxPoW section between the header and the tx varint is gone
            // Strip should remove exactly AUX_POW_HEX.length chars at offset 160
            const expectedStripped = BASE_HEADER_HEX + N_TX_VARINT + COINBASE_TX_HEX
            assert.strictEqual(stripped, expectedStripped, 'stripped hex must equal base header + transactions')

            // The critical assertion: the stripped result must parse via bitcoinjs-lib
            // Block.fromBuffer, validating that the AuxPoW seam produces a conformant block.
            // Verify the result parses as a valid block
            const bitcoin = require('bitcoinjs-lib')
            const block = bitcoin.Block.fromBuffer(Buffer.from(stripped, 'hex'))
            assert.ok(block, 'Block.fromBuffer must succeed on stripped result')
            assert.strictEqual(block.version, 0x00620100, 'parsed version must match DOGE AuxPoW block version')
            assert.ok(Array.isArray(block.transactions) && block.transactions.length === 1, 'parsed block must contain the coinbase transaction')
        })
    })
})

describe('BlockchainConnector', () => {
    registerConnectorHooks()

    describe('#getBlockWithoutAuxPow()', () => {
        it('[REGRESSION] R-NET-005: Dogecoin Core 1.14 structural-parse path - getblockheader returns exactly 160 hex chars (no AuxPoW bytes) but block has AuxPoW version bit set', async () => {
            // Dogecoin Core 1.14.x getblockheader serializes the CBlockIndex header only
            // (always 80 bytes / 160 hex chars), never the block's AuxPoW section, even for
            // merge-mined blocks. This case requires parsing the AuxPoW structure from
            // the block hex directly and stripping it.
            const BASE_HEADER_HEX =
                '00016200' +  // version 0x00620100 (LE), AuxPoW flag (0x100) set
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +  // prevHash 32 bytes
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +  // merkleRoot 32 bytes
                '00f15365' +  // timestamp 1700000000 (LE)
                'ffff001d' +  // bits
                '39300000'    // nonce

            // Minimal coinbase tx: version=1, 1 input (coinbase prevout), 1 output, locktime=0
            const COINBASE_TX_HEX = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0704ffff001d0104ffffffff0100f2052a010000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
            // AuxPoW remainder after coinbase tx:
            //   parent block hash (32 bytes) + coinbase branch varint 0x00 + 4-byte index +
            //   chain branch varint 0x00 + 4-byte index + parent block header (80 bytes)
            const PARENT_HASH   = '00'.repeat(32)       // 32 bytes
            const CB_BRANCH     = '00' + '00000000'     // varint(0) + index (4 bytes)
            const CHAIN_BRANCH  = '00' + '00000000'     // varint(0) + index (4 bytes)
            const PARENT_HEADER = '00'.repeat(80)       // 80 bytes
            const AUX_POW_TAIL  = PARENT_HASH + CB_BRANCH + CHAIN_BRANCH + PARENT_HEADER
            const FULL_AUX_POW  = COINBASE_TX_HEX + AUX_POW_TAIL

            const N_TX_VARINT = '01'

            // Dogecoin Core 1.14: getblockheader returns ONLY the 80-byte base header
            const headerHex = BASE_HEADER_HEX  // exactly 160 hex chars
            // getblock returns the full wire format: base header + AuxPoW + tx count + txs
            const fullBlockHex = BASE_HEADER_HEX + FULL_AUX_POW + N_TX_VARINT + COINBASE_TX_HEX

            axiosStub.onCall(0).resolves({ data: { result: headerHex    } })  // getBlockHeader (160 chars)
            axiosStub.onCall(1).resolves({ data: { result: fullBlockHex } })  // getBlock

            const stripped = await connector.getBlockWithoutAuxPow('doge-114-block-hash')

            const expectedStripped = BASE_HEADER_HEX + N_TX_VARINT + COINBASE_TX_HEX
            assert.strictEqual(stripped, expectedStripped, 'structural-parse path must strip AuxPoW when getblockheader returns only 160 hex chars')

            const bitcoin = require('bitcoinjs-lib')
            const block = bitcoin.Block.fromBuffer(Buffer.from(stripped, 'hex'))
            assert.ok(block, 'Block.fromBuffer must succeed on structural-parse stripped result')
            assert.strictEqual(block.version, 0x00620100, 'parsed version must match DOGE AuxPoW version')
        })
    })
})
