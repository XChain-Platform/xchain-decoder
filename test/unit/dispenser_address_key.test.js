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

    it('folds ASCII letters to lower case', function () {
        assert.strictEqual(dispenserAddressKey('BCRT1QXYZ'), 'bcrt1qxyz')
        assert.strictEqual(dispenserAddressKey('mAbC'), dispenserAddressKey('mabc'))
    })

    it('drops trailing spaces', function () {
        assert.strictEqual(dispenserAddressKey('mAbC  '), 'mabc')
        assert.strictEqual(dispenserAddressKey('   '), '')
    })

    it('keeps leading spaces and other characters', function () {
        assert.notStrictEqual(dispenserAddressKey(' mabc'), dispenserAddressKey('mabc'))
        assert.strictEqual(dispenserAddressKey(' MABC '), ' mabc')
        assert.strictEqual(dispenserAddressKey('ÄBC\t\u00a0'), 'Äbc\t\u00a0')
    })

    it('keeps distinct addresses distinct', function () {
        assert.notStrictEqual(dispenserAddressKey('mabc'), dispenserAddressKey('mabd'))
        assert.strictEqual(typeof dispenserAddressKey('mAbC'), 'string')
    })
})
