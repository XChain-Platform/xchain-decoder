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
const { dispenserAddressKey } = require('../../src/protocol/batch_sub_command_capture/dispenser_address_key.js')

describe('dispenserAddressKey', function () {

    it('folds ASCII letters to lower case', async function () {
        const addressIdOf = async address => address === 'BCRT1QXYZ' || address === 'bcrt1qxyz' ? 41 : 42
        assert.strictEqual(
            await dispenserAddressKey('BCRT1QXYZ', addressIdOf),
            await dispenserAddressKey('bcrt1qxyz', addressIdOf))
    })

    it('drops trailing spaces', async function () {
        const resolved = []
        const addressIdOf = async address => {
            resolved.push(address)
            if (address === 'mAbC  ' || address === 'mabc') return 12
            throw new Error('unexpected address: ' + address)
        }
        assert.strictEqual(
            await dispenserAddressKey('mAbC  ', addressIdOf),
            await dispenserAddressKey('mabc', addressIdOf))
        assert.deepStrictEqual(resolved, ['mAbC  ', 'mabc'])
    })

    it('keeps leading spaces and other characters', async function () {
        const addressIdOf = async address => address === ' MABC ' ? 7 : 8
        assert.notStrictEqual(
            await dispenserAddressKey(' MABC ', addressIdOf),
            await dispenserAddressKey('mabc', addressIdOf))
    })

    it('keeps distinct addresses distinct', async function () {
        assert.notStrictEqual(
            await dispenserAddressKey('first', async () => 7),
            await dispenserAddressKey('second', async () => 8))
        assert.strictEqual(
            await dispenserAddressKey('first', async () => 12),
            await dispenserAddressKey('second', async () => '12'))
        assert.notStrictEqual(
            await dispenserAddressKey('Málaga', async () => null),
            await dispenserAddressKey('malaga', async () => undefined))
    })
})
