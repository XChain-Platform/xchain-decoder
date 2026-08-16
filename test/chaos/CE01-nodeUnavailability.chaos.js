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
 * CE-01: Node Unavailability and Recovery
 *
 * Tests that the decoder's polling loop handles complete coin node
 * unavailability gracefully and recovers when the node comes back.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, captureConsole } = require('./helpers')

describe('CE-01: Node Unavailability and Recovery', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
        // Drop the retry backoff without naming a duration. setImmediate still
        // yields the macrotask the poll loops need, so nothing in this suite is
        // timed against a fixed sleep a loaded CI machine can overrun.
        decoder.sleep = () => new Promise(r => setImmediate(r))
    })

    afterEach(function () {
        decoder.stop()
    })

    it('should retry getBlockchainInfo on connection failure and recover', async function () {
        let callCount = 0
        mockConnector.getBlockchainInfo = sinon.stub().callsFake(async () => {
            callCount++
            if (callCount <= 3) {
                throw new Error('ECONNREFUSED')
            }
            // After 3 failures, succeed but immediately stop
            decoder.stop()
            return { blocks: 0, verificationprogress: 1.0 }
        })
        mockDb.getLastBlockIndex.resolves(0)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(callCount >= 4, `Expected at least 4 calls, got ${callCount}`)
        const retryLogs = logs.filter(l => l.includes('Error trying to get network info'))
        assert.ok(retryLogs.length >= 1, 'Should log retry messages')
    })

    it('should not crash or leak resources during extended node outage', async function () {
        let callCount = 0
        const maxCalls = 10

        mockConnector.getBlockchainInfo = sinon.stub().callsFake(async () => {
            callCount++
            if (callCount >= maxCalls) {
                decoder.stop()
                return { blocks: 0, verificationprogress: 1.0 }
            }
            throw new Error('ECONNREFUSED')
        })
        mockDb.getLastBlockIndex.resolves(0)

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(callCount, maxCalls, `Decoder should have retried ${maxCalls} times`)
    })

    it('should handle getBlockHash failure and retry in main parsing loop', async function () {
        let blockHashCalls = 0

        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })
        mockConnector.getBlockHash = sinon.stub().callsFake(async () => {
            blockHashCalls++
            if (blockHashCalls <= 2) {
                throw new Error('Node timeout')
            }
            // On 3rd call, succeed. getBlock will also throw, loop restarts, stop check triggers.
            decoder.stop()
            return 'abc123'
        })
        // getBlock throws so the loop continues back to the stop check
        mockConnector.getBlock = sinon.stub().rejects(new Error('Also unavailable'))
        mockDb.getLastBlockIndex.resolves(-1)

        const { errors } = await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(blockHashCalls >= 3, 'Should have retried getBlockHash')
        // The block-fetch retry now reports on console.error as
        // "Error fetching block at height N (attempt X):" and carries a per-height
        // attempt counter; the old console.log "Error trying to get next block"
        // string no longer exists anywhere in the decoder.
        const retryLogs = errors.filter(l => l.includes('Error fetching block at height'))
        assert.ok(retryLogs.length >= 1, 'Should log block fetch retry messages')
        assert.ok(retryLogs.some(l => l.includes('(attempt 1)')),
            'The first failure at a height should be reported as attempt 1')
        assert.ok(retryLogs.some(l => l.includes('(attempt 2)')),
            'Consecutive failures at the same height should increment the attempt counter')
    })

    it('should handle getBlock failure after getBlockHash succeeds', async function () {
        let getBlockCalls = 0

        mockConnector.getBlockchainInfo.resolves({ blocks: 5, verificationprogress: 1.0 })
        mockConnector.getBlockHash.resolves('abc123')
        mockConnector.getBlock = sinon.stub().callsFake(async () => {
            getBlockCalls++
            if (getBlockCalls <= 2) {
                throw new Error('Block data unavailable')
            }
            decoder.stop()
            throw new Error('stop') // Stop before trying to parse
        })
        mockDb.getLastBlockIndex.resolves(-1)

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(getBlockCalls >= 3, 'Should have retried getBlock')
    })

    it('should wait when node verification progress is below threshold', async function () {
        let callCount = 0
        mockConnector.getBlockchainInfo = sinon.stub().callsFake(async () => {
            callCount++
            if (callCount <= 3) {
                return { blocks: 100, verificationprogress: 0.5 }
            }
            decoder.stop()
            return { blocks: 0, verificationprogress: 1.0 }
        })
        mockDb.getLastBlockIndex.resolves(0)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        const syncLogs = logs.filter(l => l.includes('not synced'))
        assert.ok(syncLogs.length >= 1, 'Should log that node is not synced')
    })
})
