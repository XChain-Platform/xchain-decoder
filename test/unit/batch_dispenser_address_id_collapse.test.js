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
const constants = require('../../src/protocol/constants.js')
const {
    collapseDispenserRegistrations,
    isDispenserAddressIdCollapseActive,
} = require('../../src/protocol/batch_sub_command_capture.js')

describe('collapseDispenserRegistrations address-id collapse', function () {
    const original = constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION
    const candidates = [
        { address: 'mAbc', sourceAddress: 'src', oracleAddress: null, expiration: 10 },
        { address: 'mabc', sourceAddress: 'src', oracleAddress: 'oracle', expiration: 30 },
        { address: 'mxyz', sourceAddress: 'src', oracleAddress: null, expiration: 5 },
    ]

    beforeEach(function () {
        constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION = {
            mainnet: null, testnet: null, regtest: 0,
        }
    })

    afterEach(function () {
        if (original === undefined)
            delete constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION
        else
            constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION = original
    })

    it('uses numeric activation boundaries and rejects invalid inputs', function () {
        constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION.mainnet = 100
        assert.strictEqual(isDispenserAddressIdCollapseActive('mainnet', 99), false)
        assert.strictEqual(isDispenserAddressIdCollapseActive('mainnet', 100), true)
        assert.strictEqual(isDispenserAddressIdCollapseActive('regtest', 0), true)
        assert.strictEqual(isDispenserAddressIdCollapseActive('nonsense', 1), false)
        assert.strictEqual(isDispenserAddressIdCollapseActive('regtest', 'x'), false)
    })

    it('stays inactive everywhere while the constants define no gate', function () {
        delete constants.DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION
        assert.strictEqual(isDispenserAddressIdCollapseActive('regtest', 1), false)
        assert.strictEqual(collapseDispenserRegistrations(candidates, 'regtest', 1).length, 3)
    })

    it('keeps table-equivalent variants apart below the gate', function () {
        assert.strictEqual(collapseDispenserRegistrations(candidates).length, 3)
        assert.strictEqual(collapseDispenserRegistrations(candidates, 'mainnet', 1).length, 3)
    })

    it('merges table-equivalent variants once active', function () {
        const out = collapseDispenserRegistrations(candidates, 'regtest', 1)
        assert.deepStrictEqual(out, [
            { address: 'mAbc', sourceAddress: 'src', oracleAddress: 'oracle', expiration: 30 },
            { address: 'mxyz', sourceAddress: 'src', oracleAddress: null, expiration: 5 },
        ])
    })

    it('merges trailing-space variants and tolerates non-lists once active', function () {
        const out = collapseDispenserRegistrations([
            { address: 'mq', sourceAddress: 's', oracleAddress: null, expiration: 1 },
            { address: 'mq  ', sourceAddress: 's', oracleAddress: null, expiration: 2 },
        ], 'regtest', 1)
        assert.strictEqual(out.length, 1)
        assert.strictEqual(out[0].expiration, 2)
        assert.deepStrictEqual(collapseDispenserRegistrations(undefined, 'regtest', 1), [])
    })
})
