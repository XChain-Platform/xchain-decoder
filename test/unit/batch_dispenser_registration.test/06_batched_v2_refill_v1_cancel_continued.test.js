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
    CANCEL,
    CHANGE,
    EXP_EARLY,
    EXP_LATE,
    ORACLE_A,
    SELLER,
    SOURCE,
    T0,
    assert,
    create,
    refill,
    runAll,
} = require('./support/helpers.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('batched v2 refill / v1 cancel', function () {

        it('runs one extend per v2 sub-command and none for other actions', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + [refill(EXP_EARLY + 10), 'SEND|0|BTC|TICK|1|' + SELLER,
                                                        refill(EXP_LATE)].join(';'),
                  source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls.map(c => c.newExpiration),
                [EXP_EARLY + 10, EXP_LATE])
        })

        it('a batched format-1 cancel closes nothing, exactly as at top level', async () => {
            for (const command of [CANCEL, 'BATCH|0|' + CANCEL]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({}), source: SOURCE, outputs: [] },
                    { id: 'cancel01', action: command,    source: SOURCE, outputs: [] },
                ], ABOVE_GATE)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].expiredBlockIndex, null,
                    'the cancel mirror is retired: closing on a guessed target is the ' +
                    'money-bearing direction')
            }
        })

        it('captures the oracle fee of a create+refill batch from the CREATE payload', async () => {
            // Interaction with the earlier fix's oracle-fee union, verified rather than assumed:
            // oracle resolution runs BEFORE registration in the transaction loop, so the v2
            // sub-command's DB lookup cannot see a row its own batch is about to write. It
            // does not need to - the v0 create sitting in the same command list resolves its
            // oracle by PARSING field [13], and the union covers the refill's output too.
            const decoder = await runAll([
                { id: 'batch01',
                  action: 'BATCH|0|' + [create({ oracle: ORACLE_A }), refill(EXP_LATE)].join(';'),
                  source: SOURCE,
                  outputs: [{ destinationAddress: ORACLE_A, vout: 0, amount: 1000 },
                             { destinationAddress: CHANGE,  vout: 1, amount: 100000 }] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [ORACLE_A])
        })

        it('a batched v2 edit with a PAST expiration is skipped, as at top level', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_LATE }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(T0 - 1),      source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls, [])
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })
    })
})
