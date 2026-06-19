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
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../src/CryptoNetworks')

describe('CryptoNetworks', () => {

    describe('#getBitcoinJsNetwork()', () => {
        it('[REGRESSION P2] R-NET-001: should return bitcoinjs bitcoin mainnet for "bitcoin-mainnet"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
            assert.strictEqual(net, bitcoin.networks.bitcoin)
        })

        it('[REGRESSION P2] R-NET-001: should return bitcoinjs testnet for "bitcoin-testnet"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-testnet')
            assert.strictEqual(net, bitcoin.networks.testnet)
        })

        it('[REGRESSION P2] R-NET-001: should return bitcoinjs regtest for "bitcoin-regtest"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
            assert.strictEqual(net, bitcoin.networks.regtest)
        })

        it('[REGRESSION P2] R-NET-001: should return Dogecoin mainnet config with correct pubKeyHash', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
            assert.strictEqual(net.pubKeyHash, 0x1e)
            assert.strictEqual(net.scriptHash, 0x16)
            assert.strictEqual(net.wif, 0x9e)
        })

        it('should return Dogecoin testnet config with correct pubKeyHash', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
            assert.strictEqual(net.pubKeyHash, 0x71)
        })

        it('should return Dogecoin regtest config using Bitcoin-testnet prefixes (dogecoind v1.14 regtest)', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
            // dogecoind v1.14.x in regtest mode uses Bitcoin-testnet prefixes,
            // NOT Dogecoin-testnet prefixes (0x71). See src/CryptoNetworks.js comment
            // and commit c70c864 for the verified rationale.
            assert.strictEqual(net.pubKeyHash, 0x6f)
            assert.strictEqual(net.scriptHash, 0xc4)
        })

        it('[REGRESSION P2] R-NET-001: should return Litecoin mainnet config with bech32 prefix "ltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet')
            assert.strictEqual(net.bech32, 'ltc')
            assert.strictEqual(net.pubKeyHash, 0x30)
        })

        it('should return Litecoin testnet config with bech32 prefix "tltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet')
            assert.strictEqual(net.bech32, 'tltc')
        })

        it('should return Litecoin regtest config with bech32 prefix "rltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest')
            assert.strictEqual(net.bech32, 'rltc')
        })

        it('[REGRESSION P2] R-NET-001: should throw a TypeError for an unknown network (fail fast, no silent mainnet default)', () => {
            assert.throws(
                () => CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet'),
                /Unknown network: "ethereum-mainnet"/
            )
        })

        it('should include messagePrefix for all Dogecoin networks', () => {
            for (const variant of ['dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest']) {
                const net = CryptoNetworks.getBitcoinJsNetwork(variant)
                assert.ok(net.messagePrefix.includes('Dogecoin'))
            }
        })

        it('should include messagePrefix for all Litecoin networks', () => {
            for (const variant of ['litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest']) {
                const net = CryptoNetworks.getBitcoinJsNetwork(variant)
                assert.ok(net.messagePrefix.includes('Litecoin'))
            }
        })

        it('should include bip32 keys for all custom networks', () => {
            const customs = [
                'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
                'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
            ]
            for (const name of customs) {
                const net = CryptoNetworks.getBitcoinJsNetwork(name)
                assert.ok(net.bip32, `${name} missing bip32`)
                assert.ok(typeof net.bip32.public === 'number', `${name} missing bip32.public`)
                assert.ok(typeof net.bip32.private === 'number', `${name} missing bip32.private`)
            }
        })
    })

    describe('#getFirstBlock()', () => {
        it('[REGRESSION P2] R-NET-005: should return 950000 for bitcoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 950000)
        })

        it('should return 138000 for bitcoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 138000)
        })

        it('[REGRESSION P2] R-NET-005: should return 3120000 for litecoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-mainnet'), 3120000)
        })

        it('should return 4765000 for litecoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-testnet'), 4765000)
        })

        it('[REGRESSION P2] R-NET-005: should return 6240000 for dogecoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 6240000)
        })

        it('should return 64800000 for dogecoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-testnet'), 64800000)
        })

        it('[REGRESSION P2] R-NET-005: should return 0 for all regtest networks', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-regtest'), 0)
        })

        it('should return 0 for unknown networks (default case)', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('unknown-network'), 0)
        })
    })
})
