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
 * CE-06: Chain Reorganization Under Load
 *
 * Tests the decoder's reorg detection and recovery mechanism,
 * verifying that it correctly identifies fork points, rolls back
 * affected blocks, and re-processes the new chain.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, createMinimalBlockHex, captureConsole } = require('./helpers')

describe('CE-06: Chain Reorganization Detection and Recovery', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
    })

    afterEach(function () {
        decoder.stop()
    })

    it('verifyReorg should detect and roll back mismatched blocks', async function () {
        // Simulate 3 blocks where the last 2 have wrong hashes
        let blockIndex = 5
        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => blockIndex)

        const dbBlocks = {
            5: { block_hash: 'old_hash_5' },
            4: { block_hash: 'old_hash_4' },
            3: { block_hash: 'matching_hash_3' }
        }

        const nodeHashes = {
            5: 'new_hash_5',   // Different from DB
            4: 'new_hash_4',   // Different from DB
            3: 'matching_hash_3' // Same
        }

        mockDb.getBlockByIndex = sinon.stub().callsFake(async (idx) => dbBlocks[idx])
        mockConnector.getBlockHash = sinon.stub().callsFake(async (idx) => nodeHashes[idx])
        mockDb.deleteBlockByIndex = sinon.stub().callsFake(async () => {
            blockIndex--
            return true
        })

        await decoder.verifyReorg()

        assert.strictEqual(mockDb.deleteBlockByIndex.callCount, 2, 'Should delete 2 mismatched blocks')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(5), 'Should delete block 5')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(4), 'Should delete block 4')
        assert.ok(mockDb.insertEvent.calledOnce, 'Should insert REORG event')
        assert.strictEqual(mockDb.insertEvent.firstCall.args[0], 'REORG')

        const deletedBlocks = mockDb.insertEvent.firstCall.args[1]
        assert.strictEqual(deletedBlocks.length, 2, 'REORG event should contain 2 deleted blocks')

        // The audit log must record the actual rolled-back block hash for every
        // entry — never null/undefined. Each entry's block_hash must be a
        // non-empty string carrying the hash that was in the DB.
        for (const entry of deletedBlocks) {
            assert.strictEqual(typeof entry.block_hash, 'string', `block_hash for index ${entry.block_index} must be a string, got ${entry.block_hash}`)
            assert.ok(entry.block_hash.length > 0, `block_hash for index ${entry.block_index} must be non-empty`)
        }
        const hashesByIndex = Object.fromEntries(deletedBlocks.map(b => [b.block_index, b.block_hash]))
        assert.strictEqual(hashesByIndex[5], 'old_hash_5', 'REORG event should record the original hash of block 5')
        assert.strictEqual(hashesByIndex[4], 'old_hash_4', 'REORG event should record the original hash of block 4')
    })

    it('verifyReorg should handle getBlockHash failures during reorg', async function () {
        let hashCallCount = 0
        let blockIndex = 3

        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => blockIndex)
        mockDb.getBlockByIndex.resolves({ block_hash: 'old' })

        mockConnector.getBlockHash = sinon.stub().callsFake(async () => {
            hashCallCount++
            if (hashCallCount === 1) {
                throw new Error('Node temporarily unavailable')
            }
            // On retry, hashes match (no reorg needed)
            return 'old'
        })

        const { logs } = await captureConsole(async () => {
            await decoder.verifyReorg()
        })

        assert.ok(hashCallCount >= 2, 'Should have retried getBlockHash')
        const retryLogs = logs.filter(l => l.includes('problem trying to get a block hash'))
        assert.ok(retryLogs.length >= 1, 'Should log retry message')
    })

    it('verifyReorg should stop cleanly when every processed block is invalidated', async function () {
        // Deep reorg: the decoder has processed blocks 0,1,2 and the node has
        // invalidated all three, so the backward walk exhausts the entire blocks
        // table. Once the last block is deleted, getLastBlockIndex() returns -1
        // (MAX over an empty table) and getBlockByIndex(-1) yields no row. Without
        // the null/min-height guard this dereferenced null and threw an uncaught
        // TypeError, crashing before the REORG event was written.
        let blockIndex = 2

        const dbBlocks = {
            2: { block_hash: 'old_hash_2' },
            1: { block_hash: 'old_hash_1' },
            0: { block_hash: 'old_hash_0' }
            // index -1 intentionally absent → getBlockByIndex(-1) resolves undefined
        }

        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => blockIndex)
        mockDb.getBlockByIndex = sinon.stub().callsFake(async (idx) => dbBlocks[idx])
        // Every queried hash differs from the DB, so the walk never matches and
        // must rely on the exhaustion guard to terminate.
        mockConnector.getBlockHash = sinon.stub().callsFake(async (idx) => 'node_hash_' + idx)
        mockDb.deleteBlockByIndex = sinon.stub().callsFake(async () => {
            blockIndex--
            return true
        })

        let result
        await assert.doesNotReject(async () => {
            result = await decoder.verifyReorg()
        }, 'verifyReorg must not throw when the blocks table is fully emptied')

        assert.strictEqual(result, true, 'verifyReorg should return normally after exhausting the table')
        assert.strictEqual(mockDb.deleteBlockByIndex.callCount, 3, 'Should delete all 3 invalidated blocks')
        assert.strictEqual(blockIndex, -1, 'Walk should retreat to the empty-table sentinel (-1)')
        assert.ok(!mockConnector.getBlockHash.calledWith(-1), 'Guard must short-circuit before querying the node at index -1')
        assert.ok(mockDb.insertEvent.calledOnce, 'Should still record the REORG event for the deleted blocks')
        assert.strictEqual(mockDb.insertEvent.firstCall.args[0], 'REORG')
        assert.strictEqual(mockDb.insertEvent.firstCall.args[1].length, 3, 'REORG event should contain all 3 deleted blocks')
    })

    it('verifyReorg should not insert event when no reorg found', async function () {
        mockDb.getLastBlockIndex.resolves(5)
        mockDb.getBlockByIndex.resolves({ block_hash: 'same_hash' })
        mockConnector.getBlockHash.resolves('same_hash')

        await decoder.verifyReorg()

        assert.ok(!mockDb.insertEvent.called, 'Should not insert REORG event when hashes match')
        assert.ok(!mockDb.deleteBlockByIndex.called, 'Should not delete any blocks')
    })

    it('should trigger reorg detection when previous block hash mismatches in main loop', async function () {
        let loopCount = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })

        // Block 2's prevHash won't match what DB has for block 1
        const blockHex = createMinimalBlockHex()
        mockConnector.getBlockHash.resolves('blockhash')
        mockConnector.getBlock.resolves(blockHex)

        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => {
            loopCount++
            if (loopCount > 3) {
                decoder.stop()
                return -1 // Reset to avoid infinite loop
            }
            return 1
        })
        mockDb.getLastTxIndex.resolves(0)

        // The block from getBlock will have a prevHash from the actual block data,
        // which won't match this mock DB entry
        mockDb.getBlockByIndex = sinon.stub().resolves({ block_hash: 'completely_different_hash' })

        // Stub verifyReorg to just reset state
        sinon.stub(decoder, 'verifyReorg').resolves(true)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        const reorgLogs = logs.filter(l => l.includes('reorg has been detected'))
        assert.ok(reorgLogs.length >= 1, 'Should detect reorg in main loop')
        assert.ok(decoder.verifyReorg.called, 'Should call verifyReorg')
        assert.ok(mockDb.endTransaction.called, 'Should end transaction before reorg processing')
    })
})
