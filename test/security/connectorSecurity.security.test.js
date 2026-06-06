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
const BlockchainConnector = require('../../src/BlockchainConnector')

describe('Security: BlockchainConnector', () => {

    // --- SEC-04: HTTPS support ---

    describe('Protocol handling', () => {
        it('should default to http:// when no protocol is specified', () => {
            const connector = new BlockchainConnector('127.0.0.1', 8332, 'rpc', 'rpc')
            assert.ok(connector.url.startsWith('http://'))
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('should not double-prefix when http:// is already present', () => {
            const connector = new BlockchainConnector('http://127.0.0.1', 8332, 'rpc', 'rpc')
            assert.ok(connector.url.startsWith('http://'))
            assert.ok(!connector.url.startsWith('http://http://'))
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('[REGRESSION P0] R-SEC-001: should preserve https:// when specified', () => {
            const connector = new BlockchainConnector('https://secure-node.example.com', 8332, 'rpc', 'rpc')
            assert.ok(connector.url.startsWith('https://'))
            assert.strictEqual(connector.url, 'https://secure-node.example.com:8332')
        })

        it('should not double-prefix when https:// is already present', () => {
            const connector = new BlockchainConnector('https://node.local', 18443, 'user', 'pass')
            assert.ok(!connector.url.includes('http://https://'))
            assert.strictEqual(connector.url, 'https://node.local:18443')
        })
    })

    // --- Credential storage ---

    describe('Credential handling', () => {
        it('should store RPC credentials', () => {
            const connector = new BlockchainConnector('127.0.0.1', 8332, 'myuser', 'mypass')
            assert.strictEqual(connector.rpcUser, 'myuser')
            assert.strictEqual(connector.rpcPassword, 'mypass')
        })

        it('[REGRESSION P0] R-SEC-001: should not include credentials in the URL', () => {
            const connector = new BlockchainConnector('127.0.0.1', 8332, 'myuser', 'mypass')
            assert.ok(!connector.url.includes('myuser'))
            assert.ok(!connector.url.includes('mypass'))
        })
    })
})
