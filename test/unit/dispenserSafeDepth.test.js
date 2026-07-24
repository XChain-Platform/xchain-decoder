/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Pins DISPENSER_EXPIRE_SAFE_DEPTH >= the platform's deepest per-chain reorg
 * window + a safety margin. If a soft-expired dispenser is hard-purged
 * shallower than that window, a legal in-window reorg can no longer restore
 * it (deleteBlockByIndex matches zero rows) and the dispenser is permanently
 * lost on the reorged node. The deepest window is read from the canonical
 * xchain-utxo-tracker/src/undo-blocks.js when that sibling repo is checked
 * out (conformance read, skip-if-absent per the ConsensusPrimitiveConformance
 * convention), with a hand-copied floor kept as the always-on baseline.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XChainDecoder = require('../../src/XChainDecoder.js');

// Baseline floor (always asserted, even without the sibling checkout).
// Mirrors xchain-utxo-tracker/src/undo-blocks.js DEFAULT_UNDO_BLOCKS.
const DEEPEST_UNDO_WINDOW = 120; // DOGE (BTC 12 / LTC 48 / DOGE 120)

// Headroom above the deepest window so a small undo-window re-tune can never
// land exactly at the purge threshold. Matches the margin baked into
// DISPENSER_EXPIRE_SAFE_DEPTH (XChainDecoder.js).
const SAFETY_MARGIN = 6;

describe('DISPENSER_EXPIRE_SAFE_DEPTH', function () {
    it('is at least as deep as the deepest per-chain reorg window (DOGE = 120) + margin', function () {
        assert.ok(
            XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH >= DEEPEST_UNDO_WINDOW + SAFETY_MARGIN,
            `SAFE_DEPTH (${XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH}) must be >= ${DEEPEST_UNDO_WINDOW + SAFETY_MARGIN} ` +
            'so a soft-expired dispenser survives every in-window reorg with headroom'
        );
    });

    // CONFORMANCE: read the canonical per-chain undo windows instead of
    // trusting the hand-copied literal above, so raising any chain's window in
    // xchain-utxo-tracker fails this suite until the purge depth is re-bumped.
    // Skips when the sibling repo is not checked out (matching the existing
    // ActionManifestConformance / ConsensusPrimitiveConformance convention).
    describe('conformance to canonical undo-blocks.js', function () {
        const TRACKER = process.env.XCHAIN_UTXO_TRACKER_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-utxo-tracker');
        const UNDO = path.join(TRACKER, 'src', 'undo-blocks.js');
        before(function () { if (!fs.existsSync(UNDO)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-utxo-tracker sibling not found at ' + UNDO + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } });

        it('SAFE_DEPTH exceeds every canonical per-chain undo window by the margin', function () {
            const { DEFAULT_UNDO_BLOCKS } = require(UNDO);
            const deepest = Math.max(...Object.values(DEFAULT_UNDO_BLOCKS));
            assert.ok(
                XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH >= deepest + SAFETY_MARGIN,
                `SAFE_DEPTH (${XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH}) must be >= canonical deepest ` +
                `undo window (${deepest}) + margin (${SAFETY_MARGIN}); a chain's undo window was raised ` +
                'without bumping DISPENSER_EXPIRE_SAFE_DEPTH in XChainDecoder.js'
            );
        });

        it('the hand-copied baseline floor still matches the canonical deepest window', function () {
            const { DEFAULT_UNDO_BLOCKS } = require(UNDO);
            const deepest = Math.max(...Object.values(DEFAULT_UNDO_BLOCKS));
            assert.strictEqual(
                DEEPEST_UNDO_WINDOW, deepest,
                'update DEEPEST_UNDO_WINDOW in this test to match undo-blocks.js'
            );
        });
    });
});
