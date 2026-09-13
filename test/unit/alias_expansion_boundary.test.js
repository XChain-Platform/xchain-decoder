// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Alias expansion at the size ceiling. The size gate and alias canonicalization are
// each covered elsewhere, but never together: every size-boundary case uses the
// non-expanding SEND, and every alias case is a tiny payload, so the expanding
// direction was structurally untested.
//
// MAX_ACTION_DATA_LENGTH bounds the COMPILED on-chain push, measured before
// canonicalizeActionPayload runs, so an expanding alias legitimately produces a
// stored record longer than the numeric cap. These cases pin that as the measured
// contract rather than an accident: if someone later moves the gate to measure the
// canonical buffer, they change what the protocol arbiter ACCEPTS, and that needs a
// flag-day (a *_ACTIVATION entry in src/protocol/constants.js), not a quiet edit.
// This suite is the tripwire that makes such an edit fail loudly first.

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

const { canonicalizeActionPayload, ACTION_ALIASES, MAX_ACTION_DATA_LENGTH } = XChainDecoder

// Worst-case growth over the whole alias table, derived rather than hardcoded so a
// newly added longer alias is caught by the assertions below instead of silently
// widening the gap.
function maxAliasExpansionBytes() {
    let max = 0
    for (const [alias, canonical] of Object.entries(ACTION_ALIASES)) {
        max = Math.max(max, Buffer.byteLength(canonical, 'ascii') - Buffer.byteLength(alias, 'ascii'))
    }
    return max
}

describe('alias expansion at the MAX_ACTION_DATA_LENGTH boundary', function () {

    it('CAST -> BROADCAST is the worst-case expansion, at 5 bytes', function () {
        assert.strictEqual(maxAliasExpansionBytes(), 5,
            'if this changes, the stored-record bound documented on MAX_ACTION_DATA_LENGTH changes with it')
        assert.strictEqual(ACTION_ALIASES['CAST'], 'BROADCAST')
    })

    it('every alias expansion delta is what the constant comment claims', function () {
        const expected = { TRANSFER: -4, ADDR: 3, DROP: 3, CAST: 5, MSG: 4 }
        const actual = {}
        for (const [alias, canonical] of Object.entries(ACTION_ALIASES)) {
            actual[alias] = Buffer.byteLength(canonical, 'ascii') - Buffer.byteLength(alias, 'ascii')
        }
        assert.deepStrictEqual(actual, expected)
    })

    it('a payload at exactly the cap canonicalizes to a record ABOVE the cap', function () {
        // Build a CAST payload whose raw wire bytes are exactly MAX_ACTION_DATA_LENGTH.
        // (The gate compares compiledDataLength, which is this length plus the push
        // prefix; what matters here is the pre/post canonicalization delta.)
        const prefix = 'CAST|0|'
        const payload = Buffer.from(prefix + 'a'.repeat(MAX_ACTION_DATA_LENGTH - prefix.length), 'ascii')
        assert.strictEqual(payload.length, MAX_ACTION_DATA_LENGTH)

        const canonical = canonicalizeActionPayload(payload)

        assert.strictEqual(canonical.actionName, 'BROADCAST')
        assert.strictEqual(canonical.isKnown, true)
        assert.strictEqual(canonical.buffer.length, MAX_ACTION_DATA_LENGTH + 5,
            'the stored record is 5 bytes longer than the cap; the cap bounds the WIRE form only')
        assert.ok(canonical.buffer.toString('ascii').startsWith('BROADCAST|0|'))
        // Everything after the first pipe survives byte-for-byte.
        assert.deepStrictEqual(
            canonical.buffer.subarray('BROADCAST'.length),
            payload.subarray('CAST'.length),
            'only the leading name bytes are rewritten')
    })

    it('a non-expanding alias at the cap stays at or below it', function () {
        // TRANSFER -> SEND is the control: the same code path, opposite direction.
        const prefix = 'TRANSFER|0|'
        const payload = Buffer.from(prefix + 'a'.repeat(MAX_ACTION_DATA_LENGTH - prefix.length), 'ascii')
        const canonical = canonicalizeActionPayload(payload)

        assert.strictEqual(canonical.actionName, 'SEND')
        assert.strictEqual(canonical.buffer.length, MAX_ACTION_DATA_LENGTH - 4)
    })

    it('an already-canonical name at the cap is returned unchanged', function () {
        const prefix = 'BROADCAST|0|'
        const payload = Buffer.from(prefix + 'a'.repeat(MAX_ACTION_DATA_LENGTH - prefix.length), 'ascii')
        const canonical = canonicalizeActionPayload(payload)

        assert.strictEqual(canonical.actionName, 'BROADCAST')
        assert.strictEqual(canonical.buffer.length, MAX_ACTION_DATA_LENGTH)
        assert.strictEqual(canonical.buffer, payload, 'no rewrite means the same buffer reference')
    })
})
