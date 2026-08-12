/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E tests: Category C - Multi-Block Processing.
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

    describe('sequential block processing', () => {

        it('C1.1: should process 10 sequential blocks with distinct ACTIONs', async () => {
            const txHashes = []
            const blockIndices = []

            for (let i = 0; i < 10; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|SEQ${i}|${(i + 1) * 100}|${global.mainTestAddress}|seq ${i}`
                const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
                txHashes.push(txHash)
                blockIndices.push(blockIndex)
            }

            await txBuilder.waitForDecoder(blockIndices[blockIndices.length - 1])

            for (let i = 0; i < 10; i++) {
                const tx = await txBuilder.waitForTransaction(txHashes[i])
                assert.ok(tx.data.startsWith(`SEND|0|SEQ${i}|`), `Transaction ${i} data mismatch`)
            }

            // Each broadcastOpReturn mines its own block, so indices should be strictly increasing
            for (let i = 1; i < blockIndices.length; i++) {
                assert.ok(
                    blockIndices[i] > blockIndices[i - 1],
                    `Block indices should be increasing: ${blockIndices[i]} > ${blockIndices[i - 1]}`
                )
            }
        })

        it('C1.2: blocks table should have no gaps across sequential blocks', async () => {
            const startBlock = await global.db.getLastBlockIndex()

            const heights = []
            for (let i = 0; i < 5; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|GAP${i}|1|${global.mainTestAddress}|`
                const { blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
                heights.push(blockIndex)
            }

            await txBuilder.waitForDecoder(heights[heights.length - 1])

            for (const h of heights) {
                await assertBlockExists(global.db, h)
            }

            for (let h = startBlock + 1; h <= heights[heights.length - 1]; h++) {
                const block = await global.db.getBlockByIndex(h)
                assert.ok(block, `Block ${h} should exist (no gaps)`)
                assert.strictEqual(block.block_hash.length, 64, 'Block hash should be 64-char hex')
            }
        })

        it('C1.3: getDecoderBlockData returns correct data per block', async () => {
            const funded1 = await txBuilder.createFundedLegacyAddress()
            const action1 = 'SEND|0|BLK1|100|' + global.mainTestAddress + '|'
            const { txHash: hash1, blockIndex: bi1 } = await txBuilder.broadcastOpReturn(funded1, action1)
            await txBuilder.waitForDecoder(bi1)

            const funded2 = await txBuilder.createFundedLegacyAddress()
            const action2 = 'SEND|0|BLK2|200|' + global.mainTestAddress + '|'
            const { txHash: hash2, blockIndex: bi2 } = await txBuilder.broadcastOpReturn(funded2, action2)
            await txBuilder.waitForDecoder(bi2)

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

    describe('bulk catch-up processing', () => {

        it('C2.1: decoder should catch up after being stopped and restarted', async () => {
            const preStopBlock = await global.db.getLastBlockIndex()

            await txBuilder.stopDecoder()

            // Mine XCHN transactions while the decoder is down, so catch-up has real work to do
            const txHashes = []
            for (let i = 0; i < 5; i++) {
                const funded = await txBuilder.createFundedLegacyAddress()
                const action = `SEND|0|CATCHUP${i}|${i + 1}|${global.mainTestAddress}|`
                const { txHash } = await txBuilder.broadcastOpReturn(funded, action)
                txHashes.push(txHash)
            }

            await txBuilder.mineBlocks(3)

            const info = await global.nodeClientTest.getBlockchainInfo()
            const chainTip = info.blocks

            const midBlock = await global.db.getLastBlockIndex()
            assert.ok(midBlock <= preStopBlock + 5, 'Decoder should not have advanced while stopped')

            await txBuilder.startDecoder()
            await txBuilder.waitForDecoder(chainTip, 60000)

            for (let i = 0; i < txHashes.length; i++) {
                const tx = await global.db.getTransaction(txHashes[i])
                assert.ok(tx, `Catch-up tx ${i} (${txHashes[i]}) should be in DB`)
                assert.ok(tx.data.startsWith(`SEND|0|CATCHUP${i}|`))
            }

            const lastBlock = await global.db.getLastBlockIndex()
            assert.strictEqual(lastBlock, chainTip, 'Decoder should have caught up to chain tip')
        })
    })

    describe('mempool processing', () => {

        it('C3.1: should detect XCHN transaction in mempool', async () => {
            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MEMPOOL|99|' + global.mainTestAddress + '|unconfirmed'
            const { txHash } = await txBuilder.broadcastOpReturnNoMine(funded, action)

            // waitForMempoolTransaction allows 90s so it comfortably covers the
            // decoder's 60s mempool polling interval
            const mempoolTx = await txBuilder.waitForMempoolTransaction(txHash)
            assert.ok(mempoolTx, 'Transaction should appear in mempool_transactions')

            // The mempool row must store the raw tx hash verbatim, not a lookup id.
            assert.strictEqual(mempoolTx.tx_hash, txHash,
                'mempool_transactions should store the raw tx hash')

            // Regression guard: observing a tx in the mempool must NOT allocate a row in
            // the replicated index_transactions lookup table. Lookup ids are node-local
            // and non-deterministic if assigned in mempool-arrival order; they may only be
            // allocated during deterministic block-confirmation processing, so two nodes
            // following the same chain always agree on their ids. Until this tx is mined,
            // its hash must be absent from index_transactions.
            const conn = await global.db.pool.getConnection()
            try {
                const rows = await conn.query(
                    'SELECT id FROM index_transactions WHERE hash = ?', [txHash])
                assert.strictEqual(rows.length, 0,
                    'Unconfirmed mempool tx must not pre-allocate an index_transactions id')
            } finally {
                await conn.release()
            }
        })

        it('C3.2: mempool tx should be confirmed after mining', async () => {
            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|MEMCONF|50|' + global.mainTestAddress + '|confirm me'
            const { txHash } = await txBuilder.broadcastOpReturnNoMine(funded, action)

            await txBuilder.waitForMempoolTransaction(txHash)

            await global.nodeClientTest.generateToAddress(1, global.mainTestAddress)
            const info = await global.nodeClientTest.getBlockchainInfo()
            await txBuilder.waitForDecoder(info.blocks)

            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)
        })
    })

    describe('chain reorganization', () => {

        it('C4.1: should detect and handle a chain reorg', async () => {
            const initialReorgEvents = await getReorgEvents(global.db)
            const initialReorgCount = initialReorgEvents.length

            const funded = await txBuilder.createFundedLegacyAddress()
            const action = 'SEND|0|REORG|100|' + global.mainTestAddress + '|will be orphaned'
            const { txHash, blockIndex } = await txBuilder.broadcastOpReturn(funded, action)
            await txBuilder.waitForDecoder(blockIndex)
            const tx = await txBuilder.waitForTransaction(txHash)
            assert.strictEqual(tx.data, action)

            const blockHash = await txBuilder.getBlockHash(blockIndex)
            await txBuilder.invalidateBlock(blockHash)

            // At least 2 replacement blocks are needed for the decoder to detect the hash mismatch
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

            const lastBlock = await global.db.getLastBlockIndex()
            assert.ok(lastBlock >= info.blocks, 'Decoder should be at or past the new chain tip')
        })

        it('C4.2: blocks table should be consistent after reorg', async () => {
            // Depends on the reorg triggered by the previous test; spot-checks that
            // the blocks table has no gaps in its wake.
            const lastBlock = await global.db.getLastBlockIndex()
            const info = await global.nodeClientTest.getBlockchainInfo()

            for (let h = Math.max(lastBlock - 3, 1); h <= lastBlock; h++) {
                const block = await global.db.getBlockByIndex(h)
                assert.ok(block, `Block ${h} should exist after reorg`)
                assert.strictEqual(block.block_hash.length, 64, `Block ${h} hash should be 64-char hex`)
            }
        })
    })
})
