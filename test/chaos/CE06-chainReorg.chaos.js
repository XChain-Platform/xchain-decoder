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
        // Since M-12 the REORG marker is written atomically inside deleteBlockByIndex; verifyReorg
        // hands it the (block_index, block_hash) per deleted block instead of writing one event at
        // the end. Assert the delete carried the DB's original hash (never null/undefined), which
        // is the content that lands in the durable per-block marker.
        assert.ok(mockDb.insertEvent.notCalled, 'must NOT write a separate end-of-run REORG event')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(5, 'old_hash_5'), 'Should delete block 5 with its original hash')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(4, 'old_hash_4'), 'Should delete block 4 with its original hash')
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

        const { errors } = await captureConsole(async () => {
            await decoder.verifyReorg()
        })

        assert.ok(hashCallCount >= 2, 'Should have retried getBlockHash')
        // Error, not info: this handler can spin for a whole node outage in the middle of
        // a reorg walk, and it is the only trace that walk leaves while it is stalled.
        const retryLogs = errors.filter(l => l.includes('problem trying to get a block hash'))
        assert.ok(retryLogs.length >= 1, 'Should log retry message at error level')
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
        // Per-block atomic marker (M-12): each deleted block is handed its original hash so the
        // marker written inside deleteBlockByIndex records it. No separate end-of-run event.
        assert.ok(mockDb.insertEvent.notCalled, 'must NOT write a separate end-of-run REORG event')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(2, 'old_hash_2'), 'block 2 deleted with its original hash')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(1, 'old_hash_1'), 'block 1 deleted with its original hash')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(0, 'old_hash_0'), 'block 0 deleted with its original hash')
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

        const { warnings } = await captureConsole(async () => {
            await decoder.start()
        })

        // Warn, not info: see the level rationale on the same assertion in CE-04.
        const reorgLogs = warnings.filter(l => l.includes('reorg has been detected'))
        assert.ok(reorgLogs.length >= 1, 'Should detect reorg in main loop and announce it at warn level')
        assert.ok(decoder.verifyReorg.called, 'Should call verifyReorg')
        assert.ok(mockDb.endTransaction.called, 'Should end transaction before reorg processing')
    })

    it('[REGRESSION P0] verifyReorg deletes blocks above the node tip without an RPC hash query', async function () {
        // F-9(b): the node tip dropped to 5 but the decoder still has 8,7,6 stored.
        // Those are orphans the node no longer has. getBlockHash(8) throws "Block
        // height out of range", and the transient-error catch would retry it forever.
        // verifyReorg(5) must delete 8,7,6 via a deterministic height compare (no RPC,
        // no brittle error-string matching), then hash-compare from the in-range tip.
        let blockIndex = 8
        const dbBlocks = {
            8: { block_hash: 'orphan_8' },
            7: { block_hash: 'orphan_7' },
            6: { block_hash: 'orphan_6' },
            5: { block_hash: 'good_5' }
        }
        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => blockIndex)
        mockDb.getBlockByIndex = sinon.stub().callsFake(async (idx) => dbBlocks[idx])
        mockConnector.getBlockHash = sinon.stub().callsFake(async (idx) => {
            if (idx > 5) throw new Error('Block height out of range')
            return 'good_' + idx
        })
        mockDb.deleteBlockByIndex = sinon.stub().callsFake(async () => { blockIndex--; return true })

        await decoder.verifyReorg(5)

        assert.strictEqual(mockDb.deleteBlockByIndex.callCount, 3, 'Should delete the 3 above-tip orphan blocks')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(8) && mockDb.deleteBlockByIndex.calledWith(7) && mockDb.deleteBlockByIndex.calledWith(6), 'Should delete 8,7,6')
        assert.ok(!mockConnector.getBlockHash.calledWith(8), 'must NOT query the node for an above-tip height')
        assert.ok(!mockConnector.getBlockHash.calledWith(7), 'must NOT query the node for an above-tip height')
        assert.ok(!mockConnector.getBlockHash.calledWith(6), 'must NOT query the node for an above-tip height')
        assert.ok(mockConnector.getBlockHash.calledWith(5), 'should hash-compare the in-range tip block')
        // Per-block atomic marker (M-12): each above-tip delete carries its original hash for the
        // marker written inside deleteBlockByIndex; no separate end-of-run event.
        assert.ok(mockDb.insertEvent.notCalled, 'must NOT write a separate end-of-run REORG event')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(8, 'orphan_8'), 'block 8 deleted with its original hash')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(7, 'orphan_7'), 'block 7 deleted with its original hash')
        assert.ok(mockDb.deleteBlockByIndex.calledWith(6, 'orphan_6'), 'block 6 deleted with its original hash')
    })

    it('[REGRESSION P0] reconciles when the node tip regresses below the decoder height', async function () {
        // F-9(a): node tip is 5 but the decoder has processed up to 10 (a node
        // rollback / deep reorg). The forward hash-compare path never fires: there
        // is no block ABOVE our height to fetch, so without the regression-branch
        // reconcile the decoder loops forever logging the gap while orphan blocks
        // 6..10 survive (which the indexer inherits). The branch must call
        // verifyReorg with the current node tip.
        let calls = 0
        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })
        mockDb.getLastTxIndex.resolves(0)
        mockDb.getLastBlockIndex = sinon.stub().callsFake(async () => {
            calls++
            if (calls === 1) return 10          // pre-loop + first read: regressed height
            decoder.stop()                      // after reconcile: stop the loop
            return 5
        })
        sinon.stub(decoder, 'sleep').resolves()
        const verifyStub = sinon.stub(decoder, 'verifyReorg').resolves(true)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(verifyStub.calledWith(5), 'should reconcile via verifyReorg with the current node tip')
        assert.ok(logs.some(l => l.includes('Reconciling orphan blocks')), 'should log the node-tip regression reconcile')
        assert.ok(mockDb.endTransaction.called, 'should end any open transaction before reconciling')
    })

    it('[REGRESSION P0] tolerates a null previousBlock in the reorg trigger without crashing', async function () {
        // F-1: getBlockByIndex returns null on a caught DB error; the reorg trigger
        // used to deref straight into previousBlock.block_hash (TypeError), escape
        // start(), and permanently stop the parse loop. It must treat null as
        // transient and retry, never throw.
        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('blockhash')
        mockConnector.getBlock.resolves(createMinimalBlockHex())
        mockDb.getLastBlockIndex.resolves(1)
        mockDb.getLastTxIndex.resolves(0)
        sinon.stub(decoder, 'sleep').resolves()

        let gbiCalls = 0
        mockDb.getBlockByIndex = sinon.stub().callsFake(async () => {
            gbiCalls++
            if (gbiCalls >= 2) decoder.stop()   // let it retry once, then stop
            return null                         // simulated transient DB error
        })

        let threw = false
        const { errors } = await captureConsole(async () => {
            try { await decoder.start() } catch (e) { threw = true }
        })

        assert.ok(!threw, 'start() must not throw on a null previousBlock')
        assert.ok(errors.some(l => l.includes('Could not load previous block')), 'should log the transient retry')
    })
})
