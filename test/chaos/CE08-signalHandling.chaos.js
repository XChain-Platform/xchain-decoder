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
 * CE-08: SIGTERM / SIGINT Signal Handling
 *
 * Tests that the decoder's stop mechanism works correctly when
 * triggered, including proper cleanup of mempool intervals.
 * Validates the signal handler fix applied in api.js.
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, createMockConnector, captureConsole } = require('./helpers')

describe('CE-08: Signal Handling and Graceful Shutdown', function () {
    let decoder
    let mockDb
    let mockConnector

    beforeEach(function () {
        decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        mockDb = createMockDatabase()
        mockConnector = createMockConnector()
        decoder.db = mockDb
        decoder.connector = mockConnector
        decoder.sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 50)))
    })

    afterEach(function () {
        decoder.stop()
    })

    it('stop() should set stopFlag and break the main loop', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        setTimeout(() => decoder.stop(), 100)

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(decoder.stopFlag, true)
    })

    it('stop() should clear mempool interval when synced', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        // Let it run long enough to start mempool interval
        setTimeout(() => {
            decoder.stop()
        }, 500)

        const { logs } = await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(decoder.mempoolInterval, null, 'Mempool interval should be cleared on stop')
    })

    it('isSynced() should return false initially', function () {
        assert.strictEqual(decoder.isSynced(), false)
    })

    it('isSynced() should return true when caught up to chain tip', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        setTimeout(() => decoder.stop(), 300)

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(decoder.isSynced(), true)
    })

    it('api.js should register signal handlers and health endpoint', function () {
        const fs = require('fs')
        const apiSource = fs.readFileSync(require.resolve('../../src/api.js'), 'utf-8')

        assert.ok(apiSource.includes("process.on('SIGTERM'"), 'Should register SIGTERM handler')
        assert.ok(apiSource.includes("process.on('SIGINT'"), 'Should register SIGINT handler')
        assert.ok(apiSource.includes("process.on('unhandledRejection'"), 'Should register unhandledRejection handler')
        assert.ok(apiSource.includes('async health()'), 'Should have health endpoint')
        assert.ok(apiSource.includes('decoderRunning'), 'Health should report decoder running state')
        assert.ok(apiSource.includes('.catch('), 'decoder.start() should have .catch() handler')
    })

    // The loop must WRITE the heartbeat, not merely have a field for it. A unit test
    // over isPollSilent() alone would pass against a lastPollAt nothing ever sets,
    // which is the exact shape of the bug: a liveness field that never updates.
    it('the parse loop writes the lastPollAt heartbeat on every iteration', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        assert.strictEqual(decoder.lastPollAt, 0, 'heartbeat starts unset before the loop runs')

        setTimeout(() => decoder.stop(), 200)
        await captureConsole(async () => {
            await decoder.start()
        })

        assert.ok(decoder.lastPollAt > 0, 'the loop must stamp lastPollAt')
        assert.strictEqual(decoder.isPollSilent(), false, 'a loop that just ran is not silent')
    })

    // start() resolves only when the loop breaks, so the SIGTERM path must report
    // not-running immediately rather than waiting out the poll-silence window.
    it('api.js flips decoderRunning false when the loop exits and on shutdown', function () {
        const fs = require('fs')
        const apiSource = fs.readFileSync(require.resolve('../../src/api.js'), 'utf-8')

        assert.ok(/decoder\.start\(\)\s*\.then\(/.test(apiSource),
            'decoder.start() should have a .then() that observes a clean loop exit')
        const shutdownBody = apiSource.slice(apiSource.indexOf('const shutdown = () =>'),
                                             apiSource.indexOf("process.on('SIGTERM'"))
        assert.ok(shutdownBody.includes('decoderRunning = false'),
            'shutdown() should mark the decoder not-running before stopping it')
        // Whether /live actually turns 503 on a silent heartbeat is pinned
        // behaviourally against the shipped route in
        // test/unit/decoderLiveHeartbeat.test.js. A grep for `isPollSilent` here would
        // pass just as happily on a handler that read the field and ignored it.
    })
})
