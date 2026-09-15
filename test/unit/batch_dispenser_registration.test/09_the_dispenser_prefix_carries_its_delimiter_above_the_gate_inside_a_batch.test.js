// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ---------------------------------------------------------------------------
// The DISPENSER prefix carries its delimiter.
//
// The registry selected on `startsWith("DISPENSER")`, a bare ACTION NAME with no '|'.
// The wire delimits names with '|', so that also matched every longer string sharing the
// head: `DISPENSERX|0|...`, which the indexer dispatches nowhere, and the real but
// indexer-SYNTHESIZED DISPENSER_CLOSE / DISPENSER_EXPIRE, whose wire-spelled form resolves
// no dispenser there either. The decoder registered a dispenser for all of them and then
// classified payments to that address as DISPENSE outputs the indexer never settles.
//
// WHERE IT BITES, established by these tests rather than assumed: at the TOP LEVEL it does
// not, because buildStoredActionRecord's VALID_ACTION_NAMES gate blanks an unknown name to
// '' before the walk sees it. The sub-command walk is what made it reachable, since a
// BATCH's pieces pass NO name gate - only the outer 'BATCH' was ever checked. That makes
// this an inherited defect with a live above-gate consequence and, today, no reachable
// below-gate consequence at all. Both halves are pinned below, including the invariant the
// second half rests on.

const {
    ABOVE_GATE,
    BELOW_GATE,
    DELEGATE_A,
    DELEGATE_B,
    EXP_LATE,
    ORACLE_A,
    ORACLE_B,
    SOURCE,
    addressesOf,
    assert,
    create,
    rowFor,
    runOne,
} = require('./support.js')

// Same field layout as `create`/`refill`, so the only thing that varies is the NAME.
const renamed = (name, command) => name + command.slice(command.indexOf('|'))
const NEAR_MISS_NAMES = ['DISPENSERX', 'DISPENSERS', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE']

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('the DISPENSER prefix carries its delimiter above the gate', function () {

        describe('inside a BATCH, where the defect is reachable', function () {

            it('registers NOTHING for a near-miss sub-command above the gate', async () => {
                for (const name of NEAR_MISS_NAMES) {
                    const decoder = await runOne(
                        'BATCH|0|' + renamed(name, create({ oracle: ORACLE_A })), ABOVE_GATE)
                    assert.deepStrictEqual(decoder.model.rows, [],
                        `${name} is not the DISPENSER action; the indexer runs nothing for it`)
                    assert.strictEqual(decoder.model.insertCalls, 0)
                }
            })

            it('still registers a GENUINE sub-command above the gate (row 26 intact)', async () => {
                const decoder = await runOne('BATCH|0|' + create({ oracle: ORACLE_A }), ABOVE_GATE)
                assert.deepStrictEqual(decoder.model.rows, [{
                    txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                    oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
            })

            it('drops only the near-miss when a batch carries one of each', async () => {
                const decoder = await runOne('BATCH|0|' + [
                    renamed('DISPENSERX', create({ getAddress: DELEGATE_B, oracle: ORACLE_B })),
                    create({ getAddress: DELEGATE_A, oracle: ORACLE_A }),
                ].join(';'), ABOVE_GATE)
                assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_A],
                    'a near-miss sibling must not take the whole batch down with it')
                assert.strictEqual(rowFor(decoder.model, DELEGATE_A).oracleAddress, ORACLE_A)
            })

            it('registers nothing below the gate, for genuine OR near-miss', async () => {
                // Below the gate a BATCH's sub-commands are invisible to the registry at all,
                // so this is the same empty answer the fleet wrote pre-flag-day either way.
                for (const name of ['DISPENSER', 'DISPENSERX']) {
                    const decoder = await runOne(
                        'BATCH|0|' + renamed(name, create({})), BELOW_GATE)
                    assert.deepStrictEqual(decoder.model.rows, [])
                }
            })
        })
    })
})
