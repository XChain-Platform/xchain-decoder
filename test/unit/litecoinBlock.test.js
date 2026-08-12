// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Unit tests for the litecoin-specific blockFromBuffer path in
// XChainBlockDecoder: the custom block parser that handles Litecoin's HogEx /
// MWEB extension marker bytes, which bitcoinjs-lib's Block.fromBuffer rejects.
// Block buffers are built in-process rather than pulled from a live node, so
// these stay pure unit tests.

const assert    = require('assert')
const bitcoin   = require('bitcoinjs-lib')
const crypto    = require('crypto')
const XChainBlockDecoder = require('../../src/XChainBlockDecoder')

// Build an 80-byte standard block header buffer
function buildHeader({ version = 2, timestamp = 1700000000 } = {}) {
    const buf = Buffer.alloc(80)
    buf.writeInt32LE(version, 0)           // version
    Buffer.alloc(32, 0xaa).copy(buf, 4)    // prevHash
    Buffer.alloc(32, 0xbb).copy(buf, 36)   // merkleRoot
    buf.writeUInt32LE(timestamp, 68)       // timestamp
    buf.writeUInt32LE(0x1d00ffff, 72)      // bits
    buf.writeUInt32LE(0x39300000, 76)      // nonce
    return buf
}

// Serialize a varint (only supports values < 0xFD for simplicity)
function varint(n) {
    const buf = Buffer.alloc(1)
    buf.writeUInt8(n)
    return buf
}

// Build a minimal standard non-segwit transaction (no inputs, no outputs)
// Serialization: version(4) + varint_inputs(1) + varint_outputs(1) + locktime(4)
function buildMinimalTxBuf({ version = 1, markerFlag = null } = {}) {
    const versionBuf = Buffer.alloc(4)
    versionBuf.writeInt32LE(version, 0)
    const locktime = Buffer.alloc(4, 0)

    if (markerFlag) {
        // Segwit / MWEB style: version + 0x00 marker + flag + inputs + outputs + locktime.
        // With zero inputs there are no witness stacks to serialize between the two.
        const marker = Buffer.from([0x00, markerFlag])
        return Buffer.concat([versionBuf, marker, varint(0), varint(0), locktime])
    }
    return Buffer.concat([versionBuf, varint(0), varint(0), locktime])
}

// Compose a block buffer: header + varint(txCount) + tx1 bytes + ... + txN bytes
function buildBlockBuf(header, txBuffers) {
    return Buffer.concat([header, varint(txBuffers.length), ...txBuffers])
}

describe('XChainBlockDecoder litecoin blockFromBuffer', () => {
    let decoder

    before(() => {
        decoder = new XChainBlockDecoder('litecoin-mainnet')
        assert.strictEqual(decoder.coin, 'litecoin')
    })

    it('should parse a litecoin header-only block (80 bytes)', () => {
        const header = buildHeader({ version: 2, timestamp: 1700000001 })
        const block  = decoder.blockFromBuffer(header)

        assert.strictEqual(block.version, 2)
        assert.strictEqual(block.timestamp, 1700000001)
        assert.strictEqual(block.prevHash.length, 32)
        assert.strictEqual(block.merkleRoot.length, 32)
    })

    it('should parse a litecoin block with one standard (non-HogEx) transaction', () => {
        const header = buildHeader()
        const txBuf  = buildMinimalTxBuf({ version: 1 })
        const blockBuf = buildBlockBuf(header, [txBuf])

        const block = decoder.blockFromBuffer(blockBuf)
        assert.ok(Array.isArray(block.transactions))
        assert.strictEqual(block.transactions.length, 1)
    })

    it('should parse a litecoin block with two transactions where last has no HogEx flag', () => {
        const header = buildHeader()
        const tx1 = buildMinimalTxBuf({ version: 1 })
        const tx2 = buildMinimalTxBuf({ version: 2 })
        const blockBuf = buildBlockBuf(header, [tx1, tx2])

        const block = decoder.blockFromBuffer(blockBuf)
        assert.ok(Array.isArray(block.transactions))
        assert.strictEqual(block.transactions.length, 2)
    })

    it('should strip MWEB (0x08) flag from the last transaction', () => {
        const header = buildHeader()
        const tx1 = buildMinimalTxBuf({ version: 1 })
        const tx2 = buildMinimalTxBuf({ version: 1, markerFlag: 0x08 })
        const blockBuf = buildBlockBuf(header, [tx1, tx2])

        // Must not throw: the HogEx flag is stripped so bitcoinjs-lib sees a standard tx.
        const block = decoder.blockFromBuffer(blockBuf)
        assert.ok(Array.isArray(block.transactions))
    })

    it('should strip segwit+MWEB (0x09) flag from the last transaction', () => {
        const header = buildHeader()
        const tx1 = buildMinimalTxBuf({ version: 1 })
        const tx2 = buildMinimalTxBuf({ version: 2, markerFlag: 0x09 })
        const blockBuf = buildBlockBuf(header, [tx1, tx2])

        const block = decoder.blockFromBuffer(blockBuf)
        assert.ok(Array.isArray(block.transactions))
    })

    it('should throw for a buffer smaller than 80 bytes', () => {
        const tooSmall = Buffer.alloc(50, 0x00)
        assert.throws(() => {
            decoder.blockFromBuffer(tooSmall)
        }, /Buffer too small/)
    })

    it('should propagate an error when a transaction cannot be parsed (catch+rethrow path)', () => {
        // A block claiming 1 transaction with no transaction bytes after the header makes
        // readTransaction() overread the buffer. The parser must rethrow rather than
        // swallow: a silently truncated transaction list is a consensus divergence.
        const header = buildHeader()
        const blockBuf = Buffer.concat([header, varint(1)])  // says 1 tx, no tx bytes follow
        assert.throws(() => {
            decoder.blockFromBuffer(blockBuf)
        })
    })

    it('should parse the block header fields correctly for litecoin blocks with transactions', () => {
        const header = buildHeader({ version: 4, timestamp: 1750000000 })
        const txBuf  = buildMinimalTxBuf({ version: 1 })
        const blockBuf = buildBlockBuf(header, [txBuf])

        const block = decoder.blockFromBuffer(blockBuf)
        assert.strictEqual(block.version, 4)
        assert.strictEqual(block.timestamp, 1750000000)
    })

    it('should use bitcoinjs Block.fromBuffer for non-litecoin coins (default path)', () => {
        const btcDecoder = new XChainBlockDecoder('bitcoin-regtest')
        const header = buildHeader()
        const txBuf  = buildMinimalTxBuf({ version: 1 })
        const blockBuf = buildBlockBuf(header, [txBuf])

        const block = btcDecoder.blockFromBuffer(blockBuf)
        assert.ok(block)
        assert.strictEqual(block.version, 2)
    })

    it('should populate witnessCommit when the coinbase tx contains a BIP141 witness commitment', () => {
        // A minimal segwit litecoin block with:
        //   - one segwit coinbase transaction (marker=0x00 flag=0x01)
        //   - the coinbase's first input has a 32-byte witness (satisfies txesHaveWitnessCommit)
        //   - the coinbase output #1 is OP_RETURN 0xaa21a9ed + 32-byte witness root hash
        // This exercises the `if (witnessCommit) block.witnessCommit = witnessCommit` branch.
        const SEGWIT_LITECOIN_BLOCK_HEX =
            '04000000' +                                                          // version 4
            'aa'.repeat(32) +                                                     // prevHash
            'bb'.repeat(32) +                                                     // merkleRoot
            '00f15365' +                                                          // timestamp
            'ffff001d' +                                                          // bits
            '78563412' +                                                          // nonce
            '01' +                                                                // 1 transaction
            // coinbase segwit tx:
            '01000000' +                                                          // version
            '00' +                                                                // segwit marker
            '01' +                                                                // segwit flag
            '01' +                                                                // 1 input
            '00'.repeat(32) + 'ffffffff' +                                        // prevhash + previndex
            '04' + '03000000' + 'ffffffff' +                                      // scriptLen(4) + coinbase script + seq
            '02' +                                                                // 2 outputs
            '00f2052a01000000' + '19' + '76a914' + 'aa'.repeat(20) + '88ac' +    // 50 BTC P2PKH
            '0000000000000000' + '26' + '6a24aa21a9ed' + 'ab'.repeat(32) +       // 0 sat witness commit
            '01' +                                                                // 1 witness stack item
            '20' + '00'.repeat(32) +                                              // 32-byte reserved value
            '00000000'                                                             // locktime

        const block = decoder.blockFromBuffer(Buffer.from(SEGWIT_LITECOIN_BLOCK_HEX, 'hex'))

        assert.ok(block)
        assert.ok(Array.isArray(block.transactions))
        assert.strictEqual(block.transactions.length, 1)

        // The witnessCommit branch was taken
        assert.ok(block.witnessCommit instanceof Buffer, 'witnessCommit should be a Buffer')
        assert.strictEqual(block.witnessCommit.length, 32)
        // The hash we embedded was 0xab * 32
        assert.ok(block.witnessCommit.equals(Buffer.alloc(32, 0xab)), 'witnessCommit hash should match embedded value')
    })
})

describe('XChainBlockDecoder litecoin blockFromBuffer: forged tx count', () => {
    let decoder

    beforeEach(() => {
        decoder = new XChainBlockDecoder('litecoin-mainnet')
    })

    it('rejects a varint tx count structurally impossible for the remaining bytes', () => {
        // Header + varint claiming 200 txns, but only one ~10-byte tx follows.
        // Before the sanity bound this failed later via an unnamed buffer
        // over-read inside Transaction.fromBuffer; now it throws a named error
        // before the loop starts.
        const header = buildHeader()
        const oneTx  = buildMinimalTxBuf()
        const forged = Buffer.concat([header, varint(200), oneTx])
        assert.throws(() => decoder.blockFromBuffer(forged), /invalid transaction count/)
    })

    it('still parses an honest single-tx block', () => {
        const header = buildHeader()
        const blockBuf = buildBlockBuf(header, [buildMinimalTxBuf()])
        const block = decoder.blockFromBuffer(blockBuf)
        assert.strictEqual(block.transactions.length, 1)
    })
})
