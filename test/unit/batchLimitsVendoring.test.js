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
// src/protocol/indexerBatchLimits.js is a VENDORED copy of the caps that decide whether the
// indexer rejects a BATCH as one record. Two hand-maintained copies of one consensus table
// can never re-converge once they diverge, so the vendored file is GENERATED from the sibling
// (test/tools/sync-batch-limits.js) and re-derived here on every unit run.
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
const path   = require('path');

const VENDORED_MODULE = require('../../src/protocol/indexerBatchLimits.js');
const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        hasProvablyRejectedBatch,
        subCommandLimitKey,
        subCommandTick,
        CHILD_ISSUE_KEY } = require('../../src/batchSubCommandCapture.js');
const ACTION_ALIASES = require('../../src/actionAliases.js');
const sync = require('../tools/sync-batch-limits.js');

const CORPUS = require('../fixtures/regtestBatchCorpus.json');

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
//     the native lane is its documented first exit.
//   * getTickerId -> one id per DISTINCT tick STRING. That is the boundary case for the MINT
//     mirror: it makes the real handler's per-distinct-token count equal the mirror's
//     per-identical-string count, so the two must agree exactly. The OPPOSITE case (two
//     spellings of one token) is driven separately below, where the mirror is expected to
//     stay silent and the handler to reject.
function realBatch(opts) {
    opts = opts || {};
    const Batch           = require(sync.INDEXER_BATCH);
    const Utility         = require(path.join(path.dirname(path.dirname(sync.INDEXER_BATCH)), 'utility.js'));
    const ProtocolChanges = require(sync.INDEXER_CHANGES);

    const util = new Utility({ config: {}, indexerDb: {}, decoderDb: {}, util: {} });
    util.addAddressTicker      = () => {};
    util.detectFeePaymentMode  = () => 'native';

    const changes = new ProtocolChanges({
        config:    { NETWORK: 'regtest' },
        util:      util,
        decoderDb: { getBlockTime: async () => T0 },
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

describe('BATCH limit vendoring and cross-repo conformance', function () {
    this.timeout(0);

    // -------------------------------------------------------------------------------------
    describe('tier 1: the vendored tables have not drifted from the sibling', function () {

        it('is exactly what the generator writes today', function () {
            if (!siblingOrSkip(this, sync.INDEXER_BATCH)) return;
            const rendered = sync.renderModule(sync.deriveFromSibling());
            const current  = fs.readFileSync(sync.VENDORED, 'utf8');
            assert.strictEqual(current, rendered,
                'src/protocol/indexerBatchLimits.js is stale; run ' +
                '`node test/tools/sync-batch-limits.js`. A cap tighter here than in the ' +
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
            assert.ok(text.includes('node test/tools/sync-batch-limits.js'));
        });
    });

    // -------------------------------------------------------------------------------------
    describe('tier 2: the post-flag rule set is the only one this decoder can ever see', function () {

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

    // -------------------------------------------------------------------------------------
    describe('tier 3: driven against the REAL indexer Batch handler', function () {

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
                'the mirror stopped catching vectors it used to; re-derive before lowering this');
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
            const { isLegacyActionFormat } = require('../../src/batchSubCommandCapture.js');
            const util = realBatch().util;
            for (const params of [['0'], [0], [''], ['1'], ['99'], ['100'], ['abc'],
                                  ['JDOG.1'], [undefined], [null], ['0.5'], [' 0'], ['-1']])
                assert.strictEqual(isLegacyActionFormat(params), util.isLegacyActionFormat(params),
                    'diverged on ' + JSON.stringify(params));
        });
    });
});
