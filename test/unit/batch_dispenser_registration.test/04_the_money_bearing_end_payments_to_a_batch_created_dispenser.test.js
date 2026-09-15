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
    BUYER,
    CHANGE,
    SOURCE,
    assert,
    create,
    runAll,
} = require('./support/helpers.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('the money-bearing end: payments to a batch-created dispenser', function () {

        const paymentTx = { id: 'pay01', action: '', source: BUYER,
                            outputs: [{ destinationAddress: SOURCE, vout: 0, amount: 500000 },
                                      { destinationAddress: CHANGE, vout: 1, amount: 100000 }] }

        it('are captured as dispense outputs later in the SAME block, above the gate', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
                paymentTx,
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [SOURCE],
                'the payment to the batch-created dispenser is stored for the indexer')
        })

        it('are NOT captured below the gate (the defect: coin spent, nothing dispensed)', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
                paymentTx,
            ], BELOW_GATE)
            assert.deepStrictEqual(decoder.captured, [])
        })

        it('are captured in a LATER block too, from the persisted registry', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            // Second block: the open set is re-read from the rows the batch wrote.
            const openSet = await decoder.model.getAllOpenDispenserAddresses()
            assert.ok(openSet.has(SOURCE),
                'the batch-created dispenser is in getAllOpenDispenserAddresses')
        })

        it('a top-level create captures the same way, on both sides of the gate', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({}), source: SOURCE, outputs: [] },
                    paymentTx,
                ], venue)
                assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [SOURCE])
            }
        })
    })
})
