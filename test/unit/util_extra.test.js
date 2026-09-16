// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Extra unit tests for util functions not covered in util.test.js:
//   - startTimer
//   - logTimer

const assert = require('assert')
const util   = require('../../src/util')

describe('util#startTimer()', () => {
    it('should return a number (millisecond timestamp)', () => {
        const timer = util.startTimer()
        assert.strictEqual(typeof timer, 'number')
    })

    it('should return a value close to Date.now()', () => {
        const before = Date.now()
        const timer  = util.startTimer()
        const after  = Date.now()
        assert.ok(timer >= before, 'timer should be >= Date.now() at start')
        assert.ok(timer <= after,  'timer should be <= Date.now() at end')
    })

    it('should return an increasing value on successive calls', async () => {
        const t1 = util.startTimer()
        await util.sleep(10)
        const t2 = util.startTimer()
        assert.ok(t2 >= t1, 'successive timers should be non-decreasing')
    })
})

describe('util#logTimer()', () => {
    it('should log without throwing for a zero-elapsed timer', () => {
        const timer = Date.now()
        assert.doesNotThrow(() => util.logTimer(timer, 'testLabel'))
    })

    it('should log without throwing for a null label', () => {
        const timer = Date.now()
        assert.doesNotThrow(() => util.logTimer(timer, null))
    })

    it('should log without throwing for a past timer with a label', () => {
        const timer = Date.now() - 1500
        assert.doesNotThrow(() => util.logTimer(timer, 'elapsed'))
    })

    it('should not throw when timeName is undefined', () => {
        const timer = Date.now()
        assert.doesNotThrow(() => util.logTimer(timer, undefined))
    })
})

describe('util#millisecondsToTimeString() two-digit padding branches', () => {
    it('should not pad hours when hours >= 10', () => {
        // 10h 0m 0s = 36000000ms
        const result = util.millisecondsToTimeString(36000000)
        assert.ok(result.includes('10h'), `Expected "10h" in "${result}"`)
    })

    it('should not pad minutes when minutes >= 10', () => {
        // 0h 15m 0s = 900000ms
        const result = util.millisecondsToTimeString(900000)
        assert.ok(result.includes('15m'), `Expected "15m" in "${result}"`)
    })

    it('should not pad seconds when seconds >= 10', () => {
        // 0h 0m 30s = 30000ms
        const result = util.millisecondsToTimeString(30000)
        assert.ok(result.includes('30.'), `Expected "30." in "${result}"`)
    })
})
