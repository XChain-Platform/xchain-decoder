// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const path = require('path')
const local = require('../../src/protocol/protocol_time.js')
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js')

const CANONICAL_PATH = path.join(
    __dirname,
    '../../../xchain-indexer/src/consensus/protocol_time.js'
)
const ASCENDING_TIMES = Array.from({ length: 12 }, (_, index) => 1700000000 + index)
const MEDIAN_TIME_VECTORS = [
    ['non-array input', 42],
    ['empty input', []],
    ['non-finite and zero times', [0, NaN, Infinity, -Infinity, 'not-a-time']],
    ['fewer than the median span', [1700000002, 1700000000, 1700000001]],
    ['twelve ascending times', ASCENDING_TIMES],
    ['unsorted input', [12, 1, 11, 2, 10, 3, 9, 4, 8, 5, 7, 6]],
]
const PROTOCOL_TIME_VECTORS = [
    ['armed network', 'testnet', 1700000100, ASCENDING_TIMES],
    ['unarmed network', 'mainnet', 1700000100, ASCENDING_TIMES],
    ['empty history', 'testnet', 1700000100, []],
    ['future median clamp', 'testnet', 5, [6, 7, 8]],
    ['false raw-time sentinel', 'testnet', false, ASCENDING_TIMES],
    ['null raw-time sentinel', 'testnet', null, ASCENDING_TIMES],
    ['undefined raw-time sentinel', 'testnet', undefined, ASCENDING_TIMES],
    ['non-finite raw time', 'testnet', Infinity, ASCENDING_TIMES],
]

function copyInput(value){
    return Array.isArray(value) ? value.slice() : value
}

describe('protocol time parity with indexer @regression', function () {
    let canonical

    before(function () {
        const sibling = siblingCheckout(__dirname, CANONICAL_PATH)
        if (!sibling.usable){
            skipOrFail(this, sibling, 'the protocol-time parity guard')
            return
        }
        canonical = require(CANONICAL_PATH)
    })

    it('keeps the consensus constants identical', function () {
        assert.deepStrictEqual(local.MEDIAN_TIME_SPAN, canonical.MEDIAN_TIME_SPAN)
        assert.deepStrictEqual(
            local.PROTOCOL_TIME_MTP_NETWORKS,
            canonical.PROTOCOL_TIME_MTP_NETWORKS
        )
    })

    it('keeps medianTimePast behavior identical across value vectors', function () {
        for (const [label, previousBlockTimes] of MEDIAN_TIME_VECTORS){
            assert.deepStrictEqual(
                local.medianTimePast(copyInput(previousBlockTimes)),
                canonical.medianTimePast(copyInput(previousBlockTimes)),
                label
            )
        }
    })

    it('keeps protocolTime behavior identical across value vectors', function () {
        for (const [label, network, rawBlockTime, previousBlockTimes] of PROTOCOL_TIME_VECTORS){
            assert.deepStrictEqual(
                local.protocolTime(network, rawBlockTime, copyInput(previousBlockTimes)),
                canonical.protocolTime(network, rawBlockTime, copyInput(previousBlockTimes)),
                label
            )
        }
    })
})
