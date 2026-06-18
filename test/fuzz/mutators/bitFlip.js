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
 * Bit-flip mutator: flips random bits within a Buffer.
 */

const crypto = require('crypto')

/**
 * Flip between 1 and maxFlips random bits in the buffer.
 * Returns a new Buffer (does not modify the original).
 */
function flipBits(buf, maxFlips) {
    if (buf.length === 0) return Buffer.from(buf)
    const out = Buffer.from(buf)
    const flips = 1 + crypto.randomInt(Math.min(maxFlips || 8, out.length * 8))
    for (let i = 0; i < flips; i++) {
        const byteIdx = crypto.randomInt(out.length)
        const bitIdx = crypto.randomInt(8)
        out[byteIdx] ^= (1 << bitIdx)
    }
    return out
}

/**
 * Flip a single bit at a specific position (byte * 8 + bit).
 */
function flipBitAt(buf, byteIdx, bitIdx) {
    const out = Buffer.from(buf)
    if (byteIdx < out.length) {
        out[byteIdx] ^= (1 << (bitIdx % 8))
    }
    return out
}

/**
 * Walk through every bit position, yielding a mutated buffer for each.
 * Useful for exhaustive single-bit-flip coverage on small inputs.
 */
function* walkBits(buf) {
    for (let byteIdx = 0; byteIdx < buf.length; byteIdx++) {
        for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
            yield flipBitAt(buf, byteIdx, bitIdx)
        }
    }
}

module.exports = { flipBits, flipBitAt, walkBits }
