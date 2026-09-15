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
const path   = require('path');
const VENDORED_MODULE = require('../../../src/protocol/indexer_batch_limits.js');
const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        hasProvablyRejectedBatch,
        captureCommands,
        batchCostWeight,
        subCommandCostWeight,
        subCommandLimitKey,
        subCommandTick,
        isBatchCostWeightingActive,
        CHILD_ISSUE_KEY } = require('../../../src/protocol/batch_sub_command_capture.js');
const ACTION_ALIASES = require('../../../src/protocol/action_aliases.js');
const sync = require('../../../bin/sync-batch-limits.js');
const CORPUS = require('../../fixtures/regtestBatchCorpus.json');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
const T0 = 1700000000;
function siblingOrSkip(ctx, file) {
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}
// A real xchain-indexer Batch handler, wired to the REAL Utility and the REAL ProtocolChanges
// registry, with only the database and the dispatch stubbed out.
//
// What is stubbed and why it does not weaken the comparison:
//   * isActionAllowed -> true. Address-sleep state is one of the causes deliberately NOT
//     mirrored, so holding it off keeps the comparison about the causes that ARE.
//   * detectFeePaymentMode -> 'native'. The aggregate gas pre-check is likewise not mirrored;
//     the native path is its documented first exit.
//   * getTickerId -> one id per DISTINCT tick STRING. That is the boundary case for the MINT
//     mirror: it makes the real handler's per-distinct-token count equal the mirror's
//     per-identical-string count, so the two must agree exactly. The OPPOSITE case (two
//     spellings of one token) is driven separately below, where the mirror is expected to
//     stay silent and the handler to reject.
function realBatch(opts) {
    opts = opts || {};
    const Batch           = require(sync.INDEXER_BATCH);
    // From the checkout root, not from the handler path: the handler is one directory deeper
    // once the indexer splits it into src/actions/batch/, and walking up from it lands in
    // src/actions/ instead of src/.
    const Utility         = require(path.join(sync.INDEXER_ROOT, 'src', 'utility.js'));
    const ProtocolChanges = require(sync.INDEXER_CHANGES);
    const util = new Utility({ config: {}, indexerDb: {}, decoderDb: {}, util: {} });
    util.addAddressTicker      = () => {};
    util.detectFeePaymentMode  = () => 'native';
    // Network and block time are overridable so the weight-budget cases can drive the SAME
    // handler where BATCH_COST_WEIGHTING is armed and where it is not.
    const blockTime = (opts.blockTime === undefined) ? T0 : opts.blockTime;
    const changes = new ProtocolChanges({
        config:    { NETWORK: opts.network || 'regtest' },
        util:      util,
        decoderDb: { getBlockTime: async () => blockTime },
    });
    const ids = opts.tickIds || new Map();
    let nextId = 1000;
    const indexerDb = {
        suppressIndexIdCreation: false,
        async createBatch() {},
        async isActionAllowed() { return true; },
        async getTokenInfo() { return null; },
        async getTickerId(tick) {
            if (!ids.has(tick)) ids.set(tick, nextId++);
            return ids.get(tick);
        },
        async getAddressBalances() { return []; },
        async createActionIndex() { return 1; },
    };
    return new Batch({
        config:          { GAS: 'XCHAIN' },
        decoderDb:       {},
        indexerDb:       indexerDb,
        util:            util,
        mapper:          { async createMappings() {} },
        protocolChanges: changes,
        actionAliases:   Object.assign({}, ACTION_ALIASES),
        async processAction() {},
    });
}
// The real handler's verdict for one wire payload. Returns the STATUS string.
async function indexerStatus(wire, opts) {
    const batch = realBatch(opts);
    const data = {
        TX_DATA:     wire,
        FORMAT:      0,
        BLOCK_INDEX: 10,
        ACTION_INDEX: 5,
        SOURCE:      'bcrt1qbatchsource',
        IS_GENESIS:  false,
        IS_EMISSION: false,
        TX_OUTPUTS:  [],
    };
    const log = console.log;
    console.log = () => {};
    try {
        await batch.parse(String(wire).split('|').slice(1), data, false);
    } finally {
        console.log = log;
    }
    return data['STATUS'];
}
const subCommandsOf = (wire) => wire.slice('BATCH|0|'.length).split(';');
const mirrorRejects = (wire) => hasProvablyRejectedBatch(subCommandsOf(wire), ACTION_ALIASES);
// Vectors chosen to cover every mirrored cause, every cause deliberately NOT mirrored, and
// the shapes that must stay VALID. `expect` is what the real handler is expected to say; it
// is asserted, so a vector that stops meaning what it was written to mean fails loudly rather
// than silently weakening the comparison.
const VECTORS = [
    // --- mirrored: rejected whole -------------------------------------------------------
    { wire: 'BATCH|0|COINPAY|0|1;BATCH|0|SEND|0|a',            reject: true },
    { wire: 'BATCH|0|ISSUE|0|AAA|1;ISSUE|0|BBB|1',             reject: true },
    { wire: 'BATCH|0|ISSUE|0|^614.1|1;ISSUE|0|^614.2|1',       reject: true },
    { wire: 'BATCH|0|ISSUE|0;ISSUE|0|BBB|1',                   reject: true },
    { wire: 'BATCH|0|DEPLOY|0|a;DEPLOY|0|b',                   reject: true },
    { wire: 'BATCH|0|MINT|0|PEPE|1|a;MINT|0|PEPE|2|a',         reject: true },
    { wire: 'BATCH|0|MINT|0| PEPE |1|a;MINT|0|PEPE|2|a',       reject: true },
    { wire: 'BATCH|0|COINPAY|0|1;',                            reject: true },
    { wire: 'BATCH|0|ISSUE|JDOG|1;ISSUE|AAA|1',                reject: true },
    // --- valid: the mirror must stay silent ---------------------------------------------
    { wire: 'BATCH|0|COINPAY|0|1;SEND|0|BTC|TICK|1|addr',      reject: false },
    { wire: 'BATCH|0|ISSUE|0|JDOG|1;ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1', reject: false },
    { wire: 'BATCH|0|ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1',       reject: false },
    { wire: 'BATCH|0|ISSUE|JDOG|1000;ISSUE|JDOG.1|1000',       reject: false },
    { wire: 'BATCH|0|DEPLOY|0|a;SEND|0|BTC|TICK|1|addr',       reject: false },
    { wire: 'BATCH|0|MINT|0|PEPE|1|a;MINT|0|WOJAK|2|a',        reject: false },
    // --- rejected for a cause deliberately NOT mirrored ---------------------------------
    { wire: 'BATCH|0|COINPAY|0|1;NOT_AN_ACTION|0|x',           reject: true,  unmirrored: true },
    { wire: 'BATCH|0|issue|0|AAA|1;issue|0|BBB|1',             reject: true,  unmirrored: true },
];
// The weight budget, driven on BOTH sides of its own flag. Every wire here is under
// the 250-COUNT cap, so nothing in the pre-weighting rule set can explain a rejection:
// the only thing that moves is the summed weight.
const WEIGHT_VECTORS = [
    { name: '9x EXECUTE + SEND', weight: 271,
      wire: 'BATCH|0|SEND|0|BTC|TICK|1|addr;' +
            Array.from({ length: 9 }, () => 'EXECUTE|0|1|a').join(';') },
    { name: '11x AIRDROP', weight: 275,
      wire: 'BATCH|0|' +
            Array.from({ length: 11 }, () => 'AIRDROP|0|BTC|TICK|1|a').join(';') },
];
const UNDER_BUDGET = [
    { name: '8x EXECUTE + SEND', weight: 241,
      wire: 'BATCH|0|SEND|0|BTC|TICK|1|addr;' +
            Array.from({ length: 8 }, () => 'EXECUTE|0|1|a').join(';') },
    { name: '10x AIRDROP', weight: 250,
      wire: 'BATCH|0|' +
            Array.from({ length: 10 }, () => 'AIRDROP|0|BTC|TICK|1|a').join(';') },
];
// Above mainnet capture, which since the 2026-09-09 genesis arm is also above the
// point where the indexer's own weight budget becomes reachable (its BATCH_COST_
// WEIGHTING verdict is read only inside the BATCH_ISSUANCE_LIMITS guard, and that
// gate's mainnet instant is the capture instant). Both sides weigh here.
const MAINNET_LIVE = 1800000000;
// Inside the inverted window instead: the weighting instant is 0 so the vendored
// gate reads active, but capture is off here and the indexer applies no bound.
const MAINNET_WINDOW = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet - 1;

const OUTER_TITLE = 'BATCH limit vendoring and cross-repo conformance';
const TIER_TITLE = 'tier 3: driven against the REAL indexer Batch handler';

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('suppresses an over-budget batch on regtest, where the handler rejects it whole', async function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            for (const vector of WEIGHT_VECTORS) {
                assert.strictEqual(subCommandsOf(vector.wire).length <= VENDORED_MODULE.COMMAND_LIMIT,
                    true, vector.name + ' must stay under the COUNT cap or it proves nothing');
                assert.strictEqual(
                    batchCostWeight(subCommandsOf(vector.wire), ACTION_ALIASES), vector.weight);
                const status = await indexerStatus(vector.wire, { network: 'regtest', blockTime: 0 });
                assert.strictEqual(status, 'invalid: COMMAND (limit)',
                    vector.name + ': premise wrong, the real handler said ' + status);
                assert.deepStrictEqual(captureCommands(vector.wire, 'regtest', 0), [],
                    vector.name + ' still captures on regtest; the weight budget is not mirrored');
            }
        });

        it('still captures an over-budget batch inside the inverted MAINNET window', async function () {
            // The under-capture control, re-aimed at the window the 2026-09-09 genesis arm
            // opened. Mainnet BATCH_COST_WEIGHTING is 0, so the vendored gate reads
            // active below the capture instant; the real handler applies NO bound there,
            // because it reads that verdict only inside its BATCH_ISSUANCE_LIMITS guard and
            // that gate arms at the capture instant. This is the case that would lose a
            // settlement output if the mirror ever suppressed on the weighting instant alone.
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            for (const vector of WEIGHT_VECTORS) {
                const status = await indexerStatus(vector.wire,
                    { network: 'mainnet', blockTime: MAINNET_WINDOW });
                assert.strictEqual(status, 'valid',
                    vector.name + ': premise wrong, mainnet handler said ' + status +
                    ' inside the window; the budget is no longer nested under BATCH_ISSUANCE_LIMITS');
                // Capture is off here, so the mirror hands back the un-expanded batch rather
                // than suppressing it. Nothing the handler dispatches is dropped.
                assert.deepStrictEqual(captureCommands(vector.wire, 'mainnet', MAINNET_WINDOW),
                    [vector.wire],
                    'UNDER-CAPTURE on mainnet: the mirror suppressed ' + vector.name +
                    ' inside the window, which the real handler dispatches in full');
            }
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('and agrees with the handler ABOVE the shared instant, where both weigh', async function () {
            // The other side of the same boundary, and the state mainnet is actually in
            // today. Once capture is on, BATCH_ISSUANCE_LIMITS is on too, so the indexer's
            // budget is reachable and both sides must reach the same verdict. Without this
            // the case above would also pass if the mirror had simply stopped suppressing.
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            for (const vector of WEIGHT_VECTORS) {
                const status = await indexerStatus(vector.wire,
                    { network: 'mainnet', blockTime: MAINNET_LIVE });
                assert.strictEqual(status, 'invalid: COMMAND (limit)',
                    vector.name + ': the mainnet handler said ' + status + ' above the ' +
                    'capture instant, where the weight budget is reachable');
                assert.deepStrictEqual(captureCommands(vector.wire, 'mainnet', MAINNET_LIVE), [],
                    'OVER-CAPTURE on mainnet: the mirror captured ' + vector.name +
                    ', which the real handler rejects whole');
            }
        });

        it('leaves a batch AT the budget alone on both networks', async function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            for (const vector of UNDER_BUDGET) {
                assert.strictEqual(
                    batchCostWeight(subCommandsOf(vector.wire), ACTION_ALIASES), vector.weight);
                assert.strictEqual(await indexerStatus(vector.wire, { network: 'regtest', blockTime: 0 }),
                    'valid', vector.name + ': premise wrong on regtest');
                assert.strictEqual(captureCommands(vector.wire, 'regtest', 0).length,
                    subCommandsOf(vector.wire).length,
                    'UNDER-CAPTURE: ' + vector.name + ' weighs exactly the budget and is valid');
            }
        });

        it('under-charges DEPLOY rather than guessing its format, which is the safe direction', async function () {
            // The indexer charges DEPLOY 30 and discounts a format-4 chunk carrier to 1. This
            // module reads no FORMAT, so it charges 1 for both: an UNDER-estimate bounded at 29
            // by the one-DEPLOY-per-batch cap. Charging 30 would suppress a batch carrying a
            // chunk carrier the indexer runs.
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            assert.strictEqual(VENDORED_MODULE.COMMAND_WEIGHTS.DEPLOY, 30,
                'the sibling stopped weighting DEPLOY at 30; re-derive the discount argument');
            assert.strictEqual(subCommandCostWeight('DEPLOY|0|code', ACTION_ALIASES), 1);
            assert.strictEqual(subCommandCostWeight('DEPLOY|4|chunk', ACTION_ALIASES), 1);
            assert.strictEqual(VENDORED_MODULE.GATED_ACTION_LIMITS.DEPLOY, 1,
                'the per-batch DEPLOY cap is what bounds the under-estimate at 29');
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('agrees with it on every vector, and never suppresses a batch it accepts', async function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            let mirrored = 0;
            for (const vector of VECTORS) {
                const status = await indexerStatus(vector.wire);
                const rejected = (status !== 'valid');
                assert.strictEqual(rejected, vector.reject,
                    'vector premise wrong for ' + vector.wire + ': handler said ' + status);
                const suppressed = mirrorRejects(vector.wire);
                // THE SAFETY PROPERTY. Everything else here is coverage.
                if (suppressed)
                    assert.ok(rejected,
                        'UNDER-CAPTURE: the mirror suppressed a batch the real handler ' +
                        'accepts (' + vector.wire + ' -> ' + status + ')');
                if (vector.unmirrored)
                    assert.strictEqual(suppressed, false,
                        vector.wire + ' is rejected for a cause this mirror deliberately does ' +
                        'not carry; suppressing it would mean the mirror grew a rule nobody ' +
                        'argued for');
                else
                    assert.strictEqual(suppressed, rejected,
                        'the mirror must match the handler on ' + vector.wire);
                if (suppressed) mirrored++;
            }
            assert.ok(mirrored >= 9,
                'the mirror catches too few vectors; re-derive before lowering this');
        });

        it('never suppresses a real on-chain batch the handler accepts', async function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            let suppressed = 0, captured = 0;
            for (const payload of CORPUS) {
                const mirror = mirrorRejects(payload);
                if (!mirror) { captured++; continue; }
                suppressed++;
                const status = await indexerStatus(payload);
                assert.notStrictEqual(status, 'valid',
                    'UNDER-CAPTURE on a REAL on-chain payload: ' + payload.slice(0, 120) +
                    ' -> ' + status);
            }
            assert.strictEqual(suppressed + captured, CORPUS.length);
            assert.ok(suppressed > 0 && captured > 0,
                'a corpus that is all one way proves nothing about the other');
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('stays silent where it cannot prove distinctness, and the handler does not', async function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            // Two SPELLINGS of one token. The handler resolves both to one id and rejects; the
            // mirror compares literal strings, cannot see it, and says nothing. That is the
            // declared one-sidedness of the MINT mirror, driven rather than asserted in prose.
            const wire = 'BATCH|0|MINT|0|JDOG|1|a;MINT|0|^614|2|a';
            const ids  = new Map([['JDOG', 614], ['^614', 614]]);
            assert.strictEqual(await indexerStatus(wire, { tickIds: ids }), 'invalid: MINT (limit)');
            assert.strictEqual(mirrorRejects(wire), false,
                'the mirror must not guess toward suppression: over-capture here is the safe ' +
                'direction and closing it needs a tick resolver the decoder does not have');
        });

        it('classifies every ISSUE exactly as the handler does, over a cross-product', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const batch  = realBatch();
            const heads  = ['ISSUE|0', 'ISSUE|', 'ISSUE|1', 'ISSUE|99', 'ISSUE|abc', 'ISSUE'];
            const ticks  = ['JDOG', 'JDOG.1', 'JDOG.1.2', '^614', '^614.5', '.LEAD', 'TRAIL.',
                            '', ' JDOG.1 ', '__proto__', 'constructor', '1000'];
            const tails  = ['', '|1000', '|1000|addr'];
            let checked = 0, children = 0;
            for (const head of heads) for (const tick of ticks) for (const tail of tails) {
                const command = head + '|' + tick + tail;
                const theirs  = batch.classifyLimitAction('ISSUE', command, true);
                const ours    = subCommandLimitKey(command, ACTION_ALIASES);
                assert.strictEqual(ours, theirs,
                    'classification diverged on ' + JSON.stringify(command) +
                    ': mirror ' + String(ours) + ', handler ' + String(theirs));
                checked++;
                if (theirs === CHILD_ISSUE_KEY) children++;
            }
            assert.ok(checked > 200 && children > 0,
                'the cross-product must actually reach the exempt branch, or it proves nothing');
        });
    });
});

describe(OUTER_TITLE, function () {
    this.timeout(0);

    describe(TIER_TITLE, function () {

        it('reads every MINT TICK exactly as the handler does, over the same cross-product', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const batch = realBatch();
            const heads = ['MINT|0', 'MINT|', 'MINT|1', 'MINT|abc', 'MINT'];
            const ticks = ['PEPE', ' PEPE ', '^614', '', '__proto__', '1000'];
            const tails = ['', '|1', '|1|addr'];
            let checked = 0;
            for (const head of heads) for (const tick of ticks) for (const tail of tails) {
                const command = head + '|' + tick + tail;
                assert.strictEqual(subCommandTick('MINT', command),
                                   batch.subCommandTick('MINT', command, true),
                                   'TICK read diverged on ' + JSON.stringify(command));
                checked++;
            }
            assert.ok(checked > 60);
        });

        it('mirrors util.isLegacyActionFormat, which decides where the TICK sits', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const { isLegacyActionFormat } = require('../../../src/protocol/batch_sub_command_capture.js');
            const util = realBatch().util;
            for (const params of [['0'], [0], [''], ['1'], ['99'], ['100'], ['abc'],
                                  ['JDOG.1'], [undefined], [null], ['0.5'], [' 0'], ['-1']])
                assert.strictEqual(isLegacyActionFormat(params), util.isLegacyActionFormat(params),
                    'diverged on ' + JSON.stringify(params));
        });
    });
});
