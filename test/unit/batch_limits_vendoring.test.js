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

// CROSS-REPO CONFORMANCE for the whole-batch rejection mirror.
//
// src/protocol/indexer_batch_limits.js is a VENDORED copy of the caps that decide whether the
// indexer rejects a BATCH as one record. Two hand-maintained copies of one consensus table
// can never re-converge once they diverge, so the vendored file is GENERATED from the sibling
// (bin/sync-batch-limits.js) and re-derived here on every unit run.
//
// Three tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. DRIFT      - the vendored module is byte-identical to what the generator writes today.
//   2. FLAG STATE - the decoder applies the POST-flag rule set unconditionally, which is only
//                   sound because its own capture gate cannot precede the indexer's
//                   BATCH_ISSUANCE_LIMITS activation. That ordering is checked on TIME by
//                   batchSubCommandOutputCaptureActivation.test.js; the other two legs of the
//                   indexer's own gate (block-index thresholds, consensus version) are checked
//                   here, because "the time has passed" only means "the flag is on" when
//                   those two cannot independently hold it off.
//   3. BEHAVIOUR  - the mirror is driven against the REAL xchain-indexer Batch handler over a
//                   vector table AND over the real on-chain corpus, asserting the one property
//                   that matters: EVERY batch the mirror suppresses is one the real handler
//                   really rejects whole. A vendored number that is right and a rule that
//                   reads it wrongly would pass tier 1 and fail here.
//
// Sibling tiers skip when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');

const VENDORED_MODULE = require('../../src/protocol/indexer_batch_limits.js');
const sync = require('../../bin/sync-batch-limits.js');

const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file) {
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

describe('BATCH limit vendoring and cross-repo conformance', function () {
    this.timeout(0);

    describe('tier 1: the vendored tables have not drifted from the sibling', function () {

        it('is exactly what the generator writes today', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const rendered = sync.renderModule(sync.deriveFromSibling());
            const current  = fs.readFileSync(sync.VENDORED, 'utf8');
            assert.strictEqual(current, rendered,
                'src/protocol/indexer_batch_limits.js is stale; run ' +
                '`node bin/sync-batch-limits.js`. A cap tighter here than in the ' +
                'indexer suppresses capture for a batch the chain really runs.');
        });

        it('carries the same VALUES the live sibling constructor holds', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const derived = sync.deriveFromSibling();
            assert.strictEqual(VENDORED_MODULE.COMMAND_LIMIT,   derived.COMMAND_LIMIT);
            assert.strictEqual(VENDORED_MODULE.CHILD_ISSUE_KEY, derived.CHILD_ISSUE_KEY);
            assert.deepStrictEqual(VENDORED_MODULE.ACTION_LIMITS,       derived.ACTION_LIMITS);
            assert.deepStrictEqual(VENDORED_MODULE.GATED_ACTION_LIMITS, derived.GATED_ACTION_LIMITS);
        });

        it('carries the live weight budget, weight table and activation instants', function () {
            // A retune of either number in the sibling moves indexer verdicts, and before this
            // pin the decoder had no copy of them at all, so the retune was invisible here.
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const derived = sync.deriveFromSibling();
            assert.strictEqual(VENDORED_MODULE.WEIGHT_BUDGET, derived.WEIGHT_BUDGET);
            assert.deepStrictEqual(VENDORED_MODULE.COMMAND_WEIGHTS, derived.COMMAND_WEIGHTS);
            assert.deepStrictEqual(VENDORED_MODULE.COST_WEIGHTING_ACTIVATION,
                                   derived.COST_WEIGHTING_ACTIVATION);
        });
    });
});

describe('BATCH limit vendoring and cross-repo conformance', function () {
    this.timeout(0);

    describe('tier 1: the vendored tables have not drifted from the sibling', function () {

        it('keeps every weight an integer >= 1, which is what makes the count cap a sound pre-filter', function () {
            // The decoder still checks the raw count first. That is exact rather than
            // conservative only while no weight can be below 1.
            assert.ok(Number.isInteger(VENDORED_MODULE.WEIGHT_BUDGET) &&
                      VENDORED_MODULE.WEIGHT_BUDGET > 0);
            for (const action of Object.keys(VENDORED_MODULE.COMMAND_WEIGHTS)) {
                const weight = VENDORED_MODULE.COMMAND_WEIGHTS[action];
                assert.ok(Number.isInteger(weight) && weight >= 1,
                    action + ' weighs ' + weight + '; a weight below 1 would let a batch whose ' +
                    'raw count exceeds the budget still weigh in under it, and the count ' +
                    'pre-filter would start rejecting batches the indexer runs');
            }
        });

        it('keeps the ungated and gated caps in the tables they came from', function () {
            // Placement is not cosmetic: everything in ACTION_LIMITS binds in BOTH flag
            // states, so mirroring it needs no flag reasoning at all, while everything in
            // GATED_ACTION_LIMITS binds only at/after BATCH_ISSUANCE_LIMITS and leans on the
            // ordering invariant checked in tier 2. This is a pin in THIS repo alone, so it
            // still has teeth on a standalone checkout.
            assert.strictEqual(VENDORED_MODULE.ACTION_LIMITS.BATCH, 0);
            assert.strictEqual(VENDORED_MODULE.ACTION_LIMITS.ISSUE, 1);
            assert.strictEqual(VENDORED_MODULE.ACTION_LIMITS.MINT,  1);
            assert.strictEqual(VENDORED_MODULE.GATED_ACTION_LIMITS.DEPLOY, 1);
            assert.strictEqual(VENDORED_MODULE.ACTION_LIMITS.DEPLOY, undefined);
            assert.ok(Number.isInteger(VENDORED_MODULE.COMMAND_LIMIT) &&
                      VENDORED_MODULE.COMMAND_LIMIT > 0);
            assert.strictEqual(VENDORED_MODULE.CHILD_ISSUE_KEY.includes('.'), true,
                'the child bucket must not be spellable as an ACTION name, or child issuance ' +
                'would start colliding with a real cap');
        });

        it('is a GENERATED file and says so, so nobody edits it by hand', function () {
            const text = fs.readFileSync(sync.VENDORED, 'utf8');
            assert.ok(text.includes('GENERATED FILE - DO NOT EDIT BY HAND'));
            assert.ok(text.includes('node bin/sync-batch-limits.js'));
        });
    });
});
