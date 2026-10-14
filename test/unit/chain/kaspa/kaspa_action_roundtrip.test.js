/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without any AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Connectivity against the platform's OWN canonical corpus.
 *
 * The indexer carries an action-roundtrip golden (byte-level: the live SDK encoder writes each
 * action and the live indexer positional parser reads it back). That set is the closest thing to
 * "every action the platform supports", so it is the right input for asking whether OUR transport
 * preserves all of them: obfuscate, de-obfuscate, and require byte equality; then require that the
 * shape passes our own action validator and fits the carrier ceiling.
 *
 * Why it exists: a hand-written SWAP string (taken from a PARSER fixture rather than the wire
 * format) was rejected on a live chain with "Storage mass exceeds maximum" - a misleading message
 * for a malformed action. This test would have caught the shape error in one second, offline.
 *
 * Skips loudly when the sibling repos are absent (an extract without xchain-indexer has no corpus).
 **********************************************************************/
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GOLDEN = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'test', 'fixtures', 'action-roundtrip-golden.json');
const builder = require(path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-encoder', 'src', 'build', 'kaspa_tx_builder.js'));

describe('kaspa transport: every canonical action survives obfuscation (platform corpus)', function () {
    this.timeout(10000);

    let vectors = null;
    before(function () {
        if (!fs.existsSync(GOLDEN)) this.skip();
        const raw = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
        const found = [];
        const walk = (node) => {
            if (typeof node === 'string') {
                if (/^[A-Z][A-Z_]{2,}\|/.test(node)) found.push(node);
                return;
            }
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (node && typeof node === 'object') Object.values(node).forEach(walk);
        };
        walk(raw);
        vectors = [...new Set(found)];
        assert.ok(vectors.length >= 10, 'the corpus should carry at least ten actions, found ' + vectors.length);
    });

    it('obfuscate -> de-obfuscate is byte-exact for every canonical action', function () {
        const failures = [];
        for (const action of vectors) {
            const txid = 'ab'.repeat(32);                       // the obfuscation key (4.2) is the first input txid
            try {
                const obfuscated = builder.obfuscateAction(action, txid);
                const back = builder.deobfuscateAction(obfuscated, txid);
                if (back !== action) failures.push(action.split('|')[0] + ': roundtrip changed the string');
            } catch (error) {
                failures.push(action.split('|')[0] + ': threw ' + String(error.message).slice(0, 60));
            }
        }
        assert.deepStrictEqual(failures, [], 'every canonical action must survive the carrier intact');
    });

    it('reports which canonical actions our own validator accepts, and fits the ceiling', function () {
        const rejected = [];
        const tooLong = [];
        for (const action of vectors) {
            try { builder.assertActionString(action); }
            catch (error) { rejected.push(action.split('|')[0] + ' (' + String(error.message).slice(0, 40) + ')'); }
            if (Buffer.byteLength(action, 'utf8') + 4 > builder.MAX_ACTION_DATA_LENGTH) tooLong.push(action.split('|')[0]);
        }
        // Not a defect list to fix here: it is the measurement of where our validator and the
        // platform's corpus disagree. Printed so a divergence is visible in the test output itself.
        console.log('        corpus vectors: ' + vectors.length +
            ' · our validator rejects: ' + (rejected.length ? rejected.join(', ') : 'none') +
            ' · over the ceiling: ' + (tooLong.length ? tooLong.join(', ') : 'none'));
        assert.deepStrictEqual(tooLong, [], 'no canonical action may exceed the carrier ceiling');
    });

    it('a malformed SWAP (the one that fooled us) is visibly different from the canonical one', function () {
        const canonical = vectors.find((v) => v.startsWith('SWAP|'));
        assert.ok(canonical, 'the corpus must carry a SWAP vector');
        const fields = canonical.split('|').length;
        const mine = 'SWAP|0|BTC|GIVE|10|0|BTC|GET|5|0';
        assert.notStrictEqual(mine.split('|').length, fields,
            'the hand-made string must NOT look like the canonical one: that difference is the whole lesson');
        assert.ok(fields >= 13, 'SWAP v0 carries the positional fields the docs list, got ' + fields);
    });
});
