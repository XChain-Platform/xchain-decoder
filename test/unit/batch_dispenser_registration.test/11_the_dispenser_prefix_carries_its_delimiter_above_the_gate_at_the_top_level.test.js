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
    EXP_LATE,
    ORACLE_A,
    SOURCE,
    assert,
    create,
    runOne,
} = require('./support/helpers.js')

const renamed = (name, command) => name + command.slice(command.indexOf('|'))
const NEAR_MISS_NAMES = ['DISPENSERX', 'DISPENSERS', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE']

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('the DISPENSER prefix carries its delimiter above the gate', function () {

        describe('at the TOP LEVEL, where VALID_ACTION_NAMES already closed it', function () {

            it('registers nothing for a near-miss name on EITHER side of the gate', async () => {
                // Unchanged by this row: the storage gate blanks the action to '' first, so the
                // loose prefix never saw these strings. Pinned so the claim is checked, not
                // asserted, and so a future widening of VALID_ACTION_NAMES fails loudly here.
                for (const name of NEAR_MISS_NAMES) {
                    for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                        const decoder = await runOne(renamed(name, create({ oracle: ORACLE_A })), venue)
                        assert.deepStrictEqual(decoder.model.rows, [],
                            `${name} is blanked by the VALID_ACTION_NAMES gate`)
                    }
                }
            })

            it('registers a genuine top-level DISPENSER on both sides', async () => {
                for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                    const decoder = await runOne(create({ oracle: ORACLE_A }), venue)
                    assert.deepStrictEqual(decoder.model.rows, [{
                        txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                        oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
                }
            })

            it('registers nothing for the bare token DISPENSER, on both sides', async () => {
                // The ONE top-level string that clears VALID_ACTION_NAMES and still misses
                // `DISPENSER|`: no pipe at all, so field [1] is undefined and the FORMAT parses
                // NaN. It matched the loose prefix and matches the tight one nowhere, and the
                // outcome is identical either way - which is exactly why the below-gate branch
                // of this tightening has no reachable consequence today.
                for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                    const decoder = await runOne('DISPENSER', venue)
                    assert.deepStrictEqual(decoder.model.rows, [])
                    assert.deepStrictEqual(decoder.model.extendCalls, [])
                }
            })

            it('leaves DISPENSE alone (a SHORTER name, matched by neither prefix)', async () => {
                for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                    const decoder = await runOne(renamed('DISPENSE', create({})), venue)
                    assert.deepStrictEqual(decoder.model.rows, [])
                }
            })
        })
    })
})
