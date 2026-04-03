/**
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
})
