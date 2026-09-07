'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 *   regenerate: node test/tools/sync-batch-limits.js
 *   drift gate: test/unit/batchLimitsVendoring.test.js (re-derives and compares on every
 *               unit run; skips only when the sibling checkout is absent, and
 *               XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure)
 *
 * SOURCE OF TRUTH: xchain-indexer/src/actions/batch.js, read by instantiating the real Batch
 * class. These are the tables whose breach makes the indexer reject a BATCH AS A WHOLE, so
 * that not one of its sub-commands runs. The decoder mirrors them to stop capturing outputs
 * for commands nothing will execute (batchSubCommandCapture.hasProvablyRejectedBatch).
 *
 * THE DIRECTION OF ERROR IS NOT SYMMETRIC, which is why this file is generated rather than
 * typed: a cap that is TIGHTER here than in the indexer suppresses capture for a batch the
 * chain really runs, and a missed settlement output is a payment that is never recognised.
 * A cap that is LOOSER here merely leaves today's over-capture open for that shape.
 *
 ********************************************************************/

// Global per-BATCH command cap. Breached => 'invalid: COMMAND (limit)', whole batch.
// GATED on BATCH_ISSUANCE_LIMITS in the indexer; see the module header of
// batchSubCommandCapture.js for why that flag is provably active wherever the decoder's
// own capture gate is.
const COMMAND_LIMIT = 250;

// Per-ACTION caps in force in BOTH flag states (indexer: this.actionLimits).
// 0 means the ACTION may not appear in a BATCH at all.
const ACTION_LIMITS = {
    "BATCH": 0,
    "ISSUE": 1,
    "MINT": 1,
};

// Per-ACTION caps that arrive WITH BATCH_ISSUANCE_LIMITS (indexer: this.gatedActionLimits),
// merged over ACTION_LIMITS at/after that flag-day.
const GATED_ACTION_LIMITS = {
    "DEPLOY": 1,
};

// The non-ACTION bucket a dotted-TICK (child) ISSUE is counted under at/after
// BATCH_ISSUANCE_LIMITS, so child issuance is exempt from the top-level ISSUE cap.
const CHILD_ISSUE_KEY = "ISSUE.CHILD";

// Weighted per-BATCH cost budget (indexer: this.weightBudget), which REPLACES the flat
// command cap at/after BATCH_COST_WEIGHTING. Breached => 'invalid: COMMAND (limit)', the
// same string, whole batch.
const WEIGHT_BUDGET = 250;

// Per-ACTION cost weights (indexer: this.commandWeights). An ACTION absent from this table
// weighs the DEFAULT of 1, which is every ordinary action.
const COMMAND_WEIGHTS = {
    "AIRDROP": 25,
    "DEPLOY": 30,
    "DIVIDEND": 25,
    "EXECUTE": 30,
    "XEXEC": 30,
};

// Per-network BATCH_COST_WEIGHTING activation instants (block TIME, >=), read off the
// sibling's protocol-change registry. Unlike BATCH_ISSUANCE_LIMITS this flag is NOT provably
// on wherever the decoder's capture gate is: mainnet capture is armed while this instant is
// still the house sentinel. null means DISARMED, which is inactive at every block time.
const COST_WEIGHTING_ACTIVATION = {
    "mainnet": 9999999999,
    "testnet": 0,
    "regtest": 0,
};

module.exports = {
    COMMAND_LIMIT,
    ACTION_LIMITS,
    GATED_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
    WEIGHT_BUDGET,
    COMMAND_WEIGHTS,
    COST_WEIGHTING_ACTIVATION,
};
