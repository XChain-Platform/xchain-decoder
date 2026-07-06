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
 * window. If a soft-expired dispenser is hard-purged shallower than that window,
 * a legal in-window reorg can no longer restore it (deleteBlockByIndex matches
 * zero rows) and the dispenser is permanently lost on the reorged node.
 */

'use strict';

const assert = require('assert');
const XChainDecoder = require('../../src/XChainDecoder.js');

// Mirrors xchain-utxo-tracker/src/undo-blocks.js DEFAULT_UNDO_BLOCKS. The purge
// depth must cover the deepest of these (DOGE = 120). Kept here as the assertion
// baseline so a future re-tune of any chain's window is caught.
const DEEPEST_UNDO_WINDOW = 120; // DOGE (BTC 12 / LTC 48 / DOGE 120)

describe('DISPENSER_EXPIRE_SAFE_DEPTH', function () {
    it('is at least as deep as the deepest per-chain reorg window (DOGE = 120)', function () {
        assert.ok(
            XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH >= DEEPEST_UNDO_WINDOW,
            `SAFE_DEPTH (${XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH}) must be >= ${DEEPEST_UNDO_WINDOW} so a soft-expired dispenser survives every in-window reorg`
        );
    });
});
