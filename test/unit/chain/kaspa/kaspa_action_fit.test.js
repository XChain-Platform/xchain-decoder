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
 * FIT with the platform's own action wire: where our pre-flight agrees, and where it does not.
 *
 * The platform parses actions per action (xchain-indexer/src/actions/<name>/{validate,parse}.js) and
 * its repos are deliberately independent - the golden fixture itself says each repo pins its own half
 * "without a sibling checkout" - so importing their parser into the encoder would be the wrong kind of
 * coupling. What CAN be measured is agreement: their golden vectors are accepted by their parser by
 * construction (the fixture is a byte-level round trip), so anything we REJECT there is a divergence
 * on our side, and anything the CHAIN rejects while we accept it is a divergence on theirs.
 *
 * Both ground truths are in hand: the golden, and the live-chain refusal of a hand-made SWAP
 * ("Storage mass exceeds maximum" on testnet-10, expected to be a wire-format mistake).
 **********************************************************************/
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GOLDEN = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'test', 'fixtures', 'action-roundtrip-golden.json');
const builder = require(path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-encoder', 'src', 'build', 'kaspa_tx_builder.js'));

describe('kaspa fit: our pre-flight vs the platform action wire', function () {
    this.timeout(10000);

    let vectors = null;
    before(function () {
        if (!fs.existsSync(GOLDEN)) this.skip();
        const raw = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
        const found = [];
        const walk = (node) => {
            if (typeof node === 'string') { if (/^[A-Z][A-Z_]{2,}\|/.test(node)) found.push(node); return; }
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (node && typeof node === 'object') Object.values(node).forEach(walk);
        };
        walk(raw);
        vectors = [...new Set(found)];
    });

    it('accepts everything the platform round-trips (no divergence on their ground truth)', function () {
        const rejected = [];
        for (const action of vectors) {
            try { builder.assertActionString(action); } catch (error) { rejected.push(action.split('|')[0] + ': ' + error.message); }
        }
        assert.deepStrictEqual(rejected, [], 'our pre-flight must not refuse an action their parser accepts');
    });

    it('records the known divergence: a truncated SWAP we accept, which the live chain refused', function () {
        // Ground truth from testnet-10: this exact string was refused by the node's own build path and
        // ten out of ten retries failed, while the canonical SWAP|0 vector builds fine. So the chain
        // treats it as invalid; our pre-flight does not. Pinned as a DIVERGENCE, not as a pass - the
        // day we reuse (or mirror) the platform's per-action validator, this test should start failing
        // and be rewritten.
        const mine = 'SWAP|0|BTC|GIVE|10|0|BTC|GET|5|0';
        const canonical = vectors.find((v) => v.startsWith('SWAP|'));
        assert.ok(canonical, 'the corpus must carry SWAP');
        const acceptedByUs = (() => { try { builder.assertActionString(mine); return true; } catch (e) { return false; } })();
        assert.strictEqual(acceptedByUs, true,
            'if we ever start refusing it, this divergence is closed - rewrite this test');
        assert.notStrictEqual(mine, canonical,
            'and it is genuinely different from the canonical vector (that difference is the lesson)');
    });

    it('the four rules our pre-flight actually enforces, read from the code', function () {
        // Read off kaspa_tx_builder.js:120-131 rather than assumed: non-empty, contains a pipe,
        // assembled payload within the ceiling, printable ASCII. There is deliberately NO name-shape
        // rule and NO per-action grammar - the platform's per-action parsers own that.
        assert.throws(() => builder.assertActionString(''), /empty/, 'empty is not an action');
        assert.throws(() => builder.assertActionString('SEND'), /separator/, 'a pipe is required');
        assert.throws(() => builder.assertActionString('SEND|0|' + String.fromCharCode(10) + 'x'), /printable/, 'control bytes are out');
        const huge = 'SEND|0|X|' + 'x'.repeat(builder.MAX_ACTION_DATA_LENGTH);
        assert.throws(() => builder.assertActionString(huge), /too long/, 'the assembled ceiling is ours to enforce');
        // And the accepted side, recorded so nobody "fixes" it later: a lowercase name and a short
        // trailing form both pass here, because the wire authority is the indexer's positional parser.
        assert.doesNotThrow(() => builder.assertActionString('lowercase|0|x'));
        assert.doesNotThrow(() => builder.assertActionString('SEND|0|XCHAIN|1'));
    });
});
