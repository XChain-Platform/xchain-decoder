// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const { VALID_ACTION_NAMES } = require('../../src/XChainDecoder/constants.js')

// Membership of VALID_ACTION_NAMES is consensus: every node must accept the same
// top-level names at the same height. Adding or removing a name here without a
// height-keyed activation forks the fleet, so this pin fails until the change is
// made deliberately, together with its flag-day.
const PINNED_NAMES = [
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST', 'BATCH', 'BET', 'BROADCAST', 'CALLBACK',
    'COINPAY', 'COLLECT', 'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'ROLLCALL', 'SEND', 'SLASH', 'SLEEP', 'STAKE',
    'SWAP', 'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW', 'XBRIDGE'
]

describe('VALID_ACTION_NAMES flag-day pin @regression', function () {
    it('holds exactly the pinned names', function () {
        const actual = [...VALID_ACTION_NAMES].sort()
        const expected = [...PINNED_NAMES].sort()
        assert.deepStrictEqual({
            added: actual.filter(n => !expected.includes(n)),
            removed: expected.filter(n => !actual.includes(n))
        }, { added: [], removed: [] },
        'VALID_ACTION_NAMES changed: a membership change is a consensus flag-day, not an in-place edit')
    })

    it('pins a stable digest of the sorted membership', function () {
        const digest = crypto.createHash('sha256').update([...VALID_ACTION_NAMES].sort().join('\n')).digest('hex')
        const expected = crypto.createHash('sha256').update([...PINNED_NAMES].sort().join('\n')).digest('hex')
        assert.strictEqual(digest, expected)
    })

    it('contains only upper-case names with no duplicates in the pin', function () {
        for (const n of VALID_ACTION_NAMES) assert.match(n, /^[A-Z]+$/)
        assert.strictEqual(new Set(PINNED_NAMES).size, PINNED_NAMES.length)
    })

    it('falsification: a changed membership is detected', function () {
        const mutated = new Set(VALID_ACTION_NAMES).add('NEWACTION')
        const added = [...mutated].filter(n => !PINNED_NAMES.includes(n))
        assert.deepStrictEqual(added, ['NEWACTION'])
    })
})
