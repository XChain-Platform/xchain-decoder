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

// BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION drift guard.
//
// The gate lets payment-output capture see a BATCH's SUB-COMMANDS, so a batched COINPAY
// persists its settlement outputs and a batched Mode B DISPENSER its oracle-fee outputs.
// That changes the set of rows written to transaction_outputs, which changes indexer
// verdicts, which changes the ledger, so it is consensus-affecting in both directions:
// arming it on a fleet that has not deployed forks the chain, and arming it in the past
// makes a from-genesis re-decode capture outputs the live fleet never captured.
//
// Four tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. PIN     - the vendored map carries the ratified mainnet instant and the genesis-on
//                testnet/regtest shape, in this repo alone.
//   2. FANOUT  - on every ARMED network it is >= the indexer's FIX_OUTPUT_FANOUT instant. A
//                BATCH is a data-bearing, non-COINPAY row, so the extra captured outputs fan
//                it out to several rows, and below that flag-day
//                output_fanout.collapseOutputFanout treats that as a consensus-critical
//                fault and HALTS the block.
//   3. LEDGER  - on every ARMED network it is >= the indexer's BATCH_ISSUANCE_LIMITS instant,
//                which carries the batch-cumulative settlement ledger. Capture without that
//                ledger lets N COINPAY sub-commands settle N obligations from ONE payment.
//   4. DOCS    - it is value-identical to the canonical map in
//                xchain-documentation/protocol/constants.js, which must exist before mainnet
//                may be armed.
// Sibling tiers skip when the sibling checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead of green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        BATCH_SUB_COMMAND_FORMATS,
        isBatchSubCommandCaptureActive,
        batchSubCommands,
        captureCommands } = require('../../src/batchSubCommandCapture.js');

const DOCS_CONSTANTS = process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const INDEXER_CHANGES = process.env.XCHAIN_INDEXER_DIR
    ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'protocol_changes.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'protocol_changes.js');
const INDEXER_BATCH = process.env.XCHAIN_INDEXER_DIR
    ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'batch.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'batch.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// 2026-08-16 00:00:00 UTC, armed on mainnet by the operator on 2026-08-14 (pre-launch) at
// the SAME instant the indexer carries for BATCH_ISSUANCE_LIMITS. Moving this number is a
// consensus act and not a tidy-up: below it a from-genesis re-decode must reproduce the
// top-level-only output set the live fleet wrote, and above it every decoder on mainnet must
// already be running the armed value or the fleet splits on the first BATCH carrying a
// COINPAY or a Mode B DISPENSER. A change here should be a deliberate edit, never a
// side-effect of making a red test green.
const PINNED_MAINNET_ACTIVATION = 1786838400;

// A block time strictly below whatever mainnet carries, for the cases that pin pre-flag-day
// inertness. Derived from the map rather than hardcoded, so this stays BELOW the gate if the
// instant ever moves; a DISARMED mainnet is inactive at every block time, so an absurd one
// serves there.
const BELOW_MAINNET_GATE =
    typeof BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet === 'number'
        ? BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet - 1
        : 4000000000;

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

// addChange(name, version, mainnet_time, testnet_time, regtest_time, ...): read the three
// armed times off the registration line rather than instantiating ProtocolChanges, which
// needs a DB handle.
function indexerChangeTimes(name){
    const src = fs.readFileSync(INDEXER_CHANGES, 'utf8');
    const pattern = new RegExp("addChange\\(\\s*'" + name +
        "'\\s*,\\s*'[^']*'\\s*,\\s*([A-Za-z0-9_]+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,");
    const m = pattern.exec(src);
    assert.ok(m, name + ' must be registered in xchain-indexer/src/protocol_changes.js');
    // The mainnet slot may be a named constant (the house UNARMED sentinel); resolve it
    // from its own `const NAME = <number>;` declaration in the same file.
    let mainnet = m[1];
    if (!/^\d+$/.test(mainnet)){
        const decl = new RegExp('const\\s+' + mainnet + '\\s*=\\s*(\\d+)\\s*;').exec(src);
        assert.ok(decl, 'the mainnet arm ' + mainnet + ' must be a numeric const in protocol_changes.js');
        mainnet = decl[1];
    }
    return { mainnet: parseInt(mainnet, 10),
             testnet: parseInt(m[2], 10),
             regtest: parseInt(m[3], 10) };
}

describe('BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION conformance', function () {

    it('pins the ratified mainnet flag-day and keeps testnet/regtest genesis-on', function () {
        // Teeth for the ratified instant: any OTHER value on mainnet, null included, means
        // someone moved a consensus boundary the operator armed. Moving it forward strands
        // every decoder already running the armed value; moving it back rewrites agreed
        // history on a re-decode.
        assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet,
            PINNED_MAINNET_ACTIVATION);
        assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.testnet, 0);
        assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.regtest, 0);
    });

    it('is off below the ratified mainnet instant and on from it, through the real helper', function () {
        // The number above only matters through the predicate the decoder actually calls, so
        // the boundary is driven rather than asserted: mainnet history below the instant must
        // re-decode with the legacy top-level-only view, and the block AT the instant is the
        // first one that sees sub-commands (>=, as every protocol_changes gate reads).
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 0), false);
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 1786060800), false,
            'the ORACLE_FEE_OUTPUT_ACTIVATION flag-day is below this one and must stay off here');
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', PINNED_MAINNET_ACTIVATION - 1),
            false, 'the block one second below the instant keeps top-level-only capture');
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', PINNED_MAINNET_ACTIVATION),
            true, 'the block AT the instant sees sub-commands');
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', PINNED_MAINNET_ACTIVATION + 1),
            true);
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 4000000000), true);
    });

    it('covers exactly the networks the sibling capture gates cover', function () {
        assert.deepStrictEqual(Object.keys(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION).sort(),
            ['mainnet', 'regtest', 'testnet']);
    });

    it('never precedes the indexer FIX_OUTPUT_FANOUT flag-day (extra rows below it halt blocks)', function () {
        if (!siblingOrSkip(this, INDEXER_CHANGES)) return;
        const fanout = indexerChangeTimes('FIX_OUTPUT_FANOUT');
        for (const network of Object.keys(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION)) {
            const gate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[network];
            if (gate === null) continue;
            assert.ok(gate >= fanout[network],
                network + ' sub-command capture (' + gate + ') must not begin before ' +
                'FIX_OUTPUT_FANOUT (' + fanout[network] + '): a BATCH is a data-bearing ' +
                'non-COINPAY row, so a second stored output below that flag-day is a ' +
                'consensus-critical fan-out fault that halts the block');
        }
    });

    it('never precedes the indexer BATCH_ISSUANCE_LIMITS flag-day (the settlement ledger)', function () {
        if (!siblingOrSkip(this, INDEXER_CHANGES)) return;
        const limits = indexerChangeTimes('BATCH_ISSUANCE_LIMITS');
        for (const network of Object.keys(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION)) {
            const gate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[network];
            if (gate === null) continue;
            assert.ok(gate >= limits[network],
                network + ' sub-command capture (' + gate + ') must not begin before ' +
                'BATCH_ISSUANCE_LIMITS (' + limits[network] + '): that gate carries the ' +
                'batch-cumulative settlement ledger, without which N COINPAY sub-commands ' +
                'settle N obligations from one payment');
        }
    });

    it('never precedes the indexer BATCH_SUBACTION_NORMALIZATION flag-day (sub-command aliases)', function () {
        if (!siblingOrSkip(this, INDEXER_CHANGES)) return;
        // captureCommands alias-expands a BATCH's SUB-COMMAND names, because that is the
        // name the indexer DISPATCHES on at/after this flag-day. BELOW it an aliased
        // sub-command is an unregistered name, so the indexer's activation scan
        // whole-batch-rejects and runs nothing: expanding there would capture for a batch
        // that never executed. The ordering is what makes the expansion faithful rather
        // than merely convenient, and nothing in code enforces it.
        const normalization = indexerChangeTimes('BATCH_SUBACTION_NORMALIZATION');
        for (const network of Object.keys(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION)) {
            const gate = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION[network];
            if (gate === null) continue;
            assert.ok(gate >= normalization[network],
                network + ' sub-command capture (' + gate + ') must not begin before ' +
                'BATCH_SUBACTION_NORMALIZATION (' + normalization[network] + '): below that ' +
                'flag-day a batched alias is an unknown ACTION that invalidates the whole ' +
                'batch, so the sub-command view must not resolve it to its canonical name');
        }
    });

    it('mirrors the BATCH FORMAT versions the indexer registers', function () {
        if (!siblingOrSkip(this, INDEXER_BATCH)) return;
        // Capture must see sub-commands in exactly the FORMATs the indexer dispatches. A
        // format listed here but not there captures for commands nothing executes; one
        // listed there but not here leaves the original defect open for that format.
        const src = fs.readFileSync(INDEXER_BATCH, 'utf8');
        const registered = [...src.matchAll(/this\.formats\[(\d+)\]\s*=/g)]
            .map(m => parseInt(m[1], 10)).sort((a, b) => a - b);
        assert.ok(registered.length > 0, 'xchain-indexer/src/actions/batch.js must register a FORMAT');
        assert.deepStrictEqual([...BATCH_SUB_COMMAND_FORMATS].sort((a, b) => a - b), registered);
    });

    it('is value-identical to the canonical map in xchain-documentation, or mainnet is DISARMED', function () {
        if (!siblingOrSkip(this, DOCS_CONSTANTS)) return;
        const canon = require(DOCS_CONSTANTS).BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION;
        if (canon === undefined) {
            // The vendored copy leads the canonical one while the gate is inert everywhere a
            // fleet reads it. This is the ONE state where the mirror may be missing, and it
            // ends the moment mainnet carries an instant: from then on a decoder fleet is
            // acting on a value no canonical document records.
            assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, null,
                'mainnet may not be armed before BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION is ' +
                'mirrored into xchain-documentation/protocol/constants.js');
            return;
        }
        assert.deepStrictEqual(
            { mainnet: BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet,
              testnet: BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.testnet,
              regtest: BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.regtest },
            { mainnet: canon.mainnet, testnet: canon.testnet, regtest: canon.regtest },
            'the vendored map drifted from the canonical one; a one-sided flag-day edit forks ' +
            'the decoder fleet at the first BATCH carrying a COINPAY or a Mode B DISPENSER');
    });

    it('a DISARMED network is inactive at every block time, including absurd ones', function () {
        // Every network in this map is armed today, so the null branch needs a fixture: disarm
        // mainnet in place for the length of the test and drive the REAL helper (it reads the
        // map per call, so the mutation is visible). The branch has to stay covered because it
        // is the fail-closed default protecting every gate no operator has ratified yet - a
        // null that read as "no gate" would widen the persisted output set on an unarmed chain.
        const saved = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet;
        BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = null;
        try {
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 0), false);
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 1786060800), false);
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', 4000000000), false);
        } finally {
            BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = saved;
        }
        assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, saved,
            'the probe must put back whatever the map held before it');
    });

    it('testnet and regtest are active from genesis so the venues exercise the sub-command path', function () {
        assert.strictEqual(isBatchSubCommandCaptureActive('testnet', 0), true);
        assert.strictEqual(isBatchSubCommandCaptureActive('regtest', 0), true);
        assert.strictEqual(isBatchSubCommandCaptureActive('regtest', 1700000000), true);
    });

    it('fails closed on an unrecognized network name', function () {
        // An unknown network must read as "legacy top-level-only capture", never as "no
        // gate": the latter would widen the persisted output set on an unarmed chain.
        assert.strictEqual(isBatchSubCommandCaptureActive('signet', 4000000000), false);
        assert.strictEqual(isBatchSubCommandCaptureActive(undefined, 4000000000), false);
        assert.strictEqual(isBatchSubCommandCaptureActive('', 4000000000), false);
    });

    it('fails closed on a non-finite block time', function () {
        assert.strictEqual(isBatchSubCommandCaptureActive('regtest', NaN), false);
        assert.strictEqual(isBatchSubCommandCaptureActive('regtest', undefined), false);
        assert.strictEqual(isBatchSubCommandCaptureActive('regtest', 'not-a-time'), false);
    });

    it('flips exactly at the armed instant once a network IS armed (>= semantics)', function () {
        // The >= boundary itself, driven at an instant NOBODY has ratified, so it stays a
        // statement about the comparison rather than about today's mainnet value: arm mainnet
        // onto a synthetic instant for the length of this test and drive the REAL helper (the
        // module reads the map per call, so the mutation is visible). The block AT the instant
        // already captures, matching every protocol_changes gate.
        const ARMED = 1789430400;
        const saved = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet;
        BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = ARMED;
        try {
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', ARMED - 1), false,
                'the block below the instant keeps top-level-only capture');
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', ARMED), true,
                'the block AT the instant sees sub-commands');
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', ARMED + 1), true,
                'and it stays on above it');
        } finally {
            BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = saved;
        }
        // Restore to whatever was there BEFORE the probe, never to a baseline written into
        // this test: hardcoding one made an operator arming mainnet fail here, which is the
        // one place the arming must not be re-litigated.
        assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, saved,
            'the map must be back to its pre-probe value');
        // Behavioural half: the helper answers under the RESTORED map again. A leaked
        // mutation (the synthetic instant is LATER than the real one) reads as inactive at
        // the real instant, so it cannot pass here.
        assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', BELOW_MAINNET_GATE), false);
        if (typeof saved === 'number')
            assert.strictEqual(isBatchSubCommandCaptureActive('mainnet', saved), true,
                'the restored map governs again, not the probe value');
    });
});

// The split itself. A decoder that disagrees with the indexer about what a BATCH's
// sub-commands ARE is a worse bug than the capture hole it is fixing, so these pin the
// equivalence argument written out in batchSubCommandCapture.batchSubCommands.
describe('BATCH sub-command split', function () {

    it('returns null for anything that is not a BATCH', function () {
        assert.strictEqual(batchSubCommands('COINPAY|0|1|abc'), null);
        assert.strictEqual(batchSubCommands('DISPENSER|0|BTC|TICK|1'), null);
        assert.strictEqual(batchSubCommands(''), null);
        assert.strictEqual(batchSubCommands('BATCHY|0|SEND|0|A'), null);
        assert.strictEqual(batchSubCommands(undefined), null);
        assert.strictEqual(batchSubCommands(null), null);
        assert.strictEqual(batchSubCommands(12345), null);
    });

    it("splits on ';' after stripping the BATCH|<version>| prefix, exactly like the indexer", function () {
        assert.deepStrictEqual(
            batchSubCommands('BATCH|0|COINPAY|0|1|abc;COINPAY|0|2|def'),
            ['COINPAY|0|1|abc', 'COINPAY|0|2|def']);
        assert.deepStrictEqual(
            batchSubCommands('BATCH|0|SEND|0|BTC|TICK|1|addr'),
            ['SEND|0|BTC|TICK|1|addr']);
    });

    it("keeps empty elements, matching the indexer's raw ';'-split list", function () {
        // A trailing ';' yields a trailing empty command there too, which its activation scan
        // whole-batch rejects. Counting it keeps the two lists index-for-index comparable.
        assert.deepStrictEqual(batchSubCommands('BATCH|0|COINPAY|0|1|abc;'),
            ['COINPAY|0|1|abc', '']);
        assert.deepStrictEqual(batchSubCommands('BATCH|0|;;COINPAY|0|1|abc'),
            ['', '', 'COINPAY|0|1|abc']);
    });

    it('yields NO sub-commands when the FORMAT prefix does not literally match', function () {
        // The indexer strips a literal 'BATCH|' + format + '|'. A token that derives to 0 by
        // another spelling leaves the head intact, element 0's action stays BATCH, and
        // actionLimits['BATCH'] = 0 whole-batch rejects it, so nothing executes.
        assert.deepStrictEqual(batchSubCommands('BATCH||COINPAY|0|1|abc'), []);
        assert.deepStrictEqual(batchSubCommands('BATCH|00|COINPAY|0|1|abc'), []);
        assert.deepStrictEqual(batchSubCommands('BATCH| 0 |COINPAY|0|1|abc'), []);
        assert.deepStrictEqual(batchSubCommands('BATCH|"0"|COINPAY|0|1|abc'), []);
    });

    it('yields NO sub-commands for an unregistered FORMAT', function () {
        // 'invalid: VERSION (unknown)' there: the sub-command loop never runs.
        assert.deepStrictEqual(batchSubCommands('BATCH|1|COINPAY|0|1|abc'), []);
        assert.deepStrictEqual(batchSubCommands('BATCH|255|COINPAY|0|1|abc'), []);
        assert.deepStrictEqual(batchSubCommands('BATCH|x|COINPAY|0|1|abc'), []);
    });

    it('does not let a LATER BATCH|0| occurrence pass off as the stripped head', function () {
        // The indexer's replace fires on the inner occurrence, but the head survives, so
        // element 0's action is still BATCH and the whole batch is rejected.
        assert.deepStrictEqual(batchSubCommands('BATCH||SEND|BATCH|0|COINPAY|0|1|abc'), []);
    });

    it('a nested BATCH sub-command is returned as-is (the indexer rejects the whole batch)', function () {
        // actionLimits['BATCH'] = 0, so this batch is invalid there; capture over the list is
        // harmless because a nested BATCH string carries no capture-selecting prefix itself.
        assert.deepStrictEqual(batchSubCommands('BATCH|0|BATCH|0|COINPAY|0|1|abc'),
            ['BATCH|0|COINPAY|0|1|abc']);
    });
});

describe('capture command view', function () {

    it('is the action string itself below the gate, for a BATCH and for anything else', function () {
        // Pre-flag-day mainnet history: the view is the top-level string, so a from-genesis
        // re-decode reproduces the output set the fleet wrote live, byte for byte.
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc', 'mainnet', BELOW_MAINNET_GATE),
            ['BATCH|0|COINPAY|0|1|abc']);
        assert.deepStrictEqual(captureCommands('COINPAY|0|1|abc', 'mainnet', BELOW_MAINNET_GATE),
            ['COINPAY|0|1|abc']);
    });

    it('is the action string itself above the gate for a non-BATCH', function () {
        assert.deepStrictEqual(captureCommands('COINPAY|0|1|abc', 'regtest', 0),
            ['COINPAY|0|1|abc']);
        assert.deepStrictEqual(captureCommands('DISPENSER|0|BTC', 'regtest', 0),
            ['DISPENSER|0|BTC']);
    });

    it('is the sub-command list above the gate for a BATCH', function () {
        assert.deepStrictEqual(captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'regtest', 0),
            ['COINPAY|0|1|abc', 'SEND|0|BTC']);
    });

    it('flips to the sub-command list on mainnet at its ratified instant', function () {
        // The armed half of the same boundary, on the network the arming is about: one second
        // below the instant a batched COINPAY is still invisible to capture, and at it the
        // settlement sub-command is what capture sees.
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'mainnet',
                PINNED_MAINNET_ACTIVATION - 1),
            ['BATCH|0|COINPAY|0|1|abc;SEND|0|BTC']);
        assert.deepStrictEqual(
            captureCommands('BATCH|0|COINPAY|0|1|abc;SEND|0|BTC', 'mainnet',
                PINNED_MAINNET_ACTIVATION),
            ['COINPAY|0|1|abc', 'SEND|0|BTC']);
    });
});
