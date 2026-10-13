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
 * Integration test: getRawTransaction passes only whole hex through
 * wholeHexResult and retries past malformed rpcPost answers.
 *
 * rpcPost is stubbed, so no node is needed. The same scenarios also run
 * against a copy of the module whose wholeHexResult guard is removed and must
 * FAIL there, so this file cannot pass when the guard behavior is absent.
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const MODULE_PATH = path.resolve(__dirname, '../../src/chain/blockchain_connector/transaction_queries.js')
const real = require(MODULE_PATH)

/* eslint-disable no-underscore-dangle -- Module internals are needed to compile a mutated copy */
// Load a mutated copy of the module (relative requires resolve as for the original).
function loadWithoutGuard() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8')
    const mutated = source.replace(
        /function wholeHexResult\(result, txid\) \{[\s\S]*?\n\}\n/,
        'function wholeHexResult(result) { return result }\n'
    )
    assert.notStrictEqual(mutated, source, 'mutation must change wholeHexResult')
    const mod = new Module(MODULE_PATH, module)
    mod.filename = MODULE_PATH
    mod.paths = Module._nodeModulePaths(path.dirname(MODULE_PATH))
    mod._compile(mutated, MODULE_PATH)
    return mod.exports
}
/* eslint-enable no-underscore-dangle */

// Script rpcPost answers in order (the last repeats) and record the run.
async function drive(queries, answers) {
    let calls = 0
    const sleeps = []
    const connector = {
        rpcErrors: 0,
        sleep: async (ms) => { sleeps.push(ms) },
        rpcPost: async () => ({ status: 200, data: { result: answers[Math.min(calls++, answers.length - 1)] } }),
    }
    try {
        const value = await queries.getRawTransaction.call(connector, 'guard-txid')
        return { value, calls, sleeps, rpcErrors: connector.rpcErrors }
    } catch (error) {
        return { error, calls, sleeps, rpcErrors: connector.rpcErrors }
    }
}

const MALFORMED = [
    ['an object', { hex: '00' }],
    ['a number', 42],
    ['an odd-length hex string', 'abc'],
    ['a non-hex string', '<html>busy</html>'],
]

// Each scenario asserts the guarded behavior; returns normally only when it holds.
const scenarios = {
    async 'passes whole hex through unchanged on the first rpcPost call'(queries) {
        const got = await drive(queries, ['0100abCD'])
        assert.strictEqual(got.value, '0100abCD')
        assert.strictEqual(got.calls, 1)
        assert.deepStrictEqual(got.sleeps, [])
    },
    async 'retries past every malformed rpcPost answer to the whole hex that follows'(queries) {
        for (const [name, bad] of MALFORMED) {
            const got = await drive(queries, [bad, bad, '00ff'])
            assert.strictEqual(got.value, '00ff', `${name} must not reach the caller`)
            assert.strictEqual(got.calls, 3, `${name} must be retried`)
            assert.deepStrictEqual(got.sleeps, [500, 500])
            assert.strictEqual(got.rpcErrors, 0)
        }
    },
    async 'rejects naming the txid when rpcPost never answers whole hex'(queries) {
        const got = await drive(queries, [{ hex: '00' }])
        assert.ok(got.error, 'must reject, not resolve a malformed answer')
        assert.strictEqual(got.calls, 10)
        assert.strictEqual(got.rpcErrors, 1)
        assert.ok(/guard-txid/.test(got.error.message), got.error.message)
        assert.ok(/malformed/.test(got.error.message), got.error.message)
    },
}

describe('getRawTransaction wholeHexResult guard (stubbed rpcPost)', function () {
    for (const [name, fn] of Object.entries(scenarios)) {
        it(name, async function () {
            await fn(real)
        })
    }

    it('keeps an empty rpcPost result on the tolerant null path', async function () {
        const got = await drive(real, [null])
        assert.strictEqual(got.value, null)
        assert.strictEqual(got.calls, 1)
    })

    describe('non-vacuity: the scenarios fail when wholeHexResult is removed', function () {
        const unguarded = loadWithoutGuard()
        for (const [name, fn] of Object.entries(scenarios)) {
            if (name.startsWith('passes whole hex')) continue // true with or without the guard
            it(`detects the missing guard: ${name}`, async function () {
                await assert.rejects(() => fn(unguarded), assert.AssertionError)
            })
        }
    })
})
