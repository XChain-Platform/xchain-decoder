// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Extra BlockchainConnector tests targeting uncovered lines:
//   - getBlockchainInfo: ECONNABORTED retry + exhaustion (lines 107-116)
//   - getNetworkInfo: ECONNABORTED retry + exhaustion (lines 65-77)
//   - getRawMempool: ECONNABORTED retry + exhaustion (lines 250-261)
//   - getBlock: ECONNABORTED retry + exhaustion (lines 362-372)
//   - constructor: URL already contains protocol prefix

const assert = require('assert')
const sinon  = require('sinon')
const axios  = require('axios')
const BlockchainConnector = require('../../src/BlockchainConnector')

describe('BlockchainConnector (extra coverage)', () => {
    let connector
    let axiosStub

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(() => {
        sinon.restore()
    })

    // ─── constructor: already-prefixed URL ──────────────────────────────────

    describe('constructor', () => {
        it('should not double-prefix an http:// URL', () => {
            const c = new BlockchainConnector('http://mynode.local', 8332, 'u', 'p')
            assert.strictEqual(c.url, 'http://mynode.local:8332')
        })

        it('should not double-prefix an https:// URL', () => {
            const c = new BlockchainConnector('https://mynode.local', 8332, 'u', 'p')
            assert.strictEqual(c.url, 'https://mynode.local:8332')
        })

        it('should prepend http:// when URL has no protocol', () => {
            const c = new BlockchainConnector('127.0.0.1', 8332, 'u', 'p')
            assert.strictEqual(c.url, 'http://127.0.0.1:8332')
        })
    })

    // ─── getBlockchainInfo: timeout retry and exhaustion ───────────────────

    describe('#getBlockchainInfo() ECONNABORTED handling', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })

            axiosStub.onCall(0).rejects(timeoutErr)
            axiosStub.onCall(1).rejects(timeoutErr)
            axiosStub.onCall(2).resolves({ data: { result: { blocks: 42, verificationprogress: 1.0 } } })

            const result = await connector.getBlockchainInfo()
            assert.strictEqual(result.blocks, 42)
            assert.strictEqual(axiosStub.callCount, 3)
        })

        it('should throw after all 10 timeout retries are exhausted', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(
                () => connector.getBlockchainInfo(),
                { message: /problems getting blockchain info/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })

        it('should propagate a non-timeout error immediately', async () => {
            const authErr = Object.assign(new Error('auth fail'), { code: 'ERR_BAD_REQUEST' })
            axiosStub.rejects(authErr)

            await assert.rejects(
                () => connector.getBlockchainInfo(),
                { message: 'auth fail' }
            )
            assert.strictEqual(axiosStub.callCount, 1)
        })
    })

    // ─── getNetworkInfo: timeout retry and exhaustion ───────────────────────

    describe('#getNetworkInfo() ECONNABORTED handling', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })

            axiosStub.onCall(0).rejects(timeoutErr)
            axiosStub.onCall(1).resolves({ data: { result: { version: 210000 } } })

            const result = await connector.getNetworkInfo()
            assert.strictEqual(result.version, 210000)
            assert.strictEqual(axiosStub.callCount, 2)
        })

        it('should throw after all 10 timeout retries are exhausted', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(
                () => connector.getNetworkInfo(),
                { message: /problems getting network info/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })

        it('should propagate a non-timeout error immediately', async () => {
            const netErr = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
            axiosStub.rejects(netErr)

            await assert.rejects(
                () => connector.getNetworkInfo(),
                { message: 'ECONNREFUSED' }
            )
            assert.strictEqual(axiosStub.callCount, 1)
        })
    })

    // ─── getRawMempool: timeout retry and exhaustion ────────────────────────

    describe('#getRawMempool() ECONNABORTED handling', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })

            axiosStub.onCall(0).rejects(timeoutErr)
            axiosStub.onCall(1).resolves({ data: { result: ['txid1', 'txid2'] } })

            const result = await connector.getRawMempool()
            assert.deepStrictEqual(result, ['txid1', 'txid2'])
            assert.strictEqual(axiosStub.callCount, 2)
        })

        it('should throw after all 10 ECONNABORTED retries are exhausted', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(
                () => connector.getRawMempool(),
                { message: /problems getting raw mempool/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })

        it('should throw immediately on non-timeout errors', async () => {
            const authErr = Object.assign(new Error('unauthorized'), { code: 'ERR_BAD_REQUEST' })
            axiosStub.rejects(authErr)

            await assert.rejects(
                () => connector.getRawMempool(),
                { message: 'unauthorized' }
            )
            assert.strictEqual(axiosStub.callCount, 1)
        })
    })

    // ─── getBlock: timeout retry and exhaustion ─────────────────────────────

    describe('#getBlock() ECONNABORTED handling', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })

            axiosStub.onCall(0).rejects(timeoutErr)
            axiosStub.onCall(1).resolves({ data: { result: 'blockhex' } })

            const result = await connector.getBlock('somehash')
            assert.strictEqual(result, 'blockhex')
            assert.strictEqual(axiosStub.callCount, 2)
        })

        it('should throw after all 10 ECONNABORTED retries are exhausted', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(
                () => connector.getBlock('somehash'),
                { message: /problems getting block/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })

        it('should throw immediately on non-timeout errors', async () => {
            const netErr = Object.assign(new Error('net error'), { code: 'ECONNRESET' })
            axiosStub.rejects(netErr)

            await assert.rejects(
                () => connector.getBlock('somehash'),
                { message: 'net error' }
            )
            assert.strictEqual(axiosStub.callCount, 1)
        })

        it('should pass hexFormat=false as verbose=true to the RPC', async () => {
            axiosStub.resolves({ data: { result: 'jsonblock' } })
            await connector.getBlock('hash', false)  // hexFormat=false → verbose=true

            const callData = axiosStub.firstCall.args[1]
            assert.deepStrictEqual(callData.params, ['hash', true])
        })
    })

    // ─── getBlockHash: timeout retry and exhaustion ─────────────────────────

    describe('#getBlockHash() ECONNABORTED handling', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })

            axiosStub.onCall(0).rejects(timeoutErr)
            axiosStub.onCall(1).resolves({ data: { result: 'somehash' } })

            const result = await connector.getBlockHash(100)
            assert.strictEqual(result, 'somehash')
            assert.strictEqual(axiosStub.callCount, 2)
        })

        it('should throw after all 10 ECONNABORTED retries are exhausted', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(
                () => connector.getBlockHash(100),
                { message: /problems getting block hash/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })
    })

    // ─── getBlockHeader: no-result branch ──────────────────────────────────

    describe('#getBlockHeader() no-result branch', () => {
        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })
            await assert.rejects(
                () => connector.getBlockHeader('somehash'),
                { message: 'Error getting block hex' }
            )
        })
    })

    // ─── getRawTransaction: ECONNABORTED branch ─────────────────────────────

    describe('#getRawTransaction() ECONNABORTED branch', () => {
        it('should retry on ECONNABORTED and succeed on a later attempt', async () => {
            const abortErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.onCall(0).rejects(abortErr)
            axiosStub.onCall(1).resolves({ data: { result: 'txhex' } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, 'txhex')
            assert.strictEqual(axiosStub.callCount, 2)
        }).timeout(5000)
    })

    // ─── getRawTransaction: ECONNRESET backoff ─────────────────────────────

    describe('#getRawTransaction() ECONNRESET backoff', () => {
        it('should back off longer on ECONNRESET (Dogecoin queue-full signal)', async () => {
            const resetErr = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
            axiosStub.onCall(0).rejects(resetErr)
            axiosStub.onCall(1).resolves({ data: { result: 'txhex' } })

            const start = Date.now()
            const result = await connector.getRawTransaction('txid')
            const elapsed = Date.now() - start

            assert.strictEqual(result, 'txhex')
            // ECONNRESET backoff is 5000ms
            assert.ok(elapsed >= 4000, `Expected >= 4000ms, got ${elapsed}ms`)
        }).timeout(10000)
    })
})
