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
const { waitUntil } = require('../helpers/waitUntil')

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
        // Drop the retry backoff without naming a duration. setImmediate still
        // yields the macrotask the poll loops need, so nothing in this suite is
        // timed against a fixed sleep a loaded CI machine can overrun.
        decoder.sleep = () => new Promise(r => setImmediate(r))
    })

    afterEach(function () {
        decoder.stop()
    })

    it('stop() should set stopFlag and break the main loop', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        // Stop once the main loop is actually running (it has polled the node at
        // least once) rather than after a fixed wall-clock delay.
        waitUntil(() => mockConnector.getBlockchainInfo.called, { timeout: 5000 })
            .then(() => decoder.stop())
            .catch(() => {})

        await captureConsole(async () => {
            await decoder.start()
        })

        assert.strictEqual(decoder.stopFlag, true)
    })

    it('stop() should clear mempool interval when synced', async function () {
        mockConnector.getBlockchainInfo.resolves({ blocks: 0, verificationprogress: 1.0 })
        mockDb.getLastBlockIndex.resolves(0)

        // Stop once the mempool interval has actually been created (the signal the
        // test is really waiting for) rather than after a fixed wall-clock delay.
        waitUntil(() => decoder.mempoolInterval != null, { timeout: 5000 })
            .then(() => decoder.stop())
            .catch(() => {})

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

        // Stop once the decoder has actually caught up to the chain tip rather
        // than after a fixed wall-clock delay.
        waitUntil(() => decoder.isSynced(), { timeout: 5000 })
            .then(() => decoder.stop())
            .catch(() => {})

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

        // Stop on the signal the assertions are about (the heartbeat has been stamped)
        // rather than after a fixed 200ms: a loaded machine could spend that window
        // before the first iteration and stop a loop that never ran. Stopping on the
        // timeout branch too keeps a stuck loop a failed assertion, not a hung suite.
        const stopWhenAlive = waitUntil(() => decoder.lastPollAt > 0, { interval: 5, timeout: 5000 })
            .then(() => decoder.stop(), () => decoder.stop())

        await captureConsole(async () => {
            await decoder.start()
        })
        await stopWhenAlive

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
