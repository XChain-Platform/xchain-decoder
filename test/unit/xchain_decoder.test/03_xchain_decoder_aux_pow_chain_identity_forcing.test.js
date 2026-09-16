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
const XChainDecoder = require('../../../src/XChainDecoder')

// ─── DOGE auxPow forcing ────────────────────────────────────────────────────
describe('XChainDecoder auxPow chain-identity forcing', () => {
    function makeDecoder(network, auxPow) {
        return new XChainDecoder(
            network, 'h', 3306, 'db', 'u', 'p',
            '127.0.0.1', 18443, 'rpc', 'rpc', auxPow, null
        )
    }

    it('forces auxPow=true for a dogecoin network even when AUX_POW is unset (false)', () => {
        assert.strictEqual(makeDecoder('dogecoin-regtest', false).auxPow, true)
        assert.strictEqual(makeDecoder('dogecoin-mainnet', false).auxPow, true)
    })

    // A non-auxpow chain must NEVER reach getBlockWithoutAuxPow. BTC/LTC
    // blocks carry no AuxPoW section, so stripping one whose version signals bit
    // 0x100 truncates a valid block. The passed flag is inert in both directions.
    it('forces auxPow=false for non-DOGE chains even when AUX_POW is set (true)', () => {
        assert.strictEqual(makeDecoder('bitcoin-regtest', false).auxPow, false)
        assert.strictEqual(makeDecoder('litecoin-regtest', false).auxPow, false)
        assert.strictEqual(makeDecoder('bitcoin-regtest', true).auxPow, false)
        assert.strictEqual(makeDecoder('litecoin-regtest', true).auxPow, false)
    })
})
