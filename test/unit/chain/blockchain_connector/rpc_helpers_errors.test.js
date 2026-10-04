// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const {
    rpcResult,
    sanitizeRpcError,
} = require('../../../../src/chain/blockchain_connector/rpc_helpers')

function assertThrowsLabel(response, label) {
    assert.throws(
        () => rpcResult(response, label),
        (error) => error.message === label
    )
}

describe('RPC helper errors', () => {
    describe('rpcResult', () => {
        it('returns positive and zero results', () => {
            assert.strictEqual(rpcResult({ data: { result: 5 } }, 'read'), 5)
            assert.strictEqual(rpcResult({ data: { result: 0 } }, 'read'), 0)
        })

        it('throws the RPC code and message', () => {
            const response = { data: { error: { code: -5, message: 'bad' } } }
            assert.throws(
                () => rpcResult(response, 'read'),
                { message: 'read: RPC error -5: bad' }
            )
        })

        it('serializes an RPC error without a string message', () => {
            const response = { data: { error: { code: 1 } } }
            assert.throws(
                () => rpcResult(response, 'read'),
                { message: 'read: RPC error 1: {"code":1}' }
            )
        })

        it('throws only the label for missing results', () => {
            assertThrowsLabel(null, 'missing')
            assertThrowsLabel({ data: {} }, 'missing')
            assertThrowsLabel({ data: { result: null } }, 'missing')
        })
    })

    describe('sanitizeRpcError', () => {
        it('scrubs transport details and preserves RPC details', () => {
            const error = Object.assign(new Error('boom'), {
                config: {
                    auth: { username: 'user', password: 'secret' },
                    headers: { Authorization: 'Basic secret', Other: 'kept' },
                },
                request: { socket: 'request' },
                response: {
                    status: 500,
                    data: { error: { code: -28, message: 'warming' } },
                },
            })

            assert.strictEqual(sanitizeRpcError(error), 'boom (RPC error -28: warming)')
            assert.strictEqual(error.config.auth, undefined)
            assert.deepStrictEqual(error.config.headers, { Other: 'kept' })
            assert.strictEqual(error.request, undefined)
            assert.deepStrictEqual(error.response, { status: 500 })
            assert.strictEqual(error.rpcCode, -28)
            assert.strictEqual(error.rpcMessage, 'warming')
            assert.strictEqual(error.propertyIsEnumerable('rpcCode'), false)
            assert.strictEqual(error.propertyIsEnumerable('rpcMessage'), false)
        })

        it('renders errors and non-error values without responses', () => {
            assert.strictEqual(sanitizeRpcError(new Error('plain')), 'plain')
            assert.strictEqual(sanitizeRpcError('text'), 'text')
            assert.strictEqual(sanitizeRpcError(null), 'null')
        })
    })
})
