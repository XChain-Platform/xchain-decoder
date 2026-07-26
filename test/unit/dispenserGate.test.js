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
const XChainDecoder = require('../../src/XChainDecoder')

// A v0 DISPENSER open is only valid for this chain when BOTH coin fields name the
// local native coin. These tests pin the producer gate to the indexer's four
// format==0 coin checks (xchain-indexer/src/actions/dispenser.js): GIVE_COIN and
// GET_COIN must each be a supported COIN and equal the local COIN. The decoder
// previously admitted an open whenever EITHER field was merely non-empty, so it
// opened dispensers the indexer rejects and then misclassified later native-coin
// payments to that address as failed dispenses.
function makeDecoder(network) {
    return new XChainDecoder(
        network, null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
}

describe('dispenser-open gate — coin parity with the indexer', () => {
    it('derives the local coin ticker from the network key', () => {
        assert.strictEqual(makeDecoder('bitcoin-regtest').coinTick, 'BTC')
        assert.strictEqual(makeDecoder('dogecoin-mainnet').coinTick, 'DOGE')
        assert.strictEqual(makeDecoder('litecoin-testnet').coinTick, 'LTC')
    })

    it('[REGRESSION P1] R-DSP-002 opens only when BOTH coin fields equal the local coin', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(btc.dispenserOpensForThisChain('BTC', 'BTC'), true)
    })

    it('[REGRESSION P1] R-DSP-002 rejects GIVE_COIN set with GET_COIN empty', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(btc.dispenserOpensForThisChain('BTC', ''), false)
    })

    it('[REGRESSION P1] R-DSP-002 rejects GET_COIN set with GIVE_COIN empty', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(btc.dispenserOpensForThisChain('', 'BTC'), false)
    })

    it('[REGRESSION P1] R-DSP-002 rejects a foreign network in either coin field', () => {
        const doge = makeDecoder('dogecoin-mainnet')
        // A DOGE-configured decoder must not open on a BTC dispenser.
        assert.strictEqual(doge.dispenserOpensForThisChain('BTC', 'BTC'), false)
        // Mixed/cross-chain shapes are rejected too (indexer requires both == COIN).
        assert.strictEqual(doge.dispenserOpensForThisChain('DOGE', 'BTC'), false)
        assert.strictEqual(doge.dispenserOpensForThisChain('BTC', 'DOGE'), false)
    })

    it('[REGRESSION P1] R-DSP-002 rejects both-empty (the pre-fix OR gate also rejected this)', () => {
        const ltc = makeDecoder('litecoin-testnet')
        assert.strictEqual(ltc.dispenserOpensForThisChain('', ''), false)
    })
})

// A v0 create may stop at GET_AMOUNT: everything after it is optional, and a
// composer that omits the tail rather than padding it emits a 10-token string.
// The old >= 14 length gate dropped those creates, so the decoder never held an
// open row for a dispenser the indexer had opened with escrow locked, and every
// buyer payment to it was classified as an ordinary transfer: coin to the
// seller, no tokens back. Reproduced live on BTC regtest before this fix.
describe('dispenser-open gate - optional-tail creates', () => {
    const CREATE_NO_TAIL = 'DISPENSER|0|BTC|XCHAIN|500||2000|BTC||0.01'.split('|')
    const CREATE_WITH_EXPIRATION =
        'DISPENSER|0|BTC|XCHAIN|100||500|BTC||0.005|||||1798747200'.split('|')
    const CREATE_FULL =
        'DISPENSER|0|BTC|XCHAIN|10||1000|BTC||0.0001|||||1787714697|||stocked'.split('|')

    it('[REGRESSION P1] accepts a create that ends at GET_AMOUNT', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(CREATE_NO_TAIL.length, 10)
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(CREATE_NO_TAIL), true)
    })

    it('accepts creates that carry part or all of the optional tail', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(CREATE_WITH_EXPIRATION), true)
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(CREATE_FULL), true)
    })

    it('still rejects a create truncated before GET_AMOUNT', () => {
        const btc = makeDecoder('bitcoin-regtest')
        const truncated = 'DISPENSER|0|BTC|XCHAIN|500||2000|BTC|'.split('|')
        assert.strictEqual(truncated.length, 9)
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(truncated), false)
    })

    it('rejects a non-array payload rather than throwing', () => {
        const btc = makeDecoder('bitcoin-regtest')
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(null), false)
        assert.strictEqual(btc.hasRequiredDispenserCreateFields(undefined), false)
    })
})
