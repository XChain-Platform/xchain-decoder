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
 * xchain-utxo-tracker/src/chain/undo_blocks.js when that sibling repo is checked
 * out (conformance read, skip-if-absent per the ConsensusPrimitiveConformance
 * convention), with a hand-copied floor kept as the always-on baseline.
 * It also pins the tracker's network-specific safe ceiling to the decoder resolver,
 * which the one-directional runtime warning in resolveUndoBlocks() cannot do.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XChainDecoder = require('../../src/XChainDecoder.js');

// Baseline floor (always asserted, even without the sibling checkout).
// Mirrors xchain-utxo-tracker/src/chain/undo_blocks.js DEFAULT_UNDO_BLOCKS.
const DEFAULT_UNDO_WINDOW = 120;

// Headroom above the deepest window so a small undo-window re-tune can never
// land exactly at the purge threshold. Matches the margin baked into
// DISPENSER_EXPIRE_SAFE_DEPTH (XChainDecoder.js).
const SAFETY_MARGIN = 6;

describe('DISPENSER_EXPIRE_SAFE_DEPTH', function () {
    it('raises only litecoin testnet to the 5000-block window plus margin', function () {
        assert.strictEqual(XChainDecoder.resolveDispenserExpireSafeDepth('LTC', 'testnet'), 5006);
        assert.strictEqual(XChainDecoder.resolveDispenserExpireSafeDepth('LTC', 'mainnet'), 126);
        assert.strictEqual(XChainDecoder.resolveDispenserExpireSafeDepth('LTC', 'regtest'), 126);
        assert.strictEqual(XChainDecoder.resolveDispenserExpireSafeDepth('BTC', 'testnet'), 126);
    });

    // CONFORMANCE: read the canonical per-chain undo windows instead of
    // trusting the hand-copied literal above, so raising any chain's window in
    // xchain-utxo-tracker fails this suite until the purge depth is re-bumped.
    // Skips when the sibling repo is not checked out (matching the existing
    // ActionManifestConformance / ConsensusPrimitiveConformance convention).
    describe('conformance to canonical undo_blocks.js', function () {
        const TRACKER = process.env.XCHAIN_UTXO_TRACKER_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-utxo-tracker');
        const UNDO = path.join(TRACKER, 'src', 'chain', 'undo_blocks.js');
        before(function () { if (!fs.existsSync(UNDO)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-utxo-tracker sibling not found at ' + UNDO + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } });

        it('SAFE_DEPTH exceeds every canonical per-chain undo window by the margin', function () {
            const { DEFAULT_UNDO_BLOCKS } = require(UNDO);
            const cases = [
                ['BTC', 'mainnet'], ['BTC', 'testnet'], ['BTC', 'regtest'],
                ['LTC', 'mainnet'], ['LTC', 'testnet'], ['LTC', 'regtest'],
                ['DOGE', 'mainnet'], ['DOGE', 'testnet'], ['DOGE', 'regtest']
            ];
            for (const [coin, network] of cases) {
                const window = DEFAULT_UNDO_BLOCKS[coin + '_' + network.toUpperCase()];
                const safeDepth = XChainDecoder.resolveDispenserExpireSafeDepth(coin, network);
                assert.ok(safeDepth >= window + SAFETY_MARGIN,
                    `${coin}/${network} SAFE_DEPTH (${safeDepth}) must be >= undo window (${window}) + margin (${SAFETY_MARGIN})`);
            }
        });

        it('the hand-copied standard floor still matches the unchanged mainnet window', function () {
            const { DEFAULT_UNDO_BLOCKS } = require(UNDO);
            assert.strictEqual(
                DEFAULT_UNDO_WINDOW, DEFAULT_UNDO_BLOCKS.LTC_MAINNET,
                'update DEFAULT_UNDO_WINDOW in this test to match the unchanged mainnet window'
            );
        });

        // Pins the tracker's hand-mirrored ceiling to the decoder's constant in BOTH
        // directions. resolveUndoBlocks() only warns when the resolved window EXCEEDS
        // The tracker ceiling warning is one-directional, so lowering the decoder depth alone is silent
        // at runtime; this equality is the only thing that catches it.
        it('tracker LTC testnet ceiling equals the decoder LTC testnet depth', function () {
            const { safeUndoBlocksCeiling } = require(UNDO);
            const decoderDepth = XChainDecoder.resolveDispenserExpireSafeDepth('LTC', 'testnet');
            assert.strictEqual(
                safeUndoBlocksCeiling('litecoin-testnet'), decoderDepth,
                `tracker safe ceiling (${safeUndoBlocksCeiling('litecoin-testnet')}) must EQUAL ` +
                `decoder SAFE_DEPTH (${decoderDepth}); ` +
                'a split lets the decoder abort reorg recovery at one depth while the tracker auto-recovers to another'
            );
        });
    });
});
