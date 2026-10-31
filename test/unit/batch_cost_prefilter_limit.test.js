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

// The whole-batch COUNT pre-filter must use the limit the indexer uses, which is the weight
// budget once BATCH_COST_WEIGHTING is active and the command cap below it.
//
// The two vendored constants are equal today, so nothing built from the real module can tell
// the two limits apart. These cases load batch_cost.js against a substituted limits module
// whose budget sits ABOVE the command cap, the retune the indexer's limits.js keeps open. A
// pre-filter pinned to the command cap would then suppress batches the indexer dispatches,
// which is under-capture, the money-bearing direction.

const assert = require('assert');
const Module = require('module');

const LIMITS_PATH = require.resolve('../../src/protocol/indexer_batch_limits.js');
const COST_PATH   = require.resolve('../../src/protocol/batch_sub_command_capture/batch_cost.js');
const ACTION_ALIASES = require('../../src/protocol/action_aliases.js');

// n SENDs: weight 1 each, no per-ACTION cap of their own.
const filler = (n) => Array.from({ length: n }, (_, i) => 'SEND|0|BTC|TICK|1|addr' + i);

describe('BATCH count pre-filter follows the weight budget when weighting is active', function () {
    const saved = {};
    let real, cost, budget;

    before(function () {
        real = require(LIMITS_PATH);
        saved.limits = require.cache[LIMITS_PATH];
        saved.cost   = require.cache[COST_PATH];
        budget = real.COMMAND_LIMIT + 50;
        const substitute = new Module(LIMITS_PATH, null);
        substitute.filename = LIMITS_PATH;
        substitute.loaded   = true;
        substitute.exports  = Object.assign({}, real, { WEIGHT_BUDGET: budget });
        require.cache[LIMITS_PATH] = substitute;
        delete require.cache[COST_PATH];
        cost = require(COST_PATH);
    });

    after(function () {
        require.cache[LIMITS_PATH] = saved.limits;
        if (saved.cost) require.cache[COST_PATH] = saved.cost;
        else delete require.cache[COST_PATH];
    });

    it('loads the substituted budget and uses a filler with no cap or weight of its own', function () {
        assert.strictEqual(real.WEIGHT_BUDGET, real.COMMAND_LIMIT,
            'the real constants diverged; re-derive why this file substitutes them');
        for (const table of [real.ACTION_LIMITS, real.GATED_ACTION_LIMITS, real.COMMAND_WEIGHTS])
            assert.strictEqual(Object.prototype.hasOwnProperty.call(table, 'SEND'), false,
                'SEND gained a cap or weight; pick another filler');
        assert.strictEqual(cost.isBatchCostWeightingActive('regtest', 1), true);
        assert.strictEqual(cost.batchCostWeight(filler(budget), ACTION_ALIASES), budget);
    });

    it('does not suppress a batch over the command cap but within the budget', function () {
        const commands = filler(real.COMMAND_LIMIT + 1);
        assert.strictEqual(cost.hasProvablyRejectedBatch(commands, ACTION_ALIASES, 'regtest', 1), false,
            'UNDER-CAPTURE: the count pre-filter used the command cap while weighting is active');
        assert.strictEqual(cost.hasProvablyRejectedBatch(filler(budget), ACTION_ALIASES, 'regtest', 1),
            false, 'a batch exactly at the budget is valid');
    });

    it('suppresses a batch one command over the budget when weighting is active', function () {
        assert.strictEqual(
            cost.hasProvablyRejectedBatch(filler(budget + 1), ACTION_ALIASES, 'regtest', 1), true);
    });

    it('keeps the command cap when network and block time are omitted', function () {
        assert.strictEqual(
            cost.hasProvablyRejectedBatch(filler(real.COMMAND_LIMIT + 1), ACTION_ALIASES), true,
            'callers that omit network and time must keep the pre-weighting cap');
    });
});
