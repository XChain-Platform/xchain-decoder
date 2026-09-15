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
    EXP_EARLY,
    EXP_LATE,
    ORACLE_A,
    ORACLE_B,
    assert,
    create,
    runOne,
} = require('./support.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('two creates on the SAME operating address (the PRIMARY KEY collision)', function () {

        it('collapses to ONE row carrying the LATER expiration', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                create({ expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE,
                'keeping the EARLIER one closes the decoder while the indexer holds the ' +
                'second dispenser open, and payments to it stop being captured')
            assert.strictEqual(decoder.model.insertCalls, 1,
                'no colliding INSERT is even attempted')
        })

        it('takes the later expiration whichever ORDER the two arrive in', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_LATE }),
                create({ expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })

        it('collapses three same-address creates to one row', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                create({ expiration: EXP_EARLY + 1 }),
                create({ expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
            assert.strictEqual(decoder.model.insertCalls, 1)
        })

        it('keeps the FIRST oracle named, the documented residual', async () => {
            // dispensers.oracle_address_id is one column, so only one of two Mode B
            // dispensers on one address can be recorded. A later v2 refill of the OTHER one
            // captures no oracle-fee output. Pinned so the residual cannot change silently:
            // closing it needs a per-sub-command discriminator in the dispensers PRIMARY KEY.
            const decoder = await runOne('BATCH|0|' + [
                create({ oracle: ORACLE_A }),
                create({ oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].oracleAddress, ORACLE_A)
        })

        it('takes the first NON-EMPTY oracle when the first create names none', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({}),
                create({ oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].oracleAddress, ORACLE_B,
                'an oracle address recorded is an oracle-fee output capturable')
        })
    })
})
