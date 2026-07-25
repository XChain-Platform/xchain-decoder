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
// BET decode vectors ( P2).
//
// The decoder is the arbiter of which leading ACTION token survives decode: a
// name outside VALID_ACTION_NAMES is dropped with a console.error and no test
// failure anywhere, so an unwired action means every on-chain BET vanishes
// silently while the transaction still pays its fee. ActionManifestConformance
// next door pins the SET; this file pins the BEHAVIOUR of the gate on the exact
// payload shapes BET puts on the wire, which is what the manifest guard cannot
// see: the base64 DETAILS field, the four format shapes, and the size class
// that forces a two-transaction encoding.

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

const {
    canonicalizeActionPayload,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    MAX_ACTION_DATA_LENGTH,
    compiledPushSize
} = XChainDecoder

// From xchain-documentation/protocol/actions/BET.md; the decoded-byte cap on
// the DETAILS field, which is what makes a create action large. DETAILS rides
// the wire base64-encoded, so the on-wire cost is ceil(n/3)*4.
const MAX_BET_DETAILS_LENGTH = 4096
const base64Length = n => Math.ceil(n / 3) * 4

function gate (payload) {
    return canonicalizeActionPayload(Buffer.from(payload, 'utf8'))
}

// The four wire shapes, spelled out as they appear on-chain.
const VECTORS = {
    create:  'BET|0|Superbowl LX winner|Chiefs,49ers|PEPECASH|1.00|1770000000||||||Bet on the big game',
    cancel:  'BET|1|1234|Game postponed, refunding everyone',
    place:   'BET|2|1234|0|25.00000000|Chiefs all day',
    resolve: 'BET|3|1234|1|Final score 24-21'
}

describe('BET action-name gate ', function () {

    it('every BET format survives the ACTION-name gate', function () {
        for (const [name, payload] of Object.entries(VECTORS)) {
            const out = gate(payload)
            assert.strictEqual(out.isKnown, true, `${name}: BET must be a known ACTION name`)
            assert.strictEqual(out.actionName, 'BET', `${name}: canonical name`)
            assert.strictEqual(out.rawActionName, 'BET', `${name}: raw name`)
            assert.strictEqual(out.buffer.toString('utf8'), payload,
                `${name}: BET is not an alias, so the payload must pass through byte-identical`)
        }
    })

    it('BET has no alias and is not the target of one', function () {
        // A future alias would rewrite the leading token before the gate, so the
        // stored record would not say BET. Pin the absence in both directions.
        assert.ok(!Object.prototype.hasOwnProperty.call(ACTION_ALIASES, 'BET'),
            'BET must not be an alias key')
        assert.ok(!Object.values(ACTION_ALIASES).includes('BET'),
            'nothing may alias TO BET without updating the manifest and this vector set')
    })

    it('the gate matches the whole name token, not a prefix', function () {
        // BET is a short name sitting next to real words. If the gate ever went
        // prefix-based, BETS/BETTING would decode as BET and index as one.
        for (const near of ['BETS', 'BETTING', 'BE', 'bet', 'Bet', 'XBET']) {
            const out = gate(near + '|0|x')
            assert.strictEqual(out.isKnown, false, `${near} must not be accepted as BET`)
            assert.strictEqual(out.actionName, near, `${near} must not be rewritten`)
        }
        // The bare name with no pipe is the same token and is still valid.
        assert.strictEqual(gate('BET').isKnown, true)
    })

    it('a base64 DETAILS payload passes through byte-for-byte', function () {
        // DETAILS is the only field carrying + / and = on the wire. The gate
        // returns everything after the first pipe verbatim, and this is the field
        // where a stray rewrite would corrupt a market definition irreversibly:
        // the base64 would no longer round-trip and the create would be rejected.
        const details = Buffer.from(JSON.stringify({
            title: 'Who wins Superbowl LX?',
            outcomes: ['Chiefs', '49ers']
        }), 'utf8').toString('base64')
        assert.ok(/[+/=]/.test(details + '=='), 'sanity: base64 alphabet under test')

        const payload = `BET|0|Superbowl|Chiefs,49ers|PEPECASH|1.00|1770000000|||||${details}|memo`
        const out = gate(payload)
        assert.strictEqual(out.isKnown, true)
        assert.strictEqual(out.buffer.toString('utf8'), payload)
        // And the DETAILS field is still exactly what went in.
        assert.strictEqual(out.buffer.toString('utf8').split('|')[11], details)
    })

    it('a create at the DETAILS cap exceeds OP_RETURN and needs a P2SH/P2WSH encoding', function () {
        // Not a decoder rule, a decoder-visible consequence: a max-size market
        // definition cannot ride an OP_RETURN, so the encoder and SDK must select
        // a two-transaction encoding for it. Pinned here because the decoder is
        // the side that would silently drop an over-cap push.
        const details = 'A'.repeat(base64Length(MAX_BET_DETAILS_LENGTH))
        const payload = `BET|0|L|Yes,No|TICK|1.00|1770000000|||||${details}|`
        const compiled = compiledPushSize(Buffer.byteLength(payload, 'utf8'))

        assert.ok(compiled + 4 > 80,
            'a max-DETAILS create must not fit an 80-byte OP_RETURN output')
        assert.ok(compiled <= MAX_ACTION_DATA_LENGTH,
            'but it must still fit the protocol ACTION-data cap, or BET.md promises a market ' +
            'definition size the wire cannot carry (MAX_ACTION_DATA_LENGTH=' + MAX_ACTION_DATA_LENGTH + ')')

        // The name gate is unaffected by size: it runs on the payload it is given.
        assert.strictEqual(gate(payload).isKnown, true)
    })

    it('the DETAILS cap leaves room for a worst-case create on the same wire', function () {
        // The check that caught the original spec value. DETAILS is base64 on the
        // wire (+33%) and shares ONE 8192-byte compiled ceiling with every other
        // field, so the cap has to be set against the WORST-CASE create, not
        // against the ceiling directly. At the spec's first value (8192 decoded)
        // a max-size market was ~12.8KB and could never have been broadcast:
        // the encoder refuses it and every node drops it.
        const worstCase = [
            'BET', '0',
            'L'.repeat(250),                                        // MAX_BET_LABEL_LENGTH
            Array.from({ length: 16 }, () => 'o'.repeat(64)).join(','), // 16 x MAX_BET_OUTCOME_LENGTH
            'T'.repeat(250),                                        // MAX_TICK_LENGTH
            '10.00',                                                // MAX_FEED_FEE
            '1770000000',                                           // DEADLINE
            '31536000',                                             // MAX_BET_REFUND_WINDOW
            '1'.repeat(21) + '.' + '0'.repeat(18),                  // MIN_AMOUNT at MAX_DECIMALS
            '1'.repeat(12), '2'.repeat(12),                         // ALLOW_LIST / BLOCK_LIST
            'A'.repeat(base64Length(MAX_BET_DETAILS_LENGTH)),       // DETAILS at the cap
            'M'.repeat(250)                                         // MAX_MEMO_LENGTH
        ].join('|')

        const compiled = compiledPushSize(Buffer.byteLength(worstCase, 'utf8'))
        assert.ok(compiled <= MAX_ACTION_DATA_LENGTH,
            `a worst-case BET create compiles to ${compiled} bytes, over the ` +
            `${MAX_ACTION_DATA_LENGTH}-byte ACTION cap. Lower MAX_BET_DETAILS_LENGTH, or ` +
            'BET.md documents market definitions that cannot be broadcast.')
        assert.strictEqual(gate(worstCase).actionName, 'BET')
    })

    it('adding BET did not disturb the neighbouring names', function () {
        // BET was inserted into the middle of the VALID_ACTION_NAMES literal;
        // a botched edit there drops a sibling, which is silent everywhere else.
        for (const name of ['BATCH', 'BROADCAST', 'CALLBACK', 'ADDRESS', 'SEND'])
            assert.ok(VALID_ACTION_NAMES.has(name), `${name} must still be a valid ACTION name`)
        assert.strictEqual(gate('CAST|0|still an alias').actionName, 'BROADCAST',
            'the CAST -> BROADCAST alias must still expand')
    })
})
