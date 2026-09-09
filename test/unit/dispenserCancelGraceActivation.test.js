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

// DISPENSER_CANCEL_GRACE_ACTIVATION drift guard, plus the two cross-repo invariants the
// grace constant depends on.
//
// The gate widens the block loop's payment-capture address set by a grace window past a
// dispenser's expiration, which changes the set of outputs persisted to transaction_outputs.
// That is consensus-affecting in both directions:
//   * arming it in the PAST rewrites agreed history, so a from-genesis re-decode stops
//     matching what the fleet wrote live;
//   * arming it on a network whose decoders are not all running the value forks the fleet at
//     the first block that passes a cancelled dispenser's expiration.
// mainnet is ARMED AT GENESIS (instant 0) by the 2026-09-09 ruling. Arming it there rewrites
// nothing: the indexed mainnet history holds 0 dispensers and 0 dispenses (measured
// 2026-09-09), so the widened capture set admits no output the unwidened one missed. The helper
// still fails closed on anything that is not a number, which is what the null sentinel remains
// for on any network that has not armed.
//
// Two tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. PIN  - the vendored map has the genesis-on shape on every network, in this repo alone.
//   2. DOCS - it is value-identical to the canonical map in
//             xchain-documentation/protocol/constants.js.
// Tier 2 skips when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { DISPENSER_CANCEL_GRACE_ACTIVATION,
        DISPENSER_CANCEL_GRACE_SECONDS,
        isDispenserCancelGraceActive,
        cancelGraceFloor } = require('../../src/dispenserCancelGrace.js');
const XChainDecoder = require('../../src/XChainDecoder.js');

const DOCS_CONSTANTS = process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const INDEXER_CONFIG = path.join(INDEXER_DIR, 'src', 'config.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

// The indexer pins DISPENSER_CLOSE_DELAY as a literal in a config builder that wants a live
// environment, so read the assignment out of the source rather than executing the module.
function indexerCloseDelay(){
    const src = fs.readFileSync(INDEXER_CONFIG, 'utf8');
    const m = src.match(/config\['DISPENSER_CLOSE_DELAY'\]\s*=\s*(\d+)\s*;/);
    assert.ok(m, 'xchain-indexer/src/config.js must assign a numeric DISPENSER_CLOSE_DELAY');
    return Number(m[1]);
}

describe('DISPENSER_CANCEL_GRACE_ACTIVATION conformance', function () {

    it('arms mainnet at genesis by the 2026-09-09 ruling, with testnet and regtest genesis-on', function () {
        // Teeth for the ruling: mainnet sits at instant 0, which is identity on the indexed
        // mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09). Any other mainnet
        // value re-introduces a boundary block the fleet could split on, so it fails here.
        assert.strictEqual(DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet, 0);
        assert.strictEqual(DISPENSER_CANCEL_GRACE_ACTIVATION.testnet, 0);
        assert.strictEqual(DISPENSER_CANCEL_GRACE_ACTIVATION.regtest, 0);
    });

    it('mainnet carries the grace from block time 0 upward, floor and all', function () {
        // The behaviour the arm buys: every mainnet block, the genesis instant included, keeps
        // a just-expired dispenser in the capture set for one grace window, so a cancelled
        // dispenser can never take a payment the decoder drops.
        assert.strictEqual(isDispenserCancelGraceActive('mainnet', 0), true);
        assert.strictEqual(isDispenserCancelGraceActive('mainnet', 1786060800), true);
        assert.strictEqual(isDispenserCancelGraceActive('mainnet', 4000000000), true);
        assert.strictEqual(cancelGraceFloor('mainnet', 4000000000),
            4000000000 - DISPENSER_CANCEL_GRACE_SECONDS);
    });

    it('is value-identical to the canonical map in xchain-documentation', function () {
        if (!siblingOrSkip(this, DOCS_CONSTANTS)) return;
        const canon = require(DOCS_CONSTANTS).DISPENSER_CANCEL_GRACE_ACTIVATION;
        assert.ok(canon && typeof canon === 'object',
            'xchain-documentation/protocol/constants.js must export DISPENSER_CANCEL_GRACE_ACTIVATION');
        assert.deepStrictEqual(
            { mainnet: DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet,
              testnet: DISPENSER_CANCEL_GRACE_ACTIVATION.testnet,
              regtest: DISPENSER_CANCEL_GRACE_ACTIVATION.regtest },
            { mainnet: canon.mainnet, testnet: canon.testnet, regtest: canon.regtest },
            'the vendored map drifted from the canonical one; a one-sided flag-day edit forks ' +
            'the decoder fleet at the first block that passes a cancelled dispenser expiration');
    });

    it('a DISARMED (null) network is inactive at every block time, including absurd ones', function () {
        // No network carries the null sentinel now that mainnet is armed, so disarm one in
        // place for the length of this test and drive the REAL helper. A `time >= null`
        // coercion would read 0 and widen the capture set from genesis on a network whose
        // fleet never armed it, which is the failure this pins.
        const saved = DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet;
        DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet = null;
        try {
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', 0), false);
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', 1786060800), false);
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', 4000000000), false);
            assert.strictEqual(cancelGraceFloor('mainnet', 4000000000), null);
        } finally {
            DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet = saved;
        }
        assert.strictEqual(DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet, 0,
            'the map must be back to the genesis arm after the probe');
    });

    it('testnet and regtest are active from genesis', function () {
        assert.strictEqual(isDispenserCancelGraceActive('testnet', 0), true);
        assert.strictEqual(isDispenserCancelGraceActive('regtest', 1700000000), true);
    });

    it('fails closed on an unrecognized network name', function () {
        // An unknown network must read as "no grace", never as "no gate": the latter would
        // widen the persisted output set on an unarmed chain.
        assert.strictEqual(isDispenserCancelGraceActive('signet', 4000000000), false);
        assert.strictEqual(isDispenserCancelGraceActive(undefined, 4000000000), false);
        assert.strictEqual(isDispenserCancelGraceActive('', 4000000000), false);
        assert.strictEqual(cancelGraceFloor('signet', 4000000000), null);
    });

    it('fails closed on a non-finite block time', function () {
        assert.strictEqual(isDispenserCancelGraceActive('regtest', NaN), false);
        assert.strictEqual(isDispenserCancelGraceActive('regtest', undefined), false);
        assert.strictEqual(isDispenserCancelGraceActive('regtest', 'not-a-time'), false);
        assert.strictEqual(cancelGraceFloor('regtest', NaN), null);
    });

    it('flips exactly at the armed instant when a network is armed mid-chain (>= semantics)', function () {
        // Mainnet arms at 0, so move it to a mid-chain instant for the length of this test and
        // drive the REAL helper (the module reads the map per call, so the mutation is
        // visible). This pins the boundary semantics any later arm inherits: >=, so the block
        // AT the instant already carries the grace, matching every protocol_changes gate.
        const ARMED = 1789430400;
        const saved = DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet;
        DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet = ARMED;
        try {
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', ARMED - 1), false,
                'the block below the instant keeps the unwidened capture set');
            assert.strictEqual(cancelGraceFloor('mainnet', ARMED - 1), null);
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', ARMED), true,
                'the block AT the instant already carries the grace');
            assert.strictEqual(cancelGraceFloor('mainnet', ARMED),
                ARMED - DISPENSER_CANCEL_GRACE_SECONDS);
            assert.strictEqual(isDispenserCancelGraceActive('mainnet', ARMED + 1), true);
        } finally {
            DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet = saved;
        }
        assert.strictEqual(DISPENSER_CANCEL_GRACE_ACTIVATION.mainnet, 0,
            'the map must be back to the genesis arm after the probe');
        assert.strictEqual(isDispenserCancelGraceActive('mainnet', ARMED - 1), true,
            'and the restored genesis arm covers the block the probe held below its instant');
    });

    it('the floor is exactly one grace window below the block time', function () {
        // The floor is the whole consensus decision: two nodes reading the same header time
        // must load the same capture set, so it is a pure subtraction and nothing else.
        assert.strictEqual(cancelGraceFloor('regtest', 1700000000),
            1700000000 - DISPENSER_CANCEL_GRACE_SECONDS);
        assert.strictEqual(cancelGraceFloor('regtest', 0), -DISPENSER_CANCEL_GRACE_SECONDS);
    });
});

describe('DISPENSER_CANCEL_GRACE_SECONDS cross-repo invariants', function () {

    it('covers the indexer cancellation grace period', function () {
        // The invariant the whole fix rests on. The indexer stops matching a cancelled
        // dispenser at cancel time + DISPENSER_CLOSE_DELAY, and a valid cancel always precedes
        // the dispenser's own expiration, so a grace of at least the close delay covers every
        // block in which the indexer can still settle a fill. A shorter grace reopens the
        // funds-loss window silently, because the arithmetic keeps working.
        if (!siblingOrSkip(this, INDEXER_CONFIG)) return;
        const closeDelay = indexerCloseDelay();
        assert.ok(
            DISPENSER_CANCEL_GRACE_SECONDS >= closeDelay,
            `DISPENSER_CANCEL_GRACE_SECONDS (${DISPENSER_CANCEL_GRACE_SECONDS}) must be >= the ` +
            `indexer DISPENSER_CLOSE_DELAY (${closeDelay}); the indexer was retuned without ` +
            'following it in src/dispenserCancelGrace.js'
        );
    });

    it('holds the hand-pinned close delay the constant is set from', function () {
        // Baseline that fires even without the sibling checkout: the constant is pinned EQUAL
        // to the indexer's delay, not merely above it, because every extra second is capture
        // the indexer discards.
        assert.strictEqual(DISPENSER_CANCEL_GRACE_SECONDS, 3600);
    });

    it('the hard purge cannot reclaim a row that is still inside the grace window', function () {
        // purgeExpiredDispensers hard-deletes a row 126 blocks (DISPENSER_EXPIRE_SAFE_DEPTH)
        // after the block that stamped it. A row purged while still inside its grace window
        // would drop out of the widened capture set early, so the depth has to outlast the
        // grace on the FASTEST chain the platform decodes. Purge is keyed on block HEIGHT, so
        // even a burst that outran this stays deterministic across nodes; the margin is what
        // keeps the grace from being cosmetic on DOGE.
        const FASTEST_TARGET_SPACING = 60;   // DOGE (BTC 600 / LTC 150 / DOGE 60)
        const purgeSpan = XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH * FASTEST_TARGET_SPACING;
        assert.ok(
            purgeSpan > DISPENSER_CANCEL_GRACE_SECONDS,
            `the purge span (${purgeSpan}s at target spacing) must exceed the grace window ` +
            `(${DISPENSER_CANCEL_GRACE_SECONDS}s), or a cancelled dispenser is hard-deleted ` +
            'before the indexer stops matching it'
        );
    });
});
