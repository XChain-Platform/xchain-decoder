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

const { captureCommands } = require('../../../src/protocol/batch_sub_command_capture.js');

const PINNED_MAINNET_ACTIVATION = 1786838400;
const BELOW_MAINNET_GATE = PINNED_MAINNET_ACTIVATION - 1;

describe('capture command view', function () {

    it('is the action string itself below the gate, for a BATCH and for anything else', function () {
        // Pre-flag-day mainnet history: the view is the top-level string, so a from-genesis
        // re-decode reproduces the output set the fleet wrote live, byte for byte.
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc', 'mainnet', BELOW_MAINNET_GATE),
            ['BATCH|0|COINPAY|0|1|abc']);
        assert.deepStrictEqual(captureCommands('COINPAY|0|1|abc', 'mainnet', BELOW_MAINNET_GATE),
            ['COINPAY|0|1|abc']);
    });

    it('is the action string itself above the gate for a non-BATCH', function () {
        assert.deepStrictEqual(captureCommands('COINPAY|0|1|abc', 'regtest', 0),
            ['COINPAY|0|1|abc']);
        assert.deepStrictEqual(captureCommands('DISPENSER|0|BTC', 'regtest', 0),
            ['DISPENSER|0|BTC']);
    });

    it('is the sub-command list above the gate for a BATCH', function () {
        assert.deepStrictEqual(captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'regtest', 0),
            ['COINPAY|0|1|abc', 'SEND|0|BTC']);
    });

    it('flips to the sub-command list on mainnet at its ratified instant', function () {
        // The armed half of the same boundary, on the network the arming is about: one second
        // below the instant a batched COINPAY is still invisible to capture, and at it the
        // settlement sub-command is what capture sees.
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'mainnet',
                PINNED_MAINNET_ACTIVATION - 1),
            ['BATCH|0|COINPAY|0|1|abc;SEND|0|BTC']);
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'mainnet',
                PINNED_MAINNET_ACTIVATION),
            ['COINPAY|0|1|abc', 'SEND|0|BTC']);
    });
});
