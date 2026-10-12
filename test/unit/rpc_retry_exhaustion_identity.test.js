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
 * A retry ladder that gives up builds a fresh error, which must still carry the
 * last cause's error.code and rpcCode/rpcMessage: getBlockReassembled copies
 * those to tell an unreachable node from a block whose bytes are unusable.
 */

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const axios  = require('axios')
const BlockchainConnector = require('../../src/chain/blockchain_connector')
let connector
let axiosStub

function setUpConnector() {
    connector = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
    connector.sleep = async () => {} // no real backoff delays
    axiosStub = sinon.stub(axios, 'post')
}

function restoreStubs() {
    sinon.restore()
}

describe('BlockchainConnector retry exhaustion keeps the cause identity', () => {
    beforeEach(setUpConnector)
    afterEach(restoreStubs)

    it('getRawTransaction exhaustion carries the transport code of the last attempt', async () => {
        axiosStub.callsFake(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })

        const err = await connector.getRawTransaction('txid').then(() => null, (e) => e)
        assert.ok(err, 'all 10 attempts failing must reject')
        assert.match(err.message, /failed after 10 attempts/)
        assert.strictEqual(err.code, 'ECONNRESET')
        assert.strictEqual(err.rpcCode, undefined)
    }).timeout(5000)

    it('getRawTransaction exhaustion carries the node rpcCode from an HTTP-500 body', async () => {
        axiosStub.callsFake(async () => {
            throw Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -8, message: 'Block height out of range' } } },
            })
        })

        const err = await connector.getRawTransaction('txid').then(() => null, (e) => e)
        assert.match(err.message, /failed after 10 attempts/)
        assert.strictEqual(err.code, 'ERR_BAD_RESPONSE')
        assert.strictEqual(err.rpcCode, -8)
        assert.strictEqual(err.rpcMessage, 'Block height out of range')
    }).timeout(5000)

    it('getRawTransaction exhaustion carries the rpcCode of an HTTP-200 JSON-RPC error', async () => {
        axiosStub.resolves({ status: 200, data: { result: null, error: { code: -429, message: 'Work queue depth exceeded' } } })

        const err = await connector.getRawTransaction('txid').then(() => null, (e) => e)
        assert.match(err.message, /failed after 10 attempts/)
        assert.strictEqual(err.rpcCode, -429)
    }).timeout(5000)

    it('rpcCallWithTimeoutRetry exhaustion carries ECONNABORTED and keeps its message', async () => {
        axiosStub.callsFake(async () => { throw Object.assign(new Error('timeout of 0ms exceeded'), { code: 'ECONNABORTED' }) })

        const err = await connector.getBlockHash(1).then(() => null, (e) => e)
        assert.ok(err, 'ten timeouts must reject')
        assert.match(err.message, /There were problems getting block hash\./)
        assert.strictEqual(err.code, 'ECONNABORTED')
        assert.strictEqual(connector.rpcErrors, 1)
    }).timeout(5000)
})
