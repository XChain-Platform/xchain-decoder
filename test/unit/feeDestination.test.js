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
const { resolveFeeDestination } = require('../../src/feeDestination')
const { getCoinConfig } = require('../../src/coins')

// Unit test for the constructor's fee-destination normalization (the gate the storage path uses
// to decide whether to persist a fee-destination output to transaction_outputs). No DB / node
// connection is exercised. Only the constructor's handling of the feeDestination argument is tested.
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const REAL_ADDR   = 'mfeeDestinationRegtestAddr1111111111'

function build(feeDestination){
    return new XChainDecoder('bitcoin-regtest', 'h', 3306, 'db', 'u', 'p', 'n', 1, 'nu', 'np', false, feeDestination)
}

describe('XChainDecoder fee destination @unit', () => {
    it('keeps a real fee destination address', () => {
        assert.strictEqual(build(REAL_ADDR).feeDestination, REAL_ADDR)
    })

    it('treats the unset placeholder as null (capture disabled)', () => {
        assert.strictEqual(build(PLACEHOLDER).feeDestination, null)
    })

    it('treats a missing fee destination as null', () => {
        assert.strictEqual(build(undefined).feeDestination, null)
        assert.strictEqual(build(null).feeDestination, null)
        assert.strictEqual(build('').feeDestination, null)
    })
})

// The api.js entry point resolves FEE_DESTINATION through resolveFeeDestination: the vendored
// coin registry supplies the consensus-pinned default (so a stock install captures fee outputs
// without env), an env override wins on regtest ONLY, and mainnet AND testnet always use the pin
// (testnet is an armed multi-operator federation, so honoring the override there forks the ledger
// exactly as it would on mainnet - same rule as the registry's regtest-only per-coin override).
describe('resolveFeeDestination @unit', () => {
    it('defaults to the registry pin for every coin and network when no env override is set', () => {
        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                const tick = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }[coin]
                const pinned = getCoinConfig(tick, network).addresses.FEE_DESTINATION
                assert.strictEqual(resolveFeeDestination(coin + '-' + network, null), pinned,
                    coin + '-' + network + ' should default to the registry pin')
                assert.ok(pinned && pinned !== PLACEHOLDER, coin + '-' + network + ' registry pin must be a real address')
            }
        }
    })

    it('honors an env override on regtest ONLY', () => {
        assert.strictEqual(resolveFeeDestination('litecoin-regtest', REAL_ADDR), REAL_ADDR)
    })

    it('ignores an env override on mainnet AND testnet and returns the pin (armed-federation fork guard)', () => {
        const btcMain = getCoinConfig('BTC', 'mainnet').addresses.FEE_DESTINATION
        assert.strictEqual(resolveFeeDestination('bitcoin-mainnet', REAL_ADDR), btcMain)
        // Regression: testnet used to honor the override (m[2] === 'mainnet' gate), forking the
        // armed testnet federation against nodes with no env. It must now use the pin like mainnet.
        for (const [coin, tick] of [['dogecoin', 'DOGE'], ['litecoin', 'LTC'], ['bitcoin', 'BTC']]) {
            const pinned = getCoinConfig(tick, 'testnet').addresses.FEE_DESTINATION
            assert.strictEqual(resolveFeeDestination(coin + '-testnet', REAL_ADDR), pinned,
                coin + '-testnet must ignore the env override and use the pin')
        }
    })

    it('falls back to env-only when the network is unrecognized', () => {
        assert.strictEqual(resolveFeeDestination('fakecoin-regtest', REAL_ADDR), REAL_ADDR)
        assert.strictEqual(resolveFeeDestination('not-a-network-string', null), null)
        assert.strictEqual(resolveFeeDestination(undefined, null), null)
    })
})
