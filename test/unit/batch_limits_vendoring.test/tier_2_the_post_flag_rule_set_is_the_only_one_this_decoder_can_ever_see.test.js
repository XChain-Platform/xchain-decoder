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
const fs     = require('fs');

const VENDORED_MODULE = require('../../../src/protocol/indexer_batch_limits.js');
const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        captureCommands,
        isBatchCostWeightingActive } = require('../../../src/protocol/batch_sub_command_capture.js');
const sync = require('../../../bin/sync-batch-limits.js');

const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// One over-budget wire the gate blocks can drive without reaching into tier 3's vectors:
// 10 sub-commands, well under the 250-COUNT cap, weighing 271 against the 250 budget, so
// only the WEIGHT budget can ever suppress it. Same shape as tier 3's '9x EXECUTE + SEND'.
const WEIGHT_PROBE = 'BATCH|0|SEND|0|BTC|TICK|1|addr;' +
    Array.from({ length: 9 }, () => 'EXECUTE|0|1|a').join(';');

function siblingOrSkip(ctx, file) {
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

const OUTER_TITLE = 'BATCH limit vendoring and cross-repo conformance';
const TIER_TITLE = 'tier 2: the post-flag rule set is the only one this decoder can ever see';

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('registers BATCH_ISSUANCE_LIMITS with no block-index threshold of its own', function () {
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            const { change } = sync.issuanceLimitsChange('regtest');
            assert.ok(change, 'BATCH_ISSUANCE_LIMITS must be registered in the sibling');
            // The capture gate is ordered against the flag's TIME. A non-zero BLOCK threshold
            // could hold the flag off past that instant, and the decoder would then apply a
            // rule set the indexer has not, suppressing batches it dispatches.
            for (const network of ['mainnet', 'testnet', 'regtest'])
                assert.strictEqual(change[network + '_block'], 0,
                    network + ' BATCH_ISSUANCE_LIMITS grew a block-index threshold; the ' +
                    'decoder orders its capture gate on TIME alone, so this breaks the ' +
                    'argument that the flag is on wherever capture runs');
        });

        it('registers it at or below the indexer compiled consensus version', function () {
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            const { change, consensusVersion } = sync.issuanceLimitsChange('regtest');
            const current = consensusVersion.split('.').map(Number);
            const at      = [change.version_major, change.version_minor, change.version_revision];
            const ordered = (at[0] !== current[0]) ? at[0] < current[0]
                          : (at[1] !== current[1]) ? at[1] < current[1]
                          : at[2] <= current[2];
            assert.ok(ordered,
                'BATCH_ISSUANCE_LIMITS is registered at ' + at.join('.') + ' but the indexer ' +
                'compiles ' + consensusVersion + ': the version leg of isEnabled would hold ' +
                'the flag off, and the decoder would be applying the post-flag rule set alone');
        });

        it('never arms capture before the flag on any armed network (the load-bearing order)', function () {
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                const gate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[network];
                if (gate === null) continue;
                const { change } = sync.issuanceLimitsChange(network);
                assert.ok(gate >= change[network + '_time'],
                    network + ': capture (' + gate + ') must not begin before ' +
                    'BATCH_ISSUANCE_LIMITS (' + change[network + '_time'] + '), or the 250-command ' +
                    'cap and the DEPLOY cap would be enforced here and nowhere else');
            }
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('registers BATCH_COST_WEIGHTING with no block-index threshold, so a TIME mirror is sound', function () {
            // The decoder mirrors this flag on block TIME alone. isEnabled ANDs a block-index
            // leg onto that, so a non-zero threshold could hold the flag off past its instant
            // while the decoder already applied the budget: suppression where the indexer
            // dispatches, the money-bearing direction.
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            const { change } = sync.costWeightingChange();
            assert.ok(change, 'BATCH_COST_WEIGHTING must be registered in the sibling');
            for (const network of ['mainnet', 'testnet', 'regtest'])
                assert.strictEqual(change[network + '_block'], 0,
                    network + ' BATCH_COST_WEIGHTING grew a block-index threshold that the ' +
                    'vendored instant map cannot express');
        });

        it('registers it at or below the indexer compiled consensus version', function () {
            // Same AND: the version leg could hold the flag off after its instant.
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            const { change, consensusVersion } = sync.costWeightingChange();
            const current = consensusVersion.split('.').map(Number);
            const at      = [change.version_major, change.version_minor, change.version_revision];
            const ordered = (at[0] !== current[0]) ? at[0] < current[0]
                          : (at[1] !== current[1]) ? at[1] < current[1]
                          : at[2] <= current[2];
            assert.ok(ordered,
                'BATCH_COST_WEIGHTING is registered at ' + at.join('.') + ' but the indexer ' +
                'compiles ' + consensusVersion + ': the version leg of isEnabled would hold ' +
                'the flag off while the decoder applied the budget');
        });

        it('carries the weighting instants the sibling registers, per network', function () {
            if (!siblingOrSkip(this, sync.INDEXER_CHANGES)) return;
            const { change } = sync.costWeightingChange();
            for (const network of ['mainnet', 'testnet', 'regtest'])
                assert.strictEqual(VENDORED_MODULE.COST_WEIGHTING_ACTIVATION[network],
                    change[network + '_time'],
                    network + ': the vendored weighting instant drifted from the sibling. ' +
                    'EARLIER here than there means the decoder suppresses capture for batches ' +
                    'the indexer still dispatches');
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('never applies the budget where the indexer would not: capture is the narrower gate', function () {
            // The ordering that protects the money-bearing direction, re-derived after the
            // 2026-09-09 genesis arm moved mainnet weighting from the house sentinel to 0.
            //
            // The old shape of this test pinned "mainnet capture is armed and mainnet
            // weighting is not", which was true and is not any more. What replaces it is
            // stronger, because it holds in the direction that costs money rather than
            // merely being a fact about two numbers:
            //
            //   * the indexer's budget is a strict refinement of BATCH_ISSUANCE_LIMITS.
            //     src/actions/batch.js reads its BATCH_COST_WEIGHTING verdict ONLY inside
            //     `if(limitsActive)` blocks, so below that gate's mainnet instant no bound
            //     runs at all, whatever the weighting instant says;
            //   * this decoder cannot suppress there either, because captureCommands exits
            //     with the un-expanded passthrough while the CAPTURE gate is inactive, and
            //     mainnet capture arms at that same instant.
            //
            // So the window where the vendored weighting instant reads "on" but the indexer
            // applies no budget is exactly the window where this module captures nothing to
            // suppress. Under-capture, the direction that loses a settlement output, is
            // impossible in it. Both halves are driven, not asserted about the constants.
            const captureGate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet;
            const weightGate  = VENDORED_MODULE.COST_WEIGHTING_ACTIVATION.mainnet;
            if (captureGate === null || typeof weightGate !== 'number') return;

            assert.ok(weightGate <= captureGate,
                'mainnet weighting (' + weightGate + ') arms AFTER capture (' + captureGate +
                '); a batch could then be captured with the budget still off here while the ' +
                'indexer applied it, which is over-capture in the other direction');

            // Inside the window: the vendored weighting gate reads active, and capture does
            // not, so no batch reaches the budget.
            const inside = captureGate - 1;
            assert.strictEqual(isBatchCostWeightingActive('mainnet', inside), true,
                'the vendored mainnet weighting instant is 0, so it must read active below capture');
            assert.deepStrictEqual(
                captureCommands(WEIGHT_PROBE, 'mainnet', inside), [WEIGHT_PROBE],
                'capture must still be OFF inside the window: an over-budget batch that ' +
                'reached the budget here would be suppressed while the indexer dispatched it');

            // At and above the instant both gates are on together, which is the state the
            // tier 3 block drives against the real handler.
            assert.strictEqual(isBatchCostWeightingActive('mainnet', captureGate), true);
            assert.deepStrictEqual(captureCommands(WEIGHT_PROBE, 'mainnet', captureGate), [],
                'at the shared instant the mirror must suppress the over-budget batch, ' +
                'because the indexer rejects it there');
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('testnet and regtest have no such window: capture and weighting both arm at genesis', function () {
            // The two networks the window argument does not need, pinned so a future
            // per-network re-pin cannot open one quietly.
            for (const network of ['testnet', 'regtest']) {
                const captureGate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[network];
                const weightGate  = VENDORED_MODULE.COST_WEIGHTING_ACTIVATION[network];
                assert.strictEqual(captureGate, 0, network + ' capture is no longer genesis-active');
                assert.strictEqual(weightGate, 0, network + ' weighting is no longer genesis-active');
                assert.strictEqual(isBatchCostWeightingActive(network, 0), true,
                    network + ' must weigh from block 0');
                assert.deepStrictEqual(captureCommands(WEIGHT_PROBE, network, 0), [],
                    network + ' must suppress the over-budget batch from block 0');
            }
        });
    });
});
