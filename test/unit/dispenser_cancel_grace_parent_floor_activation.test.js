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

const activation = require('../../src/protocol/constants/activation.js');
const constants = require('../../src/protocol/constants.js');

const NAME = 'DISPENSER_CANCEL_GRACE_PARENT_FLOOR_ACTIVATION';

describe('DISPENSER_CANCEL_GRACE_PARENT_FLOOR_ACTIVATION conformance', function () {

    it('keeps mainnet and testnet inert while regtest is genesis-active', function () {
        assert.deepStrictEqual(activation[NAME], {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('is re-exported by the public constants module', function () {
        assert.ok(activation[NAME]);
        assert.strictEqual(constants[NAME], activation[NAME]);
    });
});
