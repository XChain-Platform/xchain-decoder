/**
 * CE-02: RPC Timeout Storm
 *
 * Tests decoder behavior when RPC calls experience high latency
 * or intermittent timeouts, validating retry logic consistency
 * across different connector methods.
 */
const assert = require('assert')
const sinon = require('sinon')
const BlockchainConnector = require('../../src/BlockchainConnector')
const { wait } = require('./helpers')

describe('CE-02: RPC Timeout Storm', function () {
    let connector

    beforeEach(function () {
        connector = new BlockchainConnector('localhost', 8332, 'rpc', 'rpc')
    })

    it('getRawTransaction should retry up to 10 times on timeout', async function () {
        let callCount = 0
        const origPost = require('axios').post
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            throw { code: 'ECONNABORTED', message: 'timeout' }
        })

        try {
            await connector.getRawTransaction('deadbeef')
            assert.fail('Should have thrown')
        } catch (err) {
            assert.ok(err.message.includes('failed after 10 attempts'), `Got: ${err.message}`)
            assert.strictEqual(callCount, 10)
        } finally {
            stub.restore()
        }
    })

    it('getRawTransaction should back off 5s on HTTP 429 (queue depth exceeded)', async function () {
        let callCount = 0
        const startTime = Date.now()
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            if (callCount <= 2) {
                const err = new Error('Too Many Requests')
                err.response = { status: 429, data: { error: { code: -429 } } }
                throw err
            }
            return { data: { result: 'aabbcc' } }
        })

        try {
            const result = await connector.getRawTransaction('deadbeef')
            assert.strictEqual(result, 'aabbcc')
            const elapsed = Date.now() - startTime
            // 2 retries x 5s backoff = at least ~10s, but allow some tolerance
            assert.ok(elapsed >= 8000, `Expected at least 8s for 429 backoff, got ${elapsed}ms`)
        } finally {
            stub.restore()
        }
    })

    it('getBlockHeader should retry up to 10 times on ECONNABORTED', async function () {
        let callCount = 0
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            const err = new Error('timeout')
            err.code = 'ECONNABORTED'
            throw err
        })

        try {
            await connector.getBlockHeader('abc123')
            assert.fail('Should have thrown')
        } catch (err) {
            assert.ok(err.message.includes('problems getting a block hex'))
            assert.strictEqual(callCount, 10)
        } finally {
            stub.restore()
        }
    })

    it('getBlockHeader should NOT retry on non-timeout errors', async function () {
        let callCount = 0
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            throw new Error('Connection refused')
        })

        try {
            await connector.getBlockHeader('abc123')
            assert.fail('Should have thrown')
        } catch (err) {
            // Should fail after 1 attempt (no retry for non-timeout)
            assert.strictEqual(callCount, 1)
        } finally {
            stub.restore()
        }
    })

    it('getBlockHash should propagate errors without retry', async function () {
        let callCount = 0
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            throw new Error('ECONNREFUSED')
        })

        try {
            await connector.getBlockHash(100)
            assert.fail('Should have thrown')
        } catch (err) {
            assert.strictEqual(callCount, 1, 'getBlockHash should not retry')
        } finally {
            stub.restore()
        }
    })

    it('getRawTransactions should fail entire batch if one tx fails', async function () {
        let callCount = 0
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            throw { code: 'ECONNABORTED', message: 'timeout' }
        })

        try {
            await connector.getRawTransactions(['tx1', 'tx2', 'tx3'])
            assert.fail('Should have thrown')
        } catch (err) {
            // All 3 txs x 10 retries each = 30 calls
            assert.ok(callCount >= 30, `Expected at least 30 calls, got ${callCount}`)
        } finally {
            stub.restore()
        }
    })

    it('getBlockchainInfo should propagate errors without retry', async function () {
        let callCount = 0
        const stub = sinon.stub(require('axios'), 'post').callsFake(async () => {
            callCount++
            throw new Error('ECONNREFUSED')
        })

        try {
            await connector.getBlockchainInfo()
            assert.fail('Should have thrown')
        } catch (err) {
            assert.strictEqual(callCount, 1, 'getBlockchainInfo should not retry')
        } finally {
            stub.restore()
        }
    })
})
