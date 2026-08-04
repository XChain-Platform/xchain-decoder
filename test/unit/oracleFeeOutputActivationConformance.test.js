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

// ORACLE_FEE_OUTPUT_ACTIVATION drift guard .
//
// The decoder begins persisting a DISPENSER's oracle-usage-fee output at this gate. That
// makes a fee-bearing Mode B transaction carry TWO stored outputs (the protocol fee output
// and the oracle output), and getDecoderBlockData emits one row per stored output - which
// BELOW the indexer's FIX_OUTPUT_FANOUT flag-day is a consensus-critical fault that HALTS
// the block (output_fanout.collapseOutputFanout throws when `enabled` is false). Arming
// this gate any earlier than FIX_OUTPUT_FANOUT therefore does not merely change a verdict,
// it stops the chain.
//
// Three tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. PIN     - the vendored value equals the pinned flag-day instant, in this repo alone.
//   2. DOCS    - it equals the canonical map in xchain-documentation/protocol/constants.js.
//   3. INDEXER - it is >= the indexer's FIX_OUTPUT_FANOUT mainnet block-time, so capture can
//                never begin in a block the indexer would halt on.
// Tiers 2 and 3 skip when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { ORACLE_FEE_OUTPUT_ACTIVATION } = require('../../src/protocol/constants.js');

// 2026-08-07 00:00:00 UTC, the contract-era flag-day the fan-out collapse rides.
const PINNED_MAINNET_ACTIVATION = 1786060800;

const DOCS_CONSTANTS = process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const INDEXER_CHANGES = process.env.XCHAIN_INDEXER_DIR
    ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'protocol_changes.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'protocol_changes.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

describe('ORACLE_FEE_OUTPUT_ACTIVATION conformance ', function () {

    it('pins the mainnet flag-day and keeps testnet/regtest genesis-on', function () {
        assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.mainnet, PINNED_MAINNET_ACTIVATION);
        assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.testnet, 0);
        assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.regtest, 0);
    });

    it('is value-identical to the canonical map in xchain-documentation', function () {
        if (!siblingOrSkip(this, DOCS_CONSTANTS)) return;
        const canon = require(DOCS_CONSTANTS).ORACLE_FEE_OUTPUT_ACTIVATION;
        assert.ok(canon && typeof canon === 'object',
            'xchain-documentation/protocol/constants.js must export ORACLE_FEE_OUTPUT_ACTIVATION');
        assert.deepStrictEqual(
            { mainnet: ORACLE_FEE_OUTPUT_ACTIVATION.mainnet,
              testnet: ORACLE_FEE_OUTPUT_ACTIVATION.testnet,
              regtest: ORACLE_FEE_OUTPUT_ACTIVATION.regtest },
            { mainnet: canon.mainnet, testnet: canon.testnet, regtest: canon.regtest });
    });

    it('never precedes the indexer FIX_OUTPUT_FANOUT flag-day (capture below it halts blocks)', function () {
        if (!siblingOrSkip(this, INDEXER_CHANGES)) return;
        // Read the arming line from source rather than instantiating ProtocolChanges, which
        // needs a DB handle. addChange(name, version, mainnet_time, testnet_time,
        // regtest_time, mainnet_block, testnet_block, regtest_block).
        const src = fs.readFileSync(INDEXER_CHANGES, 'utf8');
        const m = /addChange\(\s*'FIX_OUTPUT_FANOUT'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,/.exec(src);
        assert.ok(m, 'FIX_OUTPUT_FANOUT must be registered in xchain-indexer/src/protocol_changes.js');
        const fanoutMainnetTime = parseInt(m[1], 10);
        assert.ok(ORACLE_FEE_OUTPUT_ACTIVATION.mainnet >= fanoutMainnetTime,
            'oracle-fee capture (' + ORACLE_FEE_OUTPUT_ACTIVATION.mainnet + ') must not begin before ' +
            'FIX_OUTPUT_FANOUT (' + fanoutMainnetTime + '): a second stored output below that ' +
            'flag-day is a consensus-critical fan-out fault that halts the block');
    });
});
