/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Byte-level mutation operators: insert, delete, substitute, truncate, extend.
 */

const crypto = require('crypto')

const BOUNDARY_BYTES = [0x00, 0xFF, 0x80, 0x7F, 0x01, 0xFE]

/** Insert 1-N random bytes at a random position. */
function insertBytes(buf, maxInsert) {
    const count = 1 + crypto.randomInt(maxInsert || 4)
    const pos = buf.length === 0 ? 0 : crypto.randomInt(buf.length + 1)
    const inserted = crypto.randomBytes(count)
    return Buffer.concat([buf.subarray(0, pos), inserted, buf.subarray(pos)])
}

/** Delete 1-N bytes from a random position. */
function deleteBytes(buf, maxDelete) {
    if (buf.length === 0) return Buffer.from(buf)
    const count = Math.min(1 + crypto.randomInt(maxDelete || 4), buf.length)
    const pos = crypto.randomInt(buf.length - count + 1)
    return Buffer.concat([buf.subarray(0, pos), buf.subarray(pos + count)])
}

/** Replace 1-N bytes at a random position with random bytes. */
function substituteBytes(buf, maxSub) {
    if (buf.length === 0) return Buffer.from(buf)
    const count = Math.min(1 + crypto.randomInt(maxSub || 4), buf.length)
    const pos = crypto.randomInt(buf.length - count + 1)
    const out = Buffer.from(buf)
    for (let i = 0; i < count; i++) {
        out[pos + i] = crypto.randomInt(256)
    }
    return out
}

/** Replace a random byte with a boundary value. */
function substituteBoundary(buf) {
    if (buf.length === 0) return Buffer.from(buf)
    const out = Buffer.from(buf)
    const pos = crypto.randomInt(out.length)
    out[pos] = BOUNDARY_BYTES[crypto.randomInt(BOUNDARY_BYTES.length)]
    return out
}

/** Truncate the buffer to a random shorter length. */
function truncate(buf) {
    if (buf.length <= 1) return Buffer.alloc(0)
    const newLen = crypto.randomInt(buf.length)
    return buf.subarray(0, newLen)
}

/** Extend the buffer with random bytes. */
function extend(buf, maxExtend) {
    const count = 1 + crypto.randomInt(maxExtend || 32)
    return Buffer.concat([buf, crypto.randomBytes(count)])
}

/** Set all bytes in a random range to zero. */
function zeroRange(buf) {
    if (buf.length === 0) return Buffer.from(buf)
    const out = Buffer.from(buf)
    const start = crypto.randomInt(out.length)
    const len = Math.min(1 + crypto.randomInt(8), out.length - start)
    out.fill(0, start, start + len)
    return out
}

/** Set all bytes in a random range to 0xFF. */
function ffRange(buf) {
    if (buf.length === 0) return Buffer.from(buf)
    const out = Buffer.from(buf)
    const start = crypto.randomInt(out.length)
    const len = Math.min(1 + crypto.randomInt(8), out.length - start)
    out.fill(0xFF, start, start + len)
    return out
}

/** Pick a random mutation operator and apply it. */
function mutateRandom(buf) {
    const ops = [insertBytes, deleteBytes, substituteBytes, substituteBoundary, truncate, extend, zeroRange, ffRange]
    const op = ops[crypto.randomInt(ops.length)]
    return op(buf)
}

module.exports = {
    insertBytes, deleteBytes, substituteBytes, substituteBoundary,
    truncate, extend, zeroRange, ffRange, mutateRandom
}
