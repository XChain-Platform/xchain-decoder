// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression tests for the 2026-07-08 xchain-decoder stress-sweep fixes.
// See claude/reports/2026-07-08_xchain-decoder-stress-sweep.md.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')
const { makeRpcBatchGuard } = require('../../src/api')

// A known-valid Litecoin tx (1 input, OP_RETURN + P2PKH outputs) reused from
// XChainBlockDecoder.test.js. Output index 1 is a P2PKH paying a resolvable address.
const CANONICAL_TX_HEX = '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'

// The same tx with the LTC MWEB marker (0x00) + flag (0x08) injected after the
// 4-byte version, exactly as a HogEx/MWEB-carrying LTC tx serializes on the wire.
const MWEB_FLAGGED_TX_HEX = '02000000' + '0008' + CANONICAL_TX_HEX.substr(8)

function newDecoder(network){
    return new XChainDecoder(network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
}

describe('xchain-decoder stress-sweep fixes @regression', function () {
    this.timeout(0)

    describe('F1: prevout/funding parse routes through transactionFromHex (LTC MWEB wedge)', function () {
        it('the crafted MWEB-flagged hex is one that vanilla strict fromHex rejects', function () {
            // Guards the test itself: if this ever stops throwing, the fix below is moot.
            assert.throws(() => bitcoin.Transaction.fromHex(MWEB_FLAGGED_TX_HEX))
        })

        it('getSourceFromOutput resolves an MWEB-flagged LTC prevout instead of wedging', async function () {
            const decoder = newDecoder('litecoin-regtest')
            let fetched = 0
            decoder.connector = { rpcErrors: 0, getRawTransaction: async () => { fetched++; return MWEB_FLAGGED_TX_HEX } }

            // Before the fix this threw a deterministic UInt64 range error tagged
            // rpcLookupFailure=true, which the block loop retries FOREVER (permanent
            // fleet-wide LTC wedge). After the fix the MWEB flag is stripped and the
            // P2PKH output at index 1 resolves to a real address.
            const source = await decoder.getSourceFromOutput('deadbeef'.repeat(8), 1)
            assert.strictEqual(fetched, 1)
            assert.ok(source, 'expected a resolved source address, got ' + source)
        })

        it('a normal (unflagged) prevout still resolves unchanged', async function () {
            const decoder = newDecoder('litecoin-regtest')
            decoder.connector = { rpcErrors: 0, getRawTransaction: async () => CANONICAL_TX_HEX }
            const source = await decoder.getSourceFromOutput('deadbeef'.repeat(8), 1)
            assert.ok(source, 'unflagged prevout must still resolve')
        })
    })

    describe('F6: zero-input tx is skipped cleanly instead of throwing', function () {
        it('parseTransaction returns null for a tx with no inputs', async function () {
            const decoder = newDecoder('litecoin-regtest')
            assert.strictEqual(await decoder.parseTransaction({ ins: [] }), null)
        })

        it('parseTransaction returns null when ins is absent', async function () {
            const decoder = newDecoder('litecoin-regtest')
            assert.strictEqual(await decoder.parseTransaction({}), null)
        })
    })

    describe('F4: JSON-RPC batch-size guard', function () {
        function fakeRes(){
            return { _code: null, _json: null, status(c){ this._code = c; return this }, json(o){ this._json = o; return this } }
        }

        it('rejects an over-cap batch array with 400 and does not call next', function () {
            const guard = makeRpcBatchGuard(20)
            const res = fakeRes()
            let nextCalled = false
            guard({ body: new Array(21).fill({ method: 'health' }) }, res, () => { nextCalled = true })
            assert.strictEqual(res._code, 400)
            assert.strictEqual(nextCalled, false)
            assert.ok(res._json && res._json.error, 'expected a JSON-RPC error body')
        })

        it('passes a batch at exactly the cap', function () {
            const guard = makeRpcBatchGuard(20)
            let nextCalled = false
            guard({ body: new Array(20).fill({ method: 'health' }) }, fakeRes(), () => { nextCalled = true })
            assert.strictEqual(nextCalled, true)
        })

        it('passes a single (non-array) request', function () {
            const guard = makeRpcBatchGuard(20)
            let nextCalled = false
            guard({ body: { method: 'health' } }, fakeRes(), () => { nextCalled = true })
            assert.strictEqual(nextCalled, true)
        })
    })
})
