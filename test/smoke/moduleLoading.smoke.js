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

describe('Smoke: Module Loading', () => {
    it('should load XChainDecoder', () => {
        const XChainDecoder = require('../../src/XChainDecoder')
        assert.strictEqual(typeof XChainDecoder, 'function')
    })

    it('should load Database', () => {
        const Database = require('../../src/db')
        assert.strictEqual(typeof Database, 'function')
    })

    it('should load BlockchainConnector', () => {
        const BlockchainConnector = require('../../src/BlockchainConnector')
        assert.strictEqual(typeof BlockchainConnector, 'function')
    })

    it('should load CryptoNetworks', () => {
        const CryptoNetworks = require('../../src/CryptoNetworks')
        assert.strictEqual(typeof CryptoNetworks, 'function')
    })

    it('should load XChainBlockDecoder', () => {
        const XChainBlockDecoder = require('../../src/XChainBlockDecoder')
        assert.strictEqual(typeof XChainBlockDecoder, 'function')
    })

    it('should load util', () => {
        const util = require('../../src/util')
        assert.strictEqual(typeof util, 'object')
        assert.strictEqual(typeof util.sleep, 'function')
        assert.strictEqual(typeof util.uint8ArrayToHex, 'function')
    })

    it('should construct an XChainDecoder instance', () => {
        const XChainDecoder = require('../../src/XChainDecoder')
        const decoder = new XChainDecoder(
            'bitcoin-regtest', null, null, null, null, null,
            '127.0.0.1', 18443, 'rpc', 'rpc', false
        )
        assert.ok(decoder)
        assert.strictEqual(typeof decoder.start, 'function')
        assert.strictEqual(typeof decoder.stop, 'function')
        assert.strictEqual(typeof decoder.parseRawTransaction, 'function')
        assert.strictEqual(typeof decoder.removeObfuscation, 'function')
    })

    it('should construct a BlockchainConnector instance', () => {
        const BlockchainConnector = require('../../src/BlockchainConnector')
        const connector = new BlockchainConnector('127.0.0.1', 18443, 'rpc', 'rpc')
        assert.ok(connector)
        assert.strictEqual(typeof connector.getBlockchainInfo, 'function')
        assert.strictEqual(typeof connector.getBlock, 'function')
        assert.strictEqual(typeof connector.getRawTransaction, 'function')
    })

    it('should construct an XChainBlockDecoder instance', () => {
        const XChainBlockDecoder = require('../../src/XChainBlockDecoder')
        const decoder = new XChainBlockDecoder('bitcoin-regtest')
        assert.ok(decoder)
        assert.strictEqual(decoder.coin, 'bitcoin')
        assert.strictEqual(typeof decoder.blockFromHex, 'function')
        assert.strictEqual(typeof decoder.transactionFromHex, 'function')
    })
})
