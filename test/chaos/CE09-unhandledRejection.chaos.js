/**
 * CE-09: Unhandled Promise Rejection
 *
 * Tests that decoder.start() failures are caught by the .catch()
 * handler in api.js and that the health endpoint reports the
 * decoder's actual state (not just "success" when decoder is dead).
 */
const assert = require('assert')
const sinon = require('sinon')
const XChainDecoder = require('../../src/XChainDecoder')
const { createMockDatabase, captureConsole } = require('./helpers')

describe('CE-09: Unhandled Promise Rejection', function () {
    it('decoder.start() should throw when database creation fails', async function () {
        const decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        const mockDb = createMockDatabase({
            createDatabase: sinon.stub().resolves(true),
            verifyDatabase: sinon.stub().resolves(false)
        })
        decoder.db = mockDb

        let threw = false
        try {
            await captureConsole(async () => {
                await decoder.start()
            })
        } catch (err) {
            threw = true
            assert.ok(err.message.includes("doesn't exist"), `Expected DB error, got: ${err.message}`)
        }
        assert.ok(threw, 'decoder.start() should throw when DB verification fails')
    })

    it('decoder.start() should throw when table verification fails', async function () {
        const decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        const mockDb = createMockDatabase({
            createDatabase: sinon.stub().resolves(true),
            verifyDatabase: sinon.stub().resolves(true),
            verifyTables: sinon.stub().resolves(false)
        })
        decoder.db = mockDb

        let threw = false
        try {
            await captureConsole(async () => {
                await decoder.start()
            })
        } catch (err) {
            threw = true
            assert.ok(err.message.includes("tables don't exist"), `Expected table error, got: ${err.message}`)
        }
        assert.ok(threw, 'decoder.start() should throw when table verification fails')
    })

    it('api.js catch handler should track decoder crash state', async function () {
        // Simulate what api.js does: start decoder with .catch()
        const decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')
        const mockDb = createMockDatabase({
            createDatabase: sinon.stub().resolves(true),
            verifyDatabase: sinon.stub().resolves(false)
        })
        decoder.db = mockDb

        let decoderRunning = true
        let decoderError = null

        // This mimics the api.js pattern
        await decoder.start().catch((err) => {
            decoderRunning = false
            decoderError = err
        })

        assert.strictEqual(decoderRunning, false, 'decoderRunning should be false after crash')
        assert.ok(decoderError !== null, 'decoderError should be set')
        assert.ok(decoderError.message.includes("doesn't exist"), `Expected DB error, got: ${decoderError.message}`)

        // Health endpoint simulation
        const health = {
            status: decoderRunning ? 'healthy' : 'unhealthy',
            synced: decoder.isSynced(),
            error: decoderError ? decoderError.message : null
        }

        assert.strictEqual(health.status, 'unhealthy')
        assert.strictEqual(health.synced, false)
        assert.ok(health.error.includes("doesn't exist"))
    })

    it('health endpoint should report healthy when decoder is running', function () {
        const decoder = new XChainDecoder('bitcoin-regtest', 'localhost', 3306, 'test_db', 'root', '', 'localhost', 8332, 'rpc', 'rpc')

        // Simulate healthy state
        const decoderRunning = true
        const decoderError = null
        decoder.synced = true

        const health = {
            status: decoderRunning ? 'healthy' : 'unhealthy',
            synced: decoder.isSynced(),
            error: decoderError ? decoderError.message : null
        }

        assert.strictEqual(health.status, 'healthy')
        assert.strictEqual(health.synced, true)
        assert.strictEqual(health.error, null)
    })
})
