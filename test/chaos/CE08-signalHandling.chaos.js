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
        decoder.sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 50)))
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
})
