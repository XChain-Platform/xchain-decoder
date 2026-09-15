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
    EXP_EARLY,
    EXP_LATE,
    SOURCE,
    assert,
    create,
    refill,
    runAll,
    runOne,
} = require('./support.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('batched v2 refill / v1 cancel', function () {

        it('a batched v2 edit extends open dispensers (it did nothing before)', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(EXP_LATE),     source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.strictEqual(decoder.model.extendCalls.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })

        it('a batched v2 edit does NOTHING below the gate', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(EXP_LATE),     source: SOURCE, outputs: [] },
            ], BELOW_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls, [])
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_EARLY)
        })

        it('resolves against a dispenser created in the SAME batch', async () => {
            // Creates are inserted BEFORE the format-1/2 mirrors run, so an edit anywhere in
            // the batch reaches a create anywhere in it. The reverse order would let an edit
            // AFTER its create miss the row and close early - the money-bearing direction.
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                refill(EXP_LATE),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE,
                'the batched refill found the dispenser its own batch created')
        })

        it('reaches a create placed AFTER it in the same batch too (hold-open-longer)', async () => {
            const decoder = await runOne('BATCH|0|' + [
                refill(EXP_LATE),
                create({ expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })
    })
})
