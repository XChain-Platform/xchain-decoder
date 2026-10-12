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

    it('keys table-equivalent spellings on their resolved address id', async function () {
        const addressIdOf = async address => address === 'Málaga' || address === 'malaga' ? 41 : 42
        assert.strictEqual(
            await dispenserAddressKey('Málaga', addressIdOf),
            await dispenserAddressKey('malaga', addressIdOf))
    })

    it('keeps distinct resolved ids distinct', async function () {
        const addressIdOf = async address => address === 'first' ? 7 : 8
        assert.notStrictEqual(
            await dispenserAddressKey('first', addressIdOf),
            await dispenserAddressKey('second', addressIdOf))
    })

    it('namespaces numeric and string ids identically', async function () {
        assert.strictEqual(
            await dispenserAddressKey('first', async () => 12),
            await dispenserAddressKey('second', async () => '12'))
    })

    it('falls back to the raw spelling when the resolver has no id', async function () {
        assert.notStrictEqual(
            await dispenserAddressKey('Málaga', async () => null),
            await dispenserAddressKey('malaga', async () => undefined))
    })
})
