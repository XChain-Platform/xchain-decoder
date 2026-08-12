// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Coin-node RPC failover. A dead RPC endpoint used to stall the decoder
// forever, because the block loop retries RPC failures indefinitely by design.
// These pin the NODE_URL_FALLBACK rotation behavior in BlockchainConnector:
// endpoint-list parsing, failover after NODE_FAILOVER_THRESHOLD consecutive
// connection-level failures, counter reset on success and on HTTP-level errors,
// and round-robin rotation.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const BlockchainConnector = require('../../src/BlockchainConnector')

function connectionError(code) {
    const err = new Error(code)
    err.code = code
    return err
}

describe('BlockchainConnector NODE_URL_FALLBACK failover', () => {
    let axiosStub
    let warnStub

    beforeEach(() => {
        axiosStub = sinon.stub(axios, 'post')
        warnStub = sinon.stub(console, 'warn')
        sinon.stub(console, 'error')
        sinon.stub(console, 'log')
    })

    afterEach(() => {
        sinon.restore()
        delete process.env.NODE_URL_FALLBACK
        delete process.env.NODE_FAILOVER_THRESHOLD
    })

    function makeConnector(fallback, threshold) {
        if (fallback !== undefined) process.env.NODE_URL_FALLBACK = fallback
        if (threshold !== undefined) process.env.NODE_FAILOVER_THRESHOLD = String(threshold)
        return new BlockchainConnector('127.0.0.1', 8332, 'testuser', 'testpass')
    }

    describe('endpoint parsing', () => {
        it('has a single endpoint when NODE_URL_FALLBACK is unset', () => {
            const connector = makeConnector()
            assert.deepStrictEqual(connector.endpoints, ['http://127.0.0.1:8332'])
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('parses comma-separated fallbacks with default port, explicit port, and protocol', () => {
            const connector = makeConnector('10.0.0.2, 10.0.0.3:9332 ,https://node.example.com')
            assert.deepStrictEqual(connector.endpoints, [
                'http://127.0.0.1:8332',
                'http://10.0.0.2:8332',
                'http://10.0.0.3:9332',
                'https://node.example.com:8332',
            ])
        })

        it('ignores an empty NODE_URL_FALLBACK value', () => {
            const connector = makeConnector('')
            assert.strictEqual(connector.endpoints.length, 1)
        })

        it('rejects a malformed fallback entry', () => {
            assert.throws(() => makeConnector('ht!tp://bad url'), /invalid RPC endpoint/)
        })
    })

    describe('failover rotation', () => {
        it('rotates to the fallback after threshold consecutive connection failures', async () => {
            const connector = makeConnector('10.0.0.2', 3)
            axiosStub.rejects(connectionError('ECONNREFUSED'))

            for (let i = 0; i < 3; i++) {
                await assert.rejects(() => connector.getBlockchainInfo())
            }

            assert.strictEqual(connector.url, 'http://10.0.0.2:8332')
            assert.strictEqual(warnStub.callCount, 1)

            // Next request goes to the fallback endpoint.
            axiosStub.resolves({ data: { result: { blocks: 7 } } })
            const result = await connector.getBlockchainInfo()
            assert.deepStrictEqual(result, { blocks: 7 })
            assert.strictEqual(axiosStub.lastCall.args[0], 'http://10.0.0.2:8332')
        })

        it('recovers within a single timeout-retry loop call', async () => {
            // getBlockHash retries ECONNABORTED up to 10x in-method; with a
            // threshold of 2 the connector rotates mid-call and the same call
            // succeeds against the fallback without the caller seeing an error.
            const connector = makeConnector('10.0.0.2', 2)
            axiosStub.onCall(0).rejects(connectionError('ECONNABORTED'))
            axiosStub.onCall(1).rejects(connectionError('ECONNABORTED'))
            axiosStub.onCall(2).resolves({ data: { result: 'deadbeef' } })

            const hash = await connector.getBlockHash(5)
            assert.strictEqual(hash, 'deadbeef')
            assert.strictEqual(axiosStub.getCall(2).args[0], 'http://10.0.0.2:8332')
        })

        it('a success resets the consecutive-failure counter', async () => {
            const connector = makeConnector('10.0.0.2', 3)
            axiosStub.rejects(connectionError('ECONNREFUSED'))
            await assert.rejects(() => connector.getBlockchainInfo())
            await assert.rejects(() => connector.getBlockchainInfo())

            axiosStub.resolves({ data: { result: {} } })
            await connector.getBlockchainInfo()

            axiosStub.rejects(connectionError('ECONNREFUSED'))
            await assert.rejects(() => connector.getBlockchainInfo())
            await assert.rejects(() => connector.getBlockchainInfo())

            // 2 + 2 failures with a success between: never reaches 3 in a row.
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('HTTP-level errors (node reachable) do not count toward failover', async () => {
            const connector = makeConnector('10.0.0.2', 2)
            const httpError = new Error('Request failed with status code 500')
            httpError.response = { status: 500, data: { error: { code: -32603, message: 'oops' } } }
            axiosStub.rejects(httpError)

            for (let i = 0; i < 5; i++) {
                await assert.rejects(() => connector.getBlockchainInfo())
            }
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('rotates round-robin back to the primary when the fallback also dies', async () => {
            const connector = makeConnector('10.0.0.2', 1)
            axiosStub.rejects(connectionError('EHOSTUNREACH'))

            await assert.rejects(() => connector.getBlockchainInfo())
            assert.strictEqual(connector.url, 'http://10.0.0.2:8332')
            await assert.rejects(() => connector.getBlockchainInfo())
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('never rotates when no fallback is configured', async () => {
            const connector = makeConnector(undefined, 1)
            axiosStub.rejects(connectionError('ECONNREFUSED'))
            for (let i = 0; i < 4; i++) {
                await assert.rejects(() => connector.getBlockchainInfo())
            }
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
            assert.strictEqual(warnStub.callCount, 0)
        })
    })
})
