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
 **********************************************************************
 * Seeded randomness for fuzz mutators and their harness processes.
 */

const crypto = require('crypto')

const nativeRandomInt = crypto.randomInt.bind(crypto)

function mulberry32(seed) {
    let state = seed >>> 0
    return function next() {
        state = (state + 0x6D2B79F5) | 0
        let value = Math.imul(state ^ (state >>> 15), 1 | state)
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
}

function seededRng(seed) {
    const next = mulberry32(seed)
    return {
        randomInt(maxExclusive) {
            if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
                throw new RangeError('maxExclusive must be a positive safe integer')
            }
            return Math.floor(next() * maxExclusive)
        },
        randomBytes(size) {
            const output = Buffer.alloc(size)
            for (let index = 0; index < size; index++) {
                output[index] = Math.floor(next() * 256)
            }
            return output
        }
    }
}

function resolveSeed() {
    if (process.env.FUZZ_SEED === undefined) return nativeRandomInt(0x100000000)
    const seed = Number(process.env.FUZZ_SEED)
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new Error('FUZZ_SEED must be an integer from 0 through 4294967295')
    }
    return seed
}

const FUZZ_SEED = resolveSeed()
const DEFAULT_RNG = seededRng(FUZZ_SEED)

function deterministicRandomInt(minOrMax, maybeMax, maybeCallback) {
    const hasMin = typeof maybeMax === 'number'
    const min = hasMin ? minOrMax : 0
    const max = hasMin ? maybeMax : minOrMax
    const callback = hasMin ? maybeCallback : maybeMax
    const value = min + DEFAULT_RNG.randomInt(max - min)
    if (typeof callback === 'function') return process.nextTick(callback, null, value)
    return value
}

function deterministicRandomBytes(size, callback) {
    const value = DEFAULT_RNG.randomBytes(size)
    if (typeof callback === 'function') return process.nextTick(callback, null, value)
    return value
}

crypto.randomInt = deterministicRandomInt
crypto.randomBytes = deterministicRandomBytes

console.error(`FUZZ_SEED=${FUZZ_SEED}`)

module.exports = { FUZZ_SEED, DEFAULT_RNG, mulberry32, seededRng }
