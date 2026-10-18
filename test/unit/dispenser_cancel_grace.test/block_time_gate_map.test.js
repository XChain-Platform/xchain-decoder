'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const {
    assertMainnetUnarmedTestnetArmable,
} = require('../../helpers/block_time_gate_map.js');

const UNARMED = 9999999999;

function map(overrides = {}) {
    return {
        mainnet: UNARMED,
        testnet: UNARMED,
        regtest: 0,
        ...overrides,
    };
}

describe('block-time gate map assertion', function () {

    it('accepts the shipped unarmed map', function () {
        assert.doesNotThrow(() => assertMainnetUnarmedTestnetArmable(map(), 'gate'));
    });

    it('accepts an armed testnet block-time instant', function () {
        assert.doesNotThrow(() => assertMainnetUnarmedTestnetArmable(
            map({ testnet: 1760700000 }), 'gate'
        ));
    });

    it('refuses an armed mainnet', function () {
        assert.throws(() => assertMainnetUnarmedTestnetArmable(
            map({ mainnet: 1760700000 }), 'gate'
        ), /gate\.mainnet must remain unarmed/);
    });

    it('refuses a nonzero regtest', function () {
        assert.throws(() => assertMainnetUnarmedTestnetArmable(
            map({ regtest: 1 }), 'gate'
        ), /gate\.regtest must be genesis-active/);
    });

    it('refuses a height-sized testnet value', function () {
        assert.throws(() => assertMainnetUnarmedTestnetArmable(
            map({ testnet: 900000 }), 'gate'
        ), /gate\.testnet must be unarmed or an integer block-time instant/);
    });
});
