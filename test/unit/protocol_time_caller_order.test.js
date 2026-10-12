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
const { fetchPreviousBlockTimes } = require('../../src/XChainDecoder/block_store.js')
const { MEDIAN_TIME_SPAN } = require('../../src/protocol/protocol_time.js')

describe('protocol time newest-first caller contract', function () {
    it('fetchPreviousBlockTimes returns a height-ordered window bounded by the median span', async function () {
        const calls = []
        const stamps = Array.from(
            { length: 20 },
            (_, height) => height % 2 === 0 ? 5000 - height : 1000 + height
        )
        const context = {
            db: {
                getBlockByIndex: async (height) => {
                    calls.push(height)
                    return { block_time: stamps[height] }
                },
            },
        }

        const times = await fetchPreviousBlockTimes.call(context, 20, stamps.length)
        const expectedHeights = Array.from(
            { length: MEDIAN_TIME_SPAN },
            (_, offset) => 19 - offset
        )

        assert.deepStrictEqual(calls, expectedHeights)
        assert.strictEqual(times.length, MEDIAN_TIME_SPAN)
        assert.deepStrictEqual(times, expectedHeights.map((height) => stamps[height]))
        assert.notDeepStrictEqual(times, [...times].sort((a, b) => b - a))
    })

    it('returns the available newest-first prefix near genesis', async function () {
        const stamps = [3200, 900, 2500]
        const context = {
            db: {
                getBlockByIndex: async (height) => ({ block_time: stamps[height] }),
            },
        }

        assert.deepStrictEqual(
            await fetchPreviousBlockTimes.call(context, stamps.length, MEDIAN_TIME_SPAN),
            [2500, 900, 3200]
        )
    })
})
