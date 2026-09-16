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

const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        captureCommands,
        subCommandLimitKey,
        COMMAND_LIMIT,
        CHILD_ISSUE_KEY } = require('../../../src/protocol/batch_sub_command_capture.js');
const ACTION_ALIASES = require('../../../src/protocol/action_aliases.js');
const { T0 } = require('../../helpers/batchCaptureHarness.js');

const CORPUS = require('../../fixtures/regtestBatchCorpus.json');

const BELOW_MAINNET_GATE =
    typeof BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet === 'number'
        ? BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet - 1
        : 4000000000;

describe('BATCH whole-batch rejection: the rest of the class', function () {
    // -------------------------------------------------------------------------------------
    // The real thing, not a fixture written to match the code: every DISTINCT `BATCH|%`
    // payload on the live BTC regtest decoder chain at the time of writing.
    describe('the real on-chain corpus', function () {

        it('is a real corpus, not an empty one', function () {
            assert.ok(CORPUS.length >= 55, 'corpus shrank: re-pull it rather than lowering this');
            assert.ok(CORPUS.every(d => typeof d === 'string' && d.startsWith('BATCH|')));
        });

        it('suppresses only batches the indexer really rejects whole, and says how many', function () {
            const suppressed = [];
            const captured   = [];
            for (const payload of CORPUS) {
                const view = captureCommands(payload, 'regtest', T0);
                (view.length === 0 ? suppressed : captured).push(payload);
            }
            // Every suppressed payload must carry a cause this module can name. If one ever
            // cannot, the mirror has started suppressing on something it has not proved,
            // which is the money-bearing direction.
            for (const payload of suppressed) {
                const subCommands = payload.slice('BATCH|0|'.length).split(';');
                const causes = [];
                if (subCommands.length > COMMAND_LIMIT)                       causes.push('command cap');
                if (subCommands.some(c => c.split('|')[0] === ''))            causes.push('empty name');
                if (subCommands.some(c => c.split('|')[0] === 'BATCH'))       causes.push('nested BATCH');
                const top = subCommands.filter(c =>
                    subCommandLimitKey(c, ACTION_ALIASES) === 'ISSUE').length;
                if (top > 1)                                                  causes.push('ISSUE cap');
                assert.ok(causes.length > 0,
                    'suppressed a payload with no provable cause: ' + payload.slice(0, 120));
            }
            assert.strictEqual(suppressed.length + captured.length, CORPUS.length);
            assert.ok(suppressed.length > 0 && captured.length > 0,
                'a corpus that is all one way proves nothing about the other');
        });
    });
});

describe('BATCH whole-batch rejection: the rest of the class', function () {
    describe('the real on-chain corpus', function () {
        it('never suppresses a batch whose ISSUEs are all dotted children', function () {
            // The under-capture control against real payloads: the exemption is what most of
            // this corpus depends on, so a naive `ISSUE: 1` mirror would suppress them.
            let exempted = 0;
            for (const payload of CORPUS) {
                const subCommands = payload.slice('BATCH|0|'.length).split(';');
                const keys = subCommands.map(c => subCommandLimitKey(c, ACTION_ALIASES));
                const children = keys.filter(k => k === CHILD_ISSUE_KEY).length;
                const top      = keys.filter(k => k === 'ISSUE').length;
                if (children < 1 || top > 1) continue;
                exempted++;
                if (subCommands.length > COMMAND_LIMIT || keys.includes('')) continue;
                assert.strictEqual(captureCommands(payload, 'regtest', T0).length,
                    subCommands.length,
                    'a many-child batch must keep its full command view: ' + payload.slice(0, 90));
            }
            assert.ok(exempted >= 15,
                'the exemption should cover a large share of the real corpus (measured 21 of ' +
                '67); if this collapses, re-measure before weakening it');
        });

        it('is byte-identical below the gate, every payload', function () {
            for (const payload of CORPUS)
                assert.deepStrictEqual(captureCommands(payload, 'mainnet', BELOW_MAINNET_GATE),
                    [payload]);
        });
    });
});
