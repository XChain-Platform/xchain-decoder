// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const {
    MEDIAN_TIME_SPAN,
    isProtocolTimeMtpActive,
    medianTimePast,
    protocolTime,
    createBlockTimeContext,
} = require('../../src/protocol/protocol_time')

describe('protocol time', function () {
    const previous = Array.from({ length: MEDIAN_TIME_SPAN }, (_, index) => 100 + index)

    it('uses previous-block MTP only on the armed network', function () {
        assert.strictEqual(isProtocolTimeMtpActive('testnet'), true)
        assert.strictEqual(isProtocolTimeMtpActive('mainnet'), false)
        assert.strictEqual(isProtocolTimeMtpActive('regtest'), false)
        assert.strictEqual(protocolTime('testnet', 500, previous), 105)
        assert.strictEqual(protocolTime('mainnet', 500, previous), 500)
        assert.strictEqual(protocolTime('regtest', 500, previous), 500)
    })

    it('falls back to the raw clock at the history boundary', function () {
        assert.strictEqual(medianTimePast([]), null)
        assert.strictEqual(protocolTime('testnet', 500, []), 500)
        assert.strictEqual(protocolTime('testnet', 500, [480]), 480)
        assert.strictEqual(protocolTime('testnet', false, previous), false)
    })

    it('takes the first 11 height-descending entries before sorting by timestamp', function () {
        const newestFirst = [
            100, 900, 200, 800, 300, 700, 400, 600, 500, 1000, 1100,
            999999,
        ]

        assert.strictEqual(medianTimePast(newestFirst), 600)
    })

    it('does not replace an unusable window entry with an older entry', function () {
        const newestFirst = [
            100, 200, 300, 400, 500, NaN, 700, 800, 900, 1000, 1100,
            999999,
        ]

        assert.strictEqual(medianTimePast(newestFirst), 700)
    })

    it('returns an immutable context without changing replay inputs', function () {
        const input = previous.slice()
        const first = createBlockTimeContext('testnet', 500, input)
        const replay = createBlockTimeContext('testnet', 500, input)

        assert.deepStrictEqual(first, { rawBlockTime: 500, protocolBlockTime: 105 })
        assert.deepStrictEqual(replay, first)
        assert.deepStrictEqual(input, previous)
        assert.strictEqual(Object.isFrozen(first), true)
        assert.throws(() => {
            ;(function () { 'use strict'; first.protocolBlockTime = 999 })()
        }, TypeError)
    })

    it('never resolves protocol time later than the block stamp', function () {
        assert.strictEqual(protocolTime('testnet', 90, previous), 90)
    })
})
