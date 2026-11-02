// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression guard: Bitcoin Core 31 answers a full RPC work queue with
// HTTP 503 and a text/plain "Work queue depth exceeded" body. getRawTransaction
// must give that the same 5 s queue-full backoff as a JSON -429 or a dropped
// socket, not the 500 ms fixed-fault retry that hammers an overloaded node.

const assert = require('assert')
const { logger } = require('../../src/chain/blockchain_connector/constants.js')
const queries = require('../../src/chain/blockchain_connector/transaction_queries.js')

// Returns a factory: axios builds a fresh error per request, and
// sanitizeRpcError scrubs error.response in place, so a shared one would lose
// its status after the first attempt.
function failure(response, code) {
    return () => {
        const e = new Error('rpc failed')
        if (response) e.response = JSON.parse(JSON.stringify(response))
        if (code) e.code = code
        return e
    }
}

async function run(makeError) {
    const sleeps = []
    const errors = []
    const origError = logger.error
    logger.error = (...a) => { errors.push(a.join(' ')) }
    const connector = {
        rpcErrors: 0,
        async rpcPost() { throw makeError() },
        async sleep(ms) { sleeps.push(ms) }
    }
    let rejected = null
    try {
        await queries.getRawTransaction.call(connector, '00'.repeat(32))
    } catch (e) {
        rejected = e
    } finally {
        logger.error = origError
    }
    return { sleeps, errors, rejected, connector }
}

describe('getRawTransaction queue-full classification', () => {
    it('backs off 5 s on HTTP 503 "Work queue depth exceeded" and does not log a fixed fault', async () => {
        const r = await run(failure({ status: 503, data: 'Work queue depth exceeded' }))
        assert.strictEqual(r.sleeps.length, 10)
        assert.ok(r.sleeps.every((ms) => ms === 5000), `sleeps: ${r.sleeps}`)
        assert.strictEqual(r.errors.filter((m) => /attempt \d+\/\d+/.test(m)).length, 0)
        assert.ok(r.rejected, 'still rejects after the retries run out')
        assert.strictEqual(r.connector.rpcErrors, 1)
    })

    it('still backs off 5 s on a JSON -429 error', async () => {
        const r = await run(failure({ status: 500, data: { error: { code: -429, message: 'Work queue depth exceeded' } } }))
        assert.ok(r.sleeps.every((ms) => ms === 5000))
        assert.ok(r.rejected)
    })

    it('still backs off 5 s on ECONNRESET', async () => {
        const r = await run(failure(null, 'ECONNRESET'))
        assert.ok(r.sleeps.every((ms) => ms === 5000))
        assert.ok(r.rejected)
    })

    it('keeps a 401 on the 500 ms fixed-fault path with a per-attempt log', async () => {
        const r = await run(failure({ status: 401, data: 'Unauthorized' }))
        assert.strictEqual(r.sleeps.length, 10)
        assert.ok(r.sleeps.every((ms) => ms === 500))
        assert.strictEqual(r.errors.filter((m) => /attempt \d+\/10/.test(m)).length, 10)
        assert.ok(r.rejected)
    })
})
