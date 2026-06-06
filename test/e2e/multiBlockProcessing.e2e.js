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
 * E2E tests: Category C — Multi-Block Processing.
 *
 * Validates sequential block processing, bulk catch-up after decoder restart,
 * mempool processing, and chain reorganization detection/recovery.
 */

const assert = require('assert')
const txBuilder = require('./helpers/txBuilder')
const {
    assertTransaction,
    assertNoTransaction,
    assertBlockExists,
    assertBlockNotExists,
    assertReorgEvent,
    getReorgEvents,
    getDecoderBlockData,
    assertMempoolTransaction,
    getMempoolTransaction
} = require('./helpers/assertions')

describe('E2E: Multi-Block Processing', function () {
    this.timeout(0)

    // ---------------------------------------------------------------
    // C1: Sequential block processing
    // ---------------------------------------------------------------
    describe('sequential block processing', () => {

        it('C1.1 — should process 10 sequential blocks with distinct ACTIONs', async () => {
            const txHashes = []
            const blockIndices = []

            for (let i = 0; i < 10; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|SEQ${i}|${(i + 1) * 100}|${global.mainTestAddress}|seq ${i}`
                const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
                txHashes.push(txHash)
                blockIndices.push(blockIndex)
            }

            // Wait for decoder to process the last block
            await txBuilder.waitForDecoder(blockIndices[blockIndices.length - 1])

            // Verify all 10 transactions exist with correct data
            for (let i = 0; i < 10; i++) {
                const tx = await txBuilder.waitForTransaction(txHashes[i])
                assert.ok(tx.data.startsWith(`SEND|0|SEQ${i}|`), `Transaction ${i} data mismatch`)
            }

            // Verify block indices are sequential (each broadcastOpReturn mines one block)
            for (let i = 1; i < blockIndices.length; i++) {
                assert.ok(
                    blockIndices[i] > blockIndices[i - 1],
                    `Block indices should be increasing: ${blockIndices[i]} > ${blockIndices[i - 1]}`
                )
            }
        })

        it('C1.2 — blocks table should have no gaps across sequential blocks', async () => {
            const startBlock = await global.db.getLastBlockIndex()

            // Mine 5 blocks with transactions
            const heights = []
            for (let i = 0; i < 5; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|GAP${i}|1|${global.mainTestAddress}|`
                const { blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
                heights.push(blockIndex)
            }

            await txBuilder.waitForDecoder(heights[heights.length - 1])

            // Verify each block exists in the blocks table
            for (const h of heights) {
                await assertBlockExists(global.db, h)
            }

            // Verify no gaps between startBlock and the last height
            for (let h = startBlock + 1; h <= heights[heights.length - 1]; h++) {
                const block = await global.db.getBlockByIndex(h)
                assert.ok(block, `Block ${h} should exist (no gaps)`)
                assert.strictEqual(block.block_hash.length, 64, 'Block hash should be 64-char hex')
            }
        })

        it('C1.3 — getDecoderBlockData returns correct data per block', async () => {
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const action1 = 'SEND|0|BLK1|100|' + global.mainTestAddress + '|'
            const { txHash: hash1, blockIndex: bi1 } = await txBuilder.broadcastOpReturn(funded1, action1)
            await txBuilder.waitForDecoder(bi1)

            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action2 = 'SEND|0|BLK2|200|' + global.mainTestAddress + '|'
            const { txHash: hash2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action2)
            await txBuilder.waitForDecoder(bi2)

            // Each block should contain only its own transaction
            const rows1 = await getDecoderBlockData(global.db, bi1)
            const found1 = rows1.find(r => r.tx_hash === hash1)
            assert.ok(found1, 'Block 1 should contain tx 1')
            assert.strictEqual(found1.data, action1)
            assert.ok(!rows1.find(r => r.tx_hash === hash2), 'Block 1 should NOT contain tx 2')

            const rows2 = await getDecoderBlockData(global.db, bi2)
            const found2 = rows2.find(r => r.tx_hash === hash2)
            assert.ok(found2, 'Block 2 should contain tx 2')
            assert.strictEqual(found2.data, action2)
        })
    })

    // ---------------------------------------------------------------
    // C2: Bulk catch-up after decoder restart
    // ---------------------------------------------------------------
    describe('bulk catch-up processing', () => {

        it('C2.1 — decoder should catch up after being stopped and restarted', async () => {
            // Record state before stop
            const preStopBlock = await global.db.getLastBlockIndex()

            // Stop the decoder
            await txBuilder.stopDecoder()

            // Mine blocks with XCHN transactions while decoder is down
            const txHashes = []
            for (let i = 0; i < 5; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|CATCHUP${i}|${i + 1}|${global.mainTestAddress}|`
                const { txHash } = await txBuilder.broadcastOpReturn(funded, action)
                txHashes.push(txHash)
            }

            // Also mine some plain (non-XCHN) blocks
            await txBuilder.mineBlocks(3)

            const info = await global.nodeClientTest.getBlockchainInfo()
            const chainTip = info.blocks

            // Decoder should still be at pre-stop position
            const midBlock = await global.db.getLastBlockIndex()
            assert.ok(midBlock <= preStopBlock + 5, 'Decoder should not have advanced while stopped')

            // Restart decoder
            await txBuilder.startDecoder()

            // Wait for catch-up
            await txBuilder.waitForDecoder(chainTip, 60000)

            // Verify all XCHN transactions were decoded
            for (let i = 0; i < txHashes.length; i++) {
                const tx = await global.db.getTransaction(txHashes[i])
                assert.ok(tx, `Catch-up tx ${i} (${txHashes[i]}) should be in DB`)
                assert.ok(tx.data.startsWith(`SEND|0|CATCHUP${i}|`))
            }

            // Verify blocks table is complete up to chain tip
            const lastBlock = await global.db.getLastBlockIndex()
            assert.strictEqual(lastBlock, chainTip, 'Decoder should have caught up to chain tip')
        })
    })

    // ---------------------------------------------------------------
    // C3: Mempool processing
    // ---------------------------------------------------------------
    describe('mempool processing', () => {

        it('C3.1 — should detect XCHN transaction in mempool', async () => {
            // Ensure decoder is synced
            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            // Broadcast without mining
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MEMPOOL|99|' + global.mainTestAddress + '|unconfirmed'
            const { txHash } = await txBuilder.broadcastOpReturnNoMine(funded, action)

            // Wait for the mempool polling interval (60s) to pick it up
            // waitForMempoolTransaction has a 90s timeout
            const mempoolTx = await txBuilder.waitForMempoolTransaction(txHash)
            assert.ok(mempoolTx, 'Transaction should appear in mempool_transactions')
        })

        it('C3.2 — mempool tx should be confirmed after mining', async () => {
            // Broadcast without mining
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MEMCONF|50|' + global.mainTestAddress + '|confirm me'
            const { txHash } = await txBuilder.broadcastOpReturnNoMine(funded, action)

            // Wait for mempool detection
            await txBuilder.waitForMempoolTransaction(txHash)

            // Now mine a block to confirm it
            await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            // Should now be in the confirmed transactions table
            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })

    // ---------------------------------------------------------------
    // C4: Chain reorganization
    // ---------------------------------------------------------------
    describe('chain reorganization', () => {

        it('C4.1 — should detect and handle a chain reorg', async () => {
            // Record initial reorg event count
            const initialReorgEvents = await getReorgEvents(global.db)
            const initialReorgCount = initialReorgEvents.length

            // Create an XCHN transaction in a block
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|REORG|100|' + global.mainTestAddress + '|will be orphaned'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)

            // Get the block hash at this height
            const blockHash = txBuilder.getBlockHash(blockIndex)

            // Invalidate this block (simulates a reorg)
            txBuilder.invalidateBlock(blockHash)

            // Mine replacement blocks on the new chain
            // We need at least 2 blocks so the decoder detects the hash mismatch
            await txBuilder.mineBlocks(2)

            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks, 60000)

            // The decoder should have detected the reorg, rolled back, and re-indexed.
            // The original transaction may or may not still exist depending on whether
            // it was re-included in the new chain. But the reorg event should be recorded.
            const reorgEvents = await getReorgEvents(global.db)
            assert.ok(
                reorgEvents.length > initialReorgCount,
                'A REORG event should have been recorded'
            )

            // Verify the decoder continued processing on the new chain
            const lastBlock = await global.db.getLastBlockIndex()
            assert.ok(lastBlock >= info.blocks, 'Decoder should be at or past the new chain tip')
        })

        it('C4.2 — blocks table should be consistent after reorg', async () => {
            // After the previous reorg test, verify no gaps in blocks table
            const lastBlock = await global.db.getLastBlockIndex()
            const info = await global.nodeClientTest.getBlockchainInfo()

            // Spot-check the last few blocks exist and have valid hashes
            for (let h = Math.max(lastBlock - 3, 1); h <= lastBlock; h++) {
                const block = await global.db.getBlockByIndex(h)
                assert.ok(block, `Block ${h} should exist after reorg`)
                assert.strictEqual(block.block_hash.length, 64, `Block ${h} hash should be 64-char hex`)
            }
        })
    })
})
