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

// ORACLE_FEE_OUTPUT_ACTIVATION drift guard.
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
//   3. INDEXER - on every network it is >= the indexer's FIX_OUTPUT_FANOUT block-time, and that
//                row carries no height gate, so capture can never begin in a block the
//                indexer would halt on.
// Tiers 2 and 3 skip when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { ORACLE_FEE_OUTPUT_ACTIVATION, ORACLE_FEE_SET_CAPTURE_ACTIVATION } =
    require('../../src/protocol/constants.js');

// 2026-08-07 00:00:00 UTC, the contract-era flag-day the fan-out collapse rides.
const PINNED_MAINNET_ACTIVATION = 1786060800;

const DOCS_CONSTANTS = process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR
    || path.join(__dirname, '..', '..', '..', 'xchain-indexer');
// The indexer's protocol-change table is a loader (src/protocol_changes.js) over the
// registry parts in src/protocol_changes/*.js, where the registration rows live since
// the indexer structure pass moved them out of the single file. The loader is the
// sibling marker; the corpus the guard reads is the loader plus every part.
const INDEXER_CHANGES     = path.join(INDEXER_ROOT, 'src', 'protocol_changes.js');
const INDEXER_CHANGES_DIR = path.join(INDEXER_ROOT, 'src', 'protocol_changes');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

// The loader plus every registry part, concatenated in filename order (stable across
// checkouts), so a row registered in any part is found. A missing parts directory is
// named in the failure rather than read as "nothing registered": a pre-split checkout
// carries the rows in the loader itself, so the loader alone is the corpus there.
function indexerChangesCorpus(){
    const parts = fs.existsSync(INDEXER_CHANGES_DIR)
        ? fs.readdirSync(INDEXER_CHANGES_DIR).filter(f => f.endsWith('.js')).sort()
            .map(f => path.join(INDEXER_CHANGES_DIR, f))
        : [];
    if (!parts.length && REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but no registry parts under ' + INDEXER_CHANGES_DIR);
    return [INDEXER_CHANGES].concat(parts).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

describe('ORACLE_FEE_OUTPUT_ACTIVATION conformance', function () {

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
        // Read the arming row from source rather than instantiating ProtocolChanges, which
        // needs a DB handle. The row is the addChange argument list (name, version,
        // mainnet_time, testnet_time, regtest_time, mainnet_block, testnet_block,
        // regtest_block), written either as the historical addChange(...) call or as the
        // array literal the registry parts hold; both spellings are accepted so the guard
        // reads the same row through either layout.
        const row = fixOutputFanoutRow();
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const fanoutTime = row[network + '_time'];
            assert.ok(ORACLE_FEE_OUTPUT_ACTIVATION[network] >= fanoutTime,
                network + ' oracle-fee capture (' + ORACLE_FEE_OUTPUT_ACTIVATION[network] + ') must not ' +
                'begin before FIX_OUTPUT_FANOUT (' + fanoutTime + '): a second stored output below that ' +
                'flag-day is a consensus-critical fan-out fault that halts the block');
        }
    });

    it('needs no indexer FIX_OUTPUT_FANOUT block-height gate (the decoder gate is time-only)', function () {
        if (!siblingOrSkip(this, INDEXER_CHANGES)) return;
        // isEnabled ANDs the time and height gates, so a non-zero *_block holds the collapse
        // off past its time gate, where this time-only capture would already halt blocks.
        const row = fixOutputFanoutRow();
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(row[network + '_block'], 0,
                'FIX_OUTPUT_FANOUT ' + network + '_block is ' + row[network + '_block'] + ': the ' +
                'decoder oracle-fee gate cannot mirror a height gate, so arm it by time only');
        }
    });
});

// The FIX_OUTPUT_FANOUT arming row, all six gate columns, read from indexer source.
// A non-integer column (a named constant, a thunk) fails here rather than reading as 0.
function fixOutputFanoutRow(){
    const src = indexerChangesCorpus();
    const head = /(?:addChange\(|\[)\s*'FIX_OUTPUT_FANOUT'\s*,\s*'[^']*'\s*,([^\])]*)[\])]/.exec(src);
    assert.ok(head, 'FIX_OUTPUT_FANOUT must be registered in xchain-indexer/src/protocol_changes.js ' +
        'or one of its registry parts under src/protocol_changes/');
    const cols = head[1].split(',').map(s => s.trim());
    const names = ['mainnet_time', 'testnet_time', 'regtest_time', 'mainnet_block', 'testnet_block', 'regtest_block'];
    assert.strictEqual(cols.length, names.length,
        'FIX_OUTPUT_FANOUT row must carry exactly six gate columns, read: ' + head[1]);
    const row = {};
    names.forEach((name, i) => {
        assert.ok(/^\d+$/.test(cols[i]),
            'FIX_OUTPUT_FANOUT ' + name + ' must be an integer literal for this guard to read it, got: ' + cols[i]);
        row[name] = parseInt(cols[i], 10);
    });
    return row;
}

// ORACLE_FEE_SET_CAPTURE_ACTIVATION drift guard.
//
// The second gate widens a v2 refill's oracle-fee capture from ONE resolved address to
// membership over every open Mode B dispenser of the paying source. That changes the set of
// outputs persisted to transaction_outputs, so it is consensus-affecting in both directions:
// arming it early on a fleet that has not deployed forks the chain, and arming it in the past
// rewrites agreed history on a re-decode. mainnet is ARMED by the 2026-09-09 ruling at the base
// gate's own instant, the earliest the ordering below permits, and rewrites nothing because the
// indexed mainnet history holds 0 dispensers (measured 2026-09-09). null stays the fail-closed
// reading for any network that has not armed.
describe('ORACLE_FEE_SET_CAPTURE_ACTIVATION conformance', function () {

    it('arms mainnet at the base gate instant by the 2026-09-09 ruling', function () {
        // Teeth for the ruling AND for its ordering constraint in one place: the widening
        // starts exactly where capture itself starts, so no mainnet block sits between the two
        // gates, and a re-decode of the (dispenser-free) history persists the same output set.
        assert.strictEqual(ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet, PINNED_MAINNET_ACTIVATION);
        assert.strictEqual(ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet,
            ORACLE_FEE_OUTPUT_ACTIVATION.mainnet);
    });

    it('carries a block time or null (DISARMED) per network, regtest genesis-on', function () {
        const networks = Object.keys(ORACLE_FEE_SET_CAPTURE_ACTIVATION);
        assert.deepStrictEqual(networks.sort(), ['mainnet', 'regtest', 'testnet'],
            'the map must cover exactly the networks the base gate covers');
        for (const network of networks) {
            const value = ORACLE_FEE_SET_CAPTURE_ACTIVATION[network];
            assert.ok(value === null || (Number.isSafeInteger(value) && value >= 0),
                network + ' must be a non-negative block time or null (DISARMED)');
        }
        assert.strictEqual(ORACLE_FEE_SET_CAPTURE_ACTIVATION.regtest, 0,
            'regtest holds no agreed history and stays genesis-on so the venues exercise the set path');
    });

    it('never precedes the base oracle-fee capture gate on any network', function () {
        // Set capture only widens a capture the base gate already switched on. A value
        // below it would arm a widening of something that captures nothing, and on mainnet
        // it would also drag capture below the indexer's FIX_OUTPUT_FANOUT flag-day, which
        // halts blocks.
        for (const network of Object.keys(ORACLE_FEE_SET_CAPTURE_ACTIVATION)) {
            const setGate = ORACLE_FEE_SET_CAPTURE_ACTIVATION[network];
            if (setGate === null) continue;
            assert.ok(setGate >= ORACLE_FEE_OUTPUT_ACTIVATION[network],
                network + ' set capture (' + setGate + ') must not precede oracle-fee capture (' +
                ORACLE_FEE_OUTPUT_ACTIVATION[network] + ')');
        }
    });

    it('is value-identical to the canonical map in xchain-documentation', function () {
        if (!siblingOrSkip(this, DOCS_CONSTANTS)) return;
        const canon = require(DOCS_CONSTANTS).ORACLE_FEE_SET_CAPTURE_ACTIVATION;
        assert.ok(canon && typeof canon === 'object',
            'xchain-documentation/protocol/constants.js must export ORACLE_FEE_SET_CAPTURE_ACTIVATION');
        assert.deepStrictEqual(
            { mainnet: ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet,
              testnet: ORACLE_FEE_SET_CAPTURE_ACTIVATION.testnet,
              regtest: ORACLE_FEE_SET_CAPTURE_ACTIVATION.regtest },
            { mainnet: canon.mainnet, testnet: canon.testnet, regtest: canon.regtest });
    });
});
