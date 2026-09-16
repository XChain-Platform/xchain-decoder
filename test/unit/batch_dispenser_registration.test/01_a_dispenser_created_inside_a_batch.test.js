// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    ABOVE_GATE,
    BELOW_GATE,
    DELEGATE_A,
    EXP_LATE,
    ORACLE_A,
    SELLER,
    SOURCE,
    addressesOf,
    assert,
    create,
    runOne,
} = require('./support/helpers.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('a dispenser created inside a BATCH', function () {

        it('registers NOTHING below the gate (the live defect, preserved for replay)', async () => {
            const decoder = await runOne('BATCH|0|' + create({ oracle: ORACLE_A }), BELOW_GATE)
            assert.deepStrictEqual(decoder.model.rows, [],
                'pre-flag-day history must re-decode to the empty registry the fleet wrote')
            assert.strictEqual(decoder.model.insertCalls, 0)
        })

        it('registers above the gate, exactly as a top-level create does', async () => {
            const decoder = await runOne('BATCH|0|' + create({ oracle: ORACLE_A }), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [{
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
        })

        it('registers when the DISPENSER is not the FIRST sub-command', async () => {
            // The prefix strip only touches element 0, so a create anywhere in the list counts.
            const decoder = await runOne(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER + ';' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [SOURCE])
        })

        it('registers nothing for a batch carrying no DISPENSER at all', async () => {
            const decoder = await runOne(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER + ';ORDER|0|BTC|TICK|1|TICK2|2|100', ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
            assert.strictEqual(decoder.model.insertCalls, 0)
        })

        it('registers nothing when the FORMAT prefix is not one the indexer strips', async () => {
            // 'BATCH||...' leaves element 0's action as BATCH, which actionLimits['BATCH']=0
            // whole-batch rejects, so no sub-command executes and registering one would open a
            // dispenser no node has.
            const decoder = await runOne('BATCH||' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
        })

        it('registers nothing for an unregistered BATCH FORMAT', async () => {
            const decoder = await runOne('BATCH|1|' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
        })
    })
})
