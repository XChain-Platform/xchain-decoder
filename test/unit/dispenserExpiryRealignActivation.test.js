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

// DISPENSER_EXPIRY_REALIGN_ACTIVATION drift guard.
//
// The gate moves WHERE the decoder soft-expires open dispensers (block start -> block end),
// which changes the set of outputs persisted to transaction_outputs on any block whose header
// time first passes an expiration. That is consensus-affecting in both directions:
//   * arming it in the PAST rewrites agreed history, so a from-genesis re-decode stops matching
//     what the fleet wrote live;
//   * arming it on a network whose decoders are not all running the value forks the fleet at the
//     first boundary block.
// So the map is DISARMED (null) on mainnet and testnet until the operator ratifies a per-network
// instant, and the helper fails closed on anything that is not a number.
//
// Two tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. PIN  - the vendored map has the disarmed/genesis-on shape, in this repo alone.
//   2. DOCS - it is value-identical to the canonical map in
//             xchain-documentation/protocol/constants.js.
// Tier 2 skips when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { DISPENSER_EXPIRY_REALIGN_ACTIVATION,
        isDispenserExpiryRealignActive } = require('../../src/dispenserExpiryRealign.js');

const DOCS_CONSTANTS = process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

describe('DISPENSER_EXPIRY_REALIGN_ACTIVATION conformance', function () {

    it('keeps mainnet and testnet DISARMED and regtest genesis-on', function () {
        // Teeth for the ratification requirement: a number on mainnet/testnet means someone
        // armed a consensus boundary without the operator's ratified instant.
        assert.strictEqual(DISPENSER_EXPIRY_REALIGN_ACTIVATION.mainnet, null);
        assert.strictEqual(DISPENSER_EXPIRY_REALIGN_ACTIVATION.testnet, null);
        assert.strictEqual(DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest, 0);
    });

    it('is value-identical to the canonical map in xchain-documentation', function () {
        if (!siblingOrSkip(this, DOCS_CONSTANTS)) return;
        const canon = require(DOCS_CONSTANTS).DISPENSER_EXPIRY_REALIGN_ACTIVATION;
        assert.ok(canon && typeof canon === 'object',
            'xchain-documentation/protocol/constants.js must export DISPENSER_EXPIRY_REALIGN_ACTIVATION');
        assert.deepStrictEqual(
            { mainnet: DISPENSER_EXPIRY_REALIGN_ACTIVATION.mainnet,
              testnet: DISPENSER_EXPIRY_REALIGN_ACTIVATION.testnet,
              regtest: DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest },
            { mainnet: canon.mainnet, testnet: canon.testnet, regtest: canon.regtest },
            'the vendored map drifted from the canonical one; a one-sided flag-day edit forks ' +
            'the decoder fleet at the first boundary block');
    });

    it('a DISARMED network is inactive at every block time, including absurd ones', function () {
        assert.strictEqual(isDispenserExpiryRealignActive('mainnet', 0), false);
        assert.strictEqual(isDispenserExpiryRealignActive('mainnet', 1786060800), false);
        assert.strictEqual(isDispenserExpiryRealignActive('mainnet', 4000000000), false);
        assert.strictEqual(isDispenserExpiryRealignActive('testnet', 4000000000), false);
    });

    it('regtest is active from genesis so the venues exercise the realigned path', function () {
        assert.strictEqual(isDispenserExpiryRealignActive('regtest', 0), true);
        assert.strictEqual(isDispenserExpiryRealignActive('regtest', 1700000000), true);
    });

    it('fails closed on an unrecognized network name', function () {
        // An unknown network must read as "legacy block-start expiry", never as "no gate":
        // the latter would move a consensus measurement point on an unarmed chain.
        assert.strictEqual(isDispenserExpiryRealignActive('signet', 4000000000), false);
        assert.strictEqual(isDispenserExpiryRealignActive(undefined, 4000000000), false);
        assert.strictEqual(isDispenserExpiryRealignActive('', 4000000000), false);
    });

    it('fails closed on a non-finite block time', function () {
        assert.strictEqual(isDispenserExpiryRealignActive('regtest', NaN), false);
        assert.strictEqual(isDispenserExpiryRealignActive('regtest', undefined), false);
        assert.strictEqual(isDispenserExpiryRealignActive('regtest', 'not-a-time'), false);
    });

    it('flips exactly at the armed instant once a network IS armed (>= semantics)', function () {
        // The map is disarmed today, so arm a network in place for the length of this test and
        // drive the REAL helper (the module reads the map per call, so the mutation is visible).
        // This pins the boundary the operator will ratify onto: >=, so the block AT the instant
        // is already realigned, matching every protocol_changes gate.
        const ARMED = 1789430400;
        const saved = DISPENSER_EXPIRY_REALIGN_ACTIVATION.mainnet;
        DISPENSER_EXPIRY_REALIGN_ACTIVATION.mainnet = ARMED;
        try {
            assert.strictEqual(isDispenserExpiryRealignActive('mainnet', ARMED - 1), false,
                'the block below the instant stays legacy');
            assert.strictEqual(isDispenserExpiryRealignActive('mainnet', ARMED), true,
                'the block AT the instant is realigned');
            assert.strictEqual(isDispenserExpiryRealignActive('mainnet', ARMED + 1), true,
                'and it stays on above it');
        } finally {
            DISPENSER_EXPIRY_REALIGN_ACTIVATION.mainnet = saved;
        }
        assert.strictEqual(isDispenserExpiryRealignActive('mainnet', ARMED), false,
            'the map must be back to DISARMED after the probe');
    });
});
