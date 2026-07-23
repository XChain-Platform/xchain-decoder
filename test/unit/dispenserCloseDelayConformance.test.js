'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DISPENSER_CLOSE_DELAY drift guard . The decoder hardcodes a twin of the
// indexer's DISPENSER_CLOSE_DELAY (xchain-indexer/src/config.js) so its
// open-dispenser view closes a cancelled dispenser at exactly the height the
// indexer does (cancel_block_time + delay). A change to either side alone would
// silently desynchronize the two views across the cancelling window. This guard
// asserts, in this repo's own unit suite:
//   1. PIN      - the decoder constant equals the pinned protocol value (3600),
//                 so a decoder-only edit fails even in a standalone checkout.
//   2. PARITY   - when the sibling xchain-indexer checkout is present, the
//                 decoder constant equals the value the indexer's getConfig()
//                 actually resolves (checked per coin/network on regtest+testnet),
//                 so an indexer-only config change fails this suite too.
// When the sibling is absent (standalone deploy) the parity tier skips rather
// than fails, matching coins-conformance.test.js; set XCHAIN_REQUIRE_SIBLINGS=1
// in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { DISPENSER_CLOSE_DELAY } = require('../../src/XChainDecoder');

// Pinned protocol value. Bumping this pin must be a deliberate, lockstep change
// with xchain-indexer/src/config.js (and a flag-day plan): both sides interpret
// the SAME historical chain, so the value is consensus for the cancelling window.
const PINNED_CLOSE_DELAY = 3600;

const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR
    || path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const INDEXER_CONFIG = path.join(INDEXER_DIR, 'src', 'config.js');
const SIBLING_PRESENT = fs.existsSync(INDEXER_CONFIG);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

describe('DISPENSER_CLOSE_DELAY conformance (decoder twin vs indexer config) @regression', function () {

    it('decoder constant equals the pinned protocol value', function () {
        assert.strictEqual(DISPENSER_CLOSE_DELAY, PINNED_CLOSE_DELAY);
    });

    it('decoder constant is a positive integer number of seconds', function () {
        assert.ok(Number.isInteger(DISPENSER_CLOSE_DELAY) && DISPENSER_CLOSE_DELAY > 0);
    });

    describe('parity with sibling xchain-indexer getConfig()', function () {

        it('sibling xchain-indexer checkout is present (required in CI)', function () {
            if (!SIBLING_PRESENT && !REQUIRE_SIBLINGS) return this.skip();
            assert.ok(SIBLING_PRESENT,
                'xchain-indexer sibling checkout missing at ' + INDEXER_DIR +
                ' (set XCHAIN_INDEXER_DIR or check out the sibling)');
        });

        // Non-mainnet networks only: getConfig is a pure in-process resolver, but the
        // guard stays inside the regtest/testnet lane by policy. The value is network
        // independent in config.js, so regtest coverage guards mainnet too.
        const LANES = [];
        for (const coin of ['BTC', 'LTC', 'DOGE'])
            for (const network of ['regtest', 'testnet'])
                LANES.push({ coin, network });

        for (const { coin, network } of LANES) {
            it(`indexer getConfig('${coin}', '${network}').DISPENSER_CLOSE_DELAY equals the decoder twin`, function () {
                if (!SIBLING_PRESENT) return this.skip();
                const indexerConfig = require(INDEXER_CONFIG);
                const resolved = indexerConfig.getConfig(coin, network);
                assert.strictEqual(resolved.DISPENSER_CLOSE_DELAY, DISPENSER_CLOSE_DELAY,
                    'indexer DISPENSER_CLOSE_DELAY (' + resolved.DISPENSER_CLOSE_DELAY +
                    ') != decoder twin (' + DISPENSER_CLOSE_DELAY + '): lockstep edit required');
            });
        }
    });
});
