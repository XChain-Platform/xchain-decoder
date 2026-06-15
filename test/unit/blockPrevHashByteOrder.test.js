// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const util = require('../../src/util')

// Regression test for the byte order of blocks.previous_block_hash.
//
// Bug: Buffer.prototype.reverse() mutates the buffer in place and returns the
// same buffer. The block loop computed the display-format (big-endian) previous
// block hash once with `block.prevHash.reverse()`, then reversed the SAME buffer
// a second time when building the insertBlock payload. The second reverse undid
// the first, so every row was written with little-endian wire bytes instead of
// the big-endian display hash. Reorg detection was unaffected (it used the
// already-computed local variable), but the persisted value was wrong.
//
// Fix: reuse the already-computed `previousBlockHash` variable in the insertBlock
// payload instead of reversing the buffer a second time.
//
// This test drives the real start() loop for a single block, stubbing only the
// node connector, the database, and blockFromHex, and captures the value handed
// to db.insertBlock.
describe('XChainDecoder block previous_block_hash byte order', function () {
    this.timeout(0)

    // A 32-byte previous-hash in wire (little-endian) order, as it appears in the
    // raw block header. The display-format hash is this buffer byte-reversed.
    const wireBytes = Buffer.from(
        '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
        'hex'
    )
    const wireHex = util.uint8ArrayToHex(wireBytes)
    const displayHex = util.uint8ArrayToHex(Buffer.from(wireBytes).reverse())

    function buildDecoder() {
        const decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
        )
        decoder.startBlockIndex = 0
        decoder.sleep = async () => {}

        let inserted = null

        decoder.connector = {
            getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
            getBlockHash: async () => 'aabbccdd',
            getBlock: async () => ''
        }

        decoder.db = {
            createDatabase: async () => true,
            verifyDatabase: async () => true,
            verifyTables: async () => true,
            runMigrations: async () => ({ applied: [], pending: [] }),
            getLastBlockIndex: async () => -1,
            getLastTxIndex: async () => 0,
            beginTransaction: async () => {},
            commitTransaction: async () => {},
            deleteOpenDispensers: async () => {},
            purgeExpiredDispensers: async () => {},
            getAllOpenDispenserAddresses: async () => new Set(),
            insertBlock: async (block) => {
                inserted = block
                // Stop the loop after the first block so start() returns.
                decoder.stopFlag = true
                return true
            }
        }

        // Hand the loop a header-only block with a known wire-order prevHash and no
        // transactions. A fresh buffer per call mirrors the real decoder, which
        // decodes a new buffer for every block.
        decoder.xchainBlockDecoder = {
            blockFromHex: () => ({
                prevHash: Buffer.from(wireBytes),
                timestamp: 1700000000,
                transactions: []
            })
        }

        return { decoder, getInserted: () => inserted }
    }

    it('[REGRESSION P1] R-BUG-001: stores the big-endian display hash, not the reversed wire bytes', async function () {
        const { decoder, getInserted } = buildDecoder()

        await decoder.start()

        const inserted = getInserted()
        assert.ok(inserted, 'insertBlock should have been called for the first block')
        assert.strictEqual(
            inserted.previous_block_hash,
            displayHex,
            'previous_block_hash must be the big-endian display hash of the parent block'
        )
        assert.notStrictEqual(
            inserted.previous_block_hash,
            wireHex,
            'previous_block_hash must NOT be the little-endian wire bytes (the double-reverse bug)'
        )
    })
})
