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
const { collapseDispenserRegistrations } = require('../../../src/protocol/batch_sub_command_capture.js')
const { collapseRegistrationsByKey } = require('../../../src/protocol/dispenser_registration_collapse.js')

describe('collapseRegistrationsByKey', function () {
    const candidates = [
        { address: 'mAbc', sourceAddress: 'source-one', oracleAddress: '', expiration: 10 },
        { address: 'mabc', sourceAddress: 'source-two', oracleAddress: 'oracle-two', expiration: 30 },
        { address: 'mAbc', sourceAddress: 'source-three', oracleAddress: 'oracle-three', expiration: 20 },
        { address: 'mXyz', sourceAddress: 'source-four', oracleAddress: 'oracle-four', expiration: 5 },
    ]

    function callUnchanged(input, keyOf){
        const snapshot = JSON.stringify(input)
        const result = collapseRegistrationsByKey(input, keyOf)
        assert.strictEqual(JSON.stringify(input), snapshot)
        return result
    }

    it('matches the existing raw-address collapse when no key is provided', function () {
        assert.deepStrictEqual(callUnchanged(candidates), collapseDispenserRegistrations(candidates))
        assert.deepStrictEqual(callUnchanged(candidates, null), collapseDispenserRegistrations(candidates))
        assert.strictEqual(callUnchanged(candidates).length, 3)
    })

    it('collapses selected keys while preserving first-seen values and merge rules', function () {
        const result = callUnchanged(candidates, address => address.toLowerCase())
        assert.deepStrictEqual(result, [
            { address: 'mAbc', sourceAddress: 'source-one', oracleAddress: 'oracle-two', expiration: 30 },
            { address: 'mXyz', sourceAddress: 'source-four', oracleAddress: 'oracle-four', expiration: 5 },
        ])
    })

    it('keeps distinct selected addresses separate', function () {
        const result = callUnchanged(candidates.slice(0, 2), address => address)
        assert.deepStrictEqual(result.map(candidate => candidate.address), ['mAbc', 'mabc'])
    })

    it('falls back to the raw address when the selected key is null', function () {
        const result = callUnchanged(candidates, () => null)
        assert.deepStrictEqual(result, collapseDispenserRegistrations(candidates))
        assert.deepStrictEqual(callUnchanged(candidates, () => ''),
            collapseDispenserRegistrations(candidates))
    })

    it('skips missing candidates and candidates without an address', function () {
        const input = [null, { address: '' }, candidates[0]]
        assert.deepStrictEqual(callUnchanged(input), [
            { address: 'mAbc', sourceAddress: 'source-one', oracleAddress: null, expiration: 10 },
        ])
    })

    it('returns an empty array for non-array input', function () {
        assert.deepStrictEqual(collapseRegistrationsByKey('not-an-array', address => address), [])
        assert.deepStrictEqual(collapseRegistrationsByKey(undefined), [])
    })

    it('returns objects that do not alias input candidates', function () {
        const result = callUnchanged(candidates, address => address.toLowerCase())
        result[0].expiration = 0
        assert.strictEqual(candidates[0].expiration, 10)
        assert.strictEqual(candidates[1].expiration, 30)
    })
})
