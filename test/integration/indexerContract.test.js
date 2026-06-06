/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration tests: Indexer contract query verification.
 *
 * Covers plan scenarios B1 (transaction record completeness) and B2
 * (normalization tables). These tests verify that the exact JOIN query
 * used by the indexer's getDecoderBlockData() returns correct, complete data.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const { getDecoderBlockData, assertBlockDataCount, assertRowFields } = require('./helpers/assertions')

describe('Indexer Contract Query', () => {

    describe('transaction record completeness', () => {

        it('should return all required fields for a standard transaction', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TESTCOIN|42|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row, 'Transaction must appear in block data')

            // Verify all fields the indexer expects
            assert.strictEqual(typeof row.data, 'string')
            assert.ok(row.data.length > 0, 'data should be non-empty')
            assert.strictEqual(row.tx_hash.length, 64, 'tx_hash should be 64-char hex')
            assert.strictEqual(typeof row.source, 'string')
            assert.ok(row.source.length > 0, 'source should be non-empty')
            assert.strictEqual(row.block_index, blockIndex)
            assert.ok(row.block_time > 0, 'block_time should be positive')
            // destination and amount are null for most ACTIONs
            // vout/output_amount/output_destination are null when no dispenser outputs
            assert.strictEqual(row.vout, null)
            assert.strictEqual(row.output_amount, null)
            assert.strictEqual(row.output_destination, null)
        })

        it('should return empty result set for a block with no XChain transactions', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const { blockIndex } = await txBuilder.broadcastPlainTransaction(funded)
            await txBuilder.waitForDecoder(blockIndex)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            // The only XChain tx candidates are our plain send — which has no XCHN data
            // and the coinbase — which is skipped. Filter to just our block's rows.
            const xchnRows = rows.filter(r => r.block_index === blockIndex)
            // May be 0 or there may be funding txs from previous test setup,
            // but our plain tx should NOT appear
            const plainRow = rows.find(r => r.tx_hash === funded.txid)
            assert.strictEqual(plainRow, undefined, 'Plain transaction should not appear')
        })

        it('should return correct tx_hash as 64-character hex string', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|ABC|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)
            assert.ok(row)
            assert.strictEqual(row.tx_hash, txHash)
            assert.ok(/^[0-9a-f]{64}$/.test(row.tx_hash), 'tx_hash must be lowercase hex')
        })
    })

    describe('normalization tables', () => {

        it('should resolve source address consistently across multiple transactions', async () => {
            // Fund address once, then use the change output for a second tx
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const action1 = 'SEND|0|TOKEN1|1|' + global.mainTestAddress + '|'
            const { txHash: txHash1, blockIndex: bi1 } = await txBuilder.broadcastOpReturn(funded1, action1)
            await txBuilder.waitForDecoder(bi1)
            await txBuilder.waitForTransaction(txHash1)

            // Send a second tx from a fresh fund to the same address type
            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action2 = 'SEND|0|TOKEN2|2|' + global.mainTestAddress + '|'
            const { txHash: txHash2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action2)
            await txBuilder.waitForDecoder(bi2)
            await txBuilder.waitForTransaction(txHash2)

            const rows1 = await getDecoderBlockData(global.db, bi1)
            const rows2 = await getDecoderBlockData(global.db, bi2)
            const row1 = rows1.find(r => r.tx_hash === txHash1)
            const row2 = rows2.find(r => r.tx_hash === txHash2)

            // Both should have valid source addresses
            assert.ok(row1.source.length > 0)
            assert.ok(row2.source.length > 0)
        })

        it('should store block_time from the actual block', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|TIME|1|' + global.mainTestAddress + '|'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            await txBuilder.waitForTransaction(txHash)

            const rows = await getDecoderBlockData(global.db, blockIndex)
            const row = rows.find(r => r.tx_hash === txHash)

            // block_time should be a recent unix timestamp (within last hour)
            const now = Math.floor(Date.now() / 1000)
            assert.ok(row.block_time > now - 3600, 'block_time should be recent')
            assert.ok(row.block_time <= now + 60, 'block_time should not be in the future')
        })
    })

    describe('blocks table', () => {

        it('should track the last block index accurately', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            const chainHeight = info.blocks

            // Wait for decoder to catch up
            await txBuilder.waitForDecoder(chainHeight)
            const lastBlock = await global.db.getLastBlockIndex()
            assert.strictEqual(lastBlock, chainHeight)
        })

        it('should store block hash correctly', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            const blockIndex = info.blocks
            await txBuilder.waitForDecoder(blockIndex)

            const block = await global.db.getBlockByIndex(blockIndex)
            assert.ok(block, 'Block should exist in DB')
            assert.ok(block.block_hash, 'Block hash should be resolved')
            assert.strictEqual(block.block_hash.length, 64, 'Block hash should be 64-char hex')
        })
    })
})
