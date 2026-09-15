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
const sinon = require('sinon')
const BlockchainConnector = require('../../../src/chain/blockchain_connector')

// ─── getRawTransactions concurrency bound ───────────────────────────────────
describe('BlockchainConnector#getRawTransactions (bounded concurrency)', () => {
    let connector

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'testuser', 'testpass')
    })

    afterEach(() => {
        delete process.env.DECODER_RPC_CONCURRENCY
        sinon.restore()
    })

    it('bounds in-flight requests to DECODER_RPC_CONCURRENCY and preserves order', async () => {
        process.env.DECODER_RPC_CONCURRENCY = '7'
        let inFlight = 0
        let maxInFlight = 0
        sinon.stub(connector, 'getRawTransaction').callsFake(async (txid) => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((r) => setImmediate(r))
            inFlight--
            return 'raw:' + txid
        })
        const ids = Array.from({ length: 40 }, (_, i) => 'tx' + i)
        const out = await connector.getRawTransactions(ids)
        assert.strictEqual(out.length, 40)
        assert.deepStrictEqual(out, ids.map((t) => 'raw:' + t))
        assert.ok(maxInFlight <= 7, 'expected <=7 in flight, saw ' + maxInFlight)
    })

    it('never exceeds the 50-request default and handles an empty list', async () => {
        let inFlight = 0
        let maxInFlight = 0
        sinon.stub(connector, 'getRawTransaction').callsFake(async (txid) => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((r) => setImmediate(r))
            inFlight--
            return txid
        })
        assert.deepStrictEqual(await connector.getRawTransactions([]), [])
        const out = await connector.getRawTransactions(Array.from({ length: 120 }, (_, i) => 't' + i))
        assert.strictEqual(out.length, 120)
        assert.ok(maxInFlight <= 50, 'expected <=50 in flight, saw ' + maxInFlight)
    })

    it('rejects when any transaction in the batch fails', async () => {
        sinon.stub(connector, 'getRawTransaction').callsFake(async (txid) => {
            if (txid === 'bad') throw new Error('fetch failed for bad')
            return txid
        })
        await assert.rejects(
            () => connector.getRawTransactions(['a', 'bad', 'c']),
            /fetch failed for bad/
        )
    })
})
