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

const { batchSubCommands } = require('../../../src/protocol/batch_sub_command_capture.js');

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
