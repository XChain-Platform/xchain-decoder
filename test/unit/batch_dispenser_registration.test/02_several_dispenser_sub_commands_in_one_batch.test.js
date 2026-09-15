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
    CREATE_NO_TAIL,
    DELEGATE_A,
    DELEGATE_B,
    EXP_EARLY,
    EXP_LATE,
    ORACLE_A,
    ORACLE_B,
    SOURCE,
    T0,
    addressesOf,
    assert,
    create,
    rowFor,
    runOne,
} = require('./support.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('several DISPENSER sub-commands in one BATCH', function () {

        it('registers every one of them on distinct operating addresses', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A }),
                create({ getAddress: DELEGATE_B }),
                create({}),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows),
                [DELEGATE_A, DELEGATE_B, SOURCE].sort())
            for (const row of decoder.model.rows)
                assert.strictEqual(row.txIndex, 1, 'all three share the transaction index')
        })

        it('gives each sub-command its OWN expiration, not the transaction one', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, expiration: EXP_EARLY }),
                create({ getAddress: DELEGATE_B, expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).expiration, EXP_EARLY)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).expiration, EXP_LATE)
        })

        it('gives each sub-command its OWN oracle address', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, oracle: ORACLE_A }),
                create({ getAddress: DELEGATE_B, oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).oracleAddress, ORACLE_A)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).oracleAddress, ORACLE_B)
        })

        it('defaults expiration PER SUB-COMMAND while a sibling keeps its explicit one', async () => {
            // The default is derived from the shared BLOCK TIME, exactly as the indexer's
            // util.getDefaultExpiration is for a batched sub-command, but the CHOICE to
            // default is per command.
            const decoder = await runOne('BATCH|0|' + [
                CREATE_NO_TAIL + '|' + DELEGATE_A,
                create({ getAddress: DELEGATE_B, expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).expiration,
                decoder.getDefaultExpiration(T0))
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).expiration, EXP_EARLY)
        })

        it('skips only the sub-command with an out-of-range EXPIRATION', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, expiration: '1700000000.5' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips only the sub-command with a compacted ^ GET_ADDRESS', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: '^4711' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips only the sub-command whose coins name another chain', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, giveCoin: 'DOGE', getCoin: 'DOGE' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips a sub-command whose optional tail is too short to be a create', async () => {
            const decoder = await runOne('BATCH|0|' + [
                'DISPENSER|0|BTC|TICK|1',
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })
    })
})
