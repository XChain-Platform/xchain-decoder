/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const { logger } = require('../../../../src/chain/blockchain_connector/constants.js')
const {
    envInt,
    normalizeEndpoint,
    nodeReachabilityFrom,
} = require('../../../../src/chain/blockchain_connector/rpc_helpers.js')

describe('envInt', () => {
    let originalWarn
    let warnings

    beforeEach(() => {
        originalWarn = logger.warn
        warnings = []
        logger.warn = (...args) => warnings.push(args)
    })

    afterEach(() => {
        logger.warn = originalWarn
    })

    it('uses the fallback for missing, empty, and invalid values', () => {
        for (const raw of [undefined, null, '', 0, 'x']) {
            assert.strictEqual(envInt(raw, 7, 'RPC_TIMEOUT'), 7)
        }
    })

    it('trims valid integers and honors a custom minimum', () => {
        assert.strictEqual(envInt('  8 ', 7, 'RPC_TIMEOUT'), 8)
        assert.strictEqual(envInt(-2, 7, 'RPC_TIMEOUT', -5), -2)
        assert.strictEqual(envInt(0, 7, 'RPC_TIMEOUT', 0), 0)
    })

    it('warns for an empty value but not an undefined value', () => {
        envInt('', 7, 'RPC_TIMEOUT')
        assert.strictEqual(warnings.length, 1)

        warnings.length = 0
        envInt(undefined, 7, 'RPC_TIMEOUT')
        assert.strictEqual(warnings.length, 0)
    })
})

describe('normalizeEndpoint', () => {
    it('adds missing protocols and ports while preserving complete URLs', () => {
        assert.strictEqual(normalizeEndpoint('node1', 8332), 'http://node1:8332')
        assert.strictEqual(normalizeEndpoint('https://a.b:99', 8332), 'https://a.b:99')
        assert.strictEqual(normalizeEndpoint(' http://h ', 1), 'http://h:1')
    })

    it('rejects malformed endpoints', () => {
        assert.throws(
            () => normalizeEndpoint('a:b:c', 8332),
            /^Error: BlockchainConnector: invalid RPC endpoint: a:b:c$/,
        )
    })
})

describe('nodeReachabilityFrom', () => {
    it('reports an unknown state before any node attempt', () => {
        assert.deepStrictEqual(nodeReachabilityFrom(1000, 0, 0, 5000), {
            node_last_ok_at: null,
            node_unreachable: null,
        })
    })

    it('reports the last success when the latest attempt succeeded', () => {
        assert.deepStrictEqual(nodeReachabilityFrom(1000, 4000, 3000, 6000), {
            node_last_ok_at: '1970-01-01T00:00:04.000Z',
            node_unreachable: null,
        })
    })

    it('dates an initial outage from connector startup', () => {
        assert.deepStrictEqual(nodeReachabilityFrom(1000, 0, 500, 6000), {
            node_last_ok_at: null,
            node_unreachable: {
                since: '1970-01-01T00:00:01.000Z',
                last_ok_at: null,
                seconds: 5,
            },
        })
    })

    it('dates a later outage from the last successful attempt', () => {
        assert.deepStrictEqual(nodeReachabilityFrom(1000, 2000, 3000, 6000), {
            node_last_ok_at: '1970-01-01T00:00:02.000Z',
            node_unreachable: {
                since: '1970-01-01T00:00:02.000Z',
                last_ok_at: '1970-01-01T00:00:02.000Z',
                seconds: 4,
            },
        })
    })
})
