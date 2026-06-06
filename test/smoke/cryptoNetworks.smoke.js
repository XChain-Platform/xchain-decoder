// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const CryptoNetworks = require('../../src/CryptoNetworks')

const ALL_NETWORKS = [
    'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
    'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest',
    'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest'
]

describe('Smoke: CryptoNetworks Configuration', () => {
    for (const network of ALL_NETWORKS) {
        it(`should return a valid bitcoinjs-lib config for ${network}`, () => {
            const config = CryptoNetworks.getBitcoinJsNetwork(network)
            assert.ok(config, `${network} returned null/undefined`)
            assert.strictEqual(typeof config.pubKeyHash, 'number', `${network} missing pubKeyHash`)
            assert.strictEqual(typeof config.scriptHash, 'number', `${network} missing scriptHash`)
            assert.strictEqual(typeof config.wif, 'number', `${network} missing wif`)
        })
    }

    for (const network of ALL_NETWORKS) {
        it(`should return a valid startBlockIndex for ${network}`, () => {
            const firstBlock = CryptoNetworks.getFirstBlock(network)
            assert.strictEqual(typeof firstBlock, 'number', `${network} returned non-number`)
            assert.ok(firstBlock >= 0, `${network} returned negative startBlockIndex`)
            assert.ok(Number.isInteger(firstBlock), `${network} returned non-integer`)
        })
    }

    it('should return 0 for unknown regtest networks (default case)', () => {
        const firstBlock = CryptoNetworks.getFirstBlock('unknown-regtest')
        assert.strictEqual(firstBlock, 0)
    })
})
