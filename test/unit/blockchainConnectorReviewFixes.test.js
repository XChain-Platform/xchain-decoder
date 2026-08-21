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
 * Regression coverage for BlockchainConnector error accounting and reporting:
 *   - getRawTransaction must not inflate rpcErrors when the fetch succeeds
 *     (or resolves null) on the final attempt (the counter-vs-settled guard).
 *   - getRawTransaction must fail loud on deterministic non-timeout errors:
 *     carry the sanitized cause into the final rejection message.
 *   - sanitizeRpcError must surface the node's JSON-RPC {code,message} that
 *     arrives on the HTTP-500 error body, not just the bare status line.
 */

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const axios  = require('axios')
const BlockchainConnector = require('../../src/BlockchainConnector')

describe('BlockchainConnector RPC error accounting and reporting', () => {
    let connector
    let axiosStub

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
        connector.sleep = async () => {} // no real backoff delays
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('#getRawTransaction() final-attempt accounting', () => {
        it('does NOT increment rpcErrors when the fetch succeeds on the 10th attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            for (let i = 0; i < 9; i++) axiosStub.onCall(i).rejects(timeoutErr)
            axiosStub.onCall(9).resolves({ data: { result: 'txhex' } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, 'txhex')
            assert.strictEqual(axiosStub.callCount, 10)
            assert.strictEqual(connector.rpcErrors, 0,
                'a recovered fetch on the last attempt must not report an RPC error')
        }).timeout(5000)

        it('does NOT increment rpcErrors when the tx resolves null on the 10th attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            for (let i = 0; i < 9; i++) axiosStub.onCall(i).rejects(timeoutErr)
            axiosStub.onCall(9).resolves({ data: { result: null } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, null)
            assert.strictEqual(connector.rpcErrors, 0)
        }).timeout(5000)

        it('DOES increment rpcErrors exactly once when all 10 attempts fail', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(() => connector.getRawTransaction('txid'))
            assert.strictEqual(connector.rpcErrors, 1)
        }).timeout(5000)
    })

    describe('#getRawTransaction() fail-loud on deterministic errors', () => {
        it('carries the node cause into the final rejection instead of a bare message', async () => {
            // Core delivers most RPC errors as HTTP 500 + JSON body. A code that is
            // neither -5 (eviction) nor -429 (queue full) is a deterministic fault.
            // Each attempt throws a fresh error object, as axios does in production
            // (sanitizeRpcError scrubs error.response in place, so a shared object
            // would only carry the JSON body on the first read).
            const makeDetErr = () => Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -8, message: 'Block height out of range' } } }
            })
            axiosStub.callsFake(async () => { throw makeDetErr() })

            await assert.rejects(
                () => connector.getRawTransaction('txid'),
                (err) => {
                    assert.ok(/failed after 10 attempts/.test(err.message), 'keeps the attempt-count context')
                    assert.ok(/RPC error -8/.test(err.message), 'surfaces the node RPC code -8')
                    assert.ok(/Block height out of range/.test(err.message), 'surfaces the node message')
                    return true
                }
            )
            assert.strictEqual(connector.rpcErrors, 1)
        }).timeout(5000)
    })

    describe('block-path methods surface the HTTP-500 JSON-RPC error code', () => {
        it('getBlockHash rethrows an error carrying the node rpcCode/rpcMessage', async () => {
            const rpcErr = Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -8, message: 'Block height out of range' } } }
            })
            axiosStub.rejects(rpcErr)

            await assert.rejects(
                () => connector.getBlockHash(999999999),
                (err) => {
                    assert.strictEqual(err.rpcCode, -8, 'node RPC code is attached to the rethrown error')
                    assert.strictEqual(err.rpcMessage, 'Block height out of range')
                    return true
                }
            )
        }).timeout(5000)
    })

    describe('the shared result extractor reads PRESENCE, not truthiness', () => {
        // JSON-RPC 2.0: a success carries a `result` member, which may legitimately
        // be 0, false or "". Only undefined/null mean the node sent no result. No
        // method routed through the extractor today can answer falsy, so these pin
        // the contract for the next one rather than a behaviour change.
        it('returns a falsy-but-present result instead of throwing', async () => {
            axiosStub.resolves({ data: { result: '' } })
            assert.strictEqual(await connector.getBlockHash(0), '')

            axiosStub.resolves({ data: { result: 0 } })
            assert.strictEqual(await connector.getBlockHash(0), 0)

            axiosStub.resolves({ data: { result: false } })
            assert.strictEqual(await connector.getBlockHash(0), false)

            assert.strictEqual(connector.rpcErrors, 0, 'a valid falsy result is not an RPC failure')
        }).timeout(5000)

        it('still throws the per-method label when the result is absent', async () => {
            axiosStub.resolves({ data: { result: null } })
            await assert.rejects(() => connector.getBlockHash(0), /Error getting block hash/)

            axiosStub.resolves({ data: {} })
            await assert.rejects(() => connector.getBlockHash(0), /Error getting block hash/)
        }).timeout(5000)

        it('still prefers the node error object over the result member', async () => {
            axiosStub.resolves({ data: { result: 0, error: { code: -8, message: 'Block height out of range' } } })
            await assert.rejects(() => connector.getBlockHash(0), /RPC error -8: Block height out of range/)
        }).timeout(5000)
    })
})
