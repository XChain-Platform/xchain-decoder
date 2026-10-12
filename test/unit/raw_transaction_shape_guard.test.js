/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * getRawTransaction answers with a whole hex string or fails. The prevout and
 * envelope callers rely on that: they decode the answer outside their tagged
 * try, so a decode throw is content every instance sees alike and goes to the
 * quarantine ladder. A truthy non-hex answer from a proxy or shim passed as
 * content would quarantine a tx on one instance that healthy instances accept,
 * so it must be a transport fault that rides the retry loop.
 */

'use strict'

const assert = require('assert')
const queries = require('../../src/chain/blockchain_connector/transaction_queries.js')

// Script the node's answers in order (the last one repeats) and record the run.
async function drive(results) {
    let calls = 0
    const sleeps = []
    const connector = {
        rpcErrors: 0,
        sleep: async (ms) => { sleeps.push(ms) },
        rpcPost: async () => ({ status: 200, data: { result: results[Math.min(calls++, results.length - 1)] } }),
    }
    try {
        const value = await queries.getRawTransaction.call(connector, 'txid-under-test')
        return { value, calls, sleeps, rpcErrors: connector.rpcErrors }
    } catch (err) {
        return { error: err, calls, sleeps, rpcErrors: connector.rpcErrors }
    }
}

describe('getRawTransaction accepts only a hex string', function () {
    it('passes a hex answer through unchanged', async function () {
        const got = await drive(['0100abCD'])
        assert.strictEqual(got.value, '0100abCD')
        assert.strictEqual(got.calls, 1)
    })

    for (const [name, bad] of [
        ['an object', { hex: '00' }],
        ['a number', 42],
        ['an odd-length hex string', 'abc'],
        ['a non-hex string', '<html>busy</html>'],
    ]) {
        it(`retries ${name} and counts no RPC error when the next answer is whole`, async function () {
            const got = await drive([bad, '00ff'])
            assert.strictEqual(got.value, '00ff', `${name} must not be handed to the decoder`)
            assert.deepStrictEqual(got.sleeps, [500])
            assert.strictEqual(got.rpcErrors, 0, 'a fetch that recovers counts zero')
        })
    }

    it('rejects after the retry budget, counting one RPC error and naming the txid', async function () {
        const got = await drive([{ hex: '00' }])
        assert.ok(got.error, 'a node that never answers hex must fail, not resolve')
        assert.strictEqual(got.calls, 10)
        assert.strictEqual(got.rpcErrors, 1)
        assert.ok(/txid-under-test/.test(got.error.message))
        assert.ok(/malformed/.test(got.error.message), got.error.message)
    })

    it('still resolves null on an empty answer', async function () {
        const got = await drive([null])
        assert.strictEqual(got.value, null)
        assert.strictEqual(got.calls, 1)
    })
})
