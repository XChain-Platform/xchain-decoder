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
    BUYER,
    DELEGATE_A,
    EXP_EARLY,
    EXP_LATE,
    FEE_DEST,
    SELLER,
    SOURCE,
    assert,
    create,
    refill,
    runAll,
} = require('./support.js')

const renamed = (name, command) => name + command.slice(command.indexOf('|'))
const NEAR_MISS_NAMES = ['DISPENSERX', 'DISPENSERS', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE']

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('the DISPENSER prefix carries its delimiter above the gate', function () {

        describe('inside a BATCH, where the defect is reachable', function () {

            it('a near-miss v2 sub-command extends NOTHING above the gate', async () => {
                // Pass 2 (the lifecycle mirrors) reads the same gated prefix as pass 1, so a
                // near-miss stops extending open rows at the same instant it stops registering.
                for (const name of NEAR_MISS_NAMES) {
                    const decoder = await runAll([
                        { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                        { id: 'batch01',  action: 'BATCH|0|' + renamed(name, refill(EXP_LATE)),
                          source: SOURCE, outputs: [] },
                    ], ABOVE_GATE)
                    assert.deepStrictEqual(decoder.model.extendCalls, [],
                        `${name} must not reach the extend mirror`)
                    assert.strictEqual(decoder.model.rows[0].expiration, EXP_EARLY)
                }
            })

            it('a GENUINE v2 sub-command still extends above the gate', async () => {
                const decoder = await runAll([
                    { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                    { id: 'batch01',  action: 'BATCH|0|' + refill(EXP_LATE),     source: SOURCE, outputs: [] },
                ], ABOVE_GATE)
                assert.strictEqual(decoder.model.extendCalls.length, 1)
                assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
            })

            // The money-bearing end: the registry is the set that decides which outputs become
            // DISPENSE outputs, so a near-miss registration turns real payments into dispenses
            // against a dispenser that does not exist anywhere but here.
            it('stops classifying payments to a near-miss address as dispenses', async () => {
                const decoder = await runAll([
                    { id: 'batch01',
                      action: 'BATCH|0|' + renamed('DISPENSERX', create({ getAddress: DELEGATE_A })),
                      source: SOURCE, outputs: [] },
                    { id: 'pay01', action: 'SEND|0|BTC|TICK|1|' + SELLER, source: BUYER,
                      outputs: [{ destinationAddress: DELEGATE_A, vout: 0, amount: 50000 }] },
                ], ABOVE_GATE, { feeDestination: FEE_DEST })
                assert.deepStrictEqual(await decoder.model.getAllOpenDispenserAddresses(), new Set(),
                    'no address is held open, so the payment stays an ordinary output')
            })
        })
    })
})
