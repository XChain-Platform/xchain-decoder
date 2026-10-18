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

const UNARMED = 9999999999;
const MINIMUM_BLOCK_TIME = 1000000000;

function assertMainnetUnarmedTestnetArmable(map, label) {
    assert.strictEqual(map.mainnet, UNARMED, `${label}.mainnet must remain unarmed`);
    assert.strictEqual(map.regtest, 0, `${label}.regtest must be genesis-active`);
    assert.ok(map.testnet === UNARMED || (
        Number.isFinite(map.testnet) &&
        Number.isInteger(map.testnet) &&
        map.testnet >= MINIMUM_BLOCK_TIME &&
        map.testnet < UNARMED
    ), `${label}.testnet must be unarmed or an integer block-time instant`);
}

module.exports = { assertMainnetUnarmedTestnetArmable };
