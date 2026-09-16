// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Open-dispenser REGISTRATION through a BATCH (BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION).
//
// The registry gated on `decodedData.startsWith("DISPENSER")`, which is false for
// `BATCH|0|DISPENSER|0|...`. A dispenser created inside a batch therefore never entered
// getAllOpenDispenserAddresses, so payments to it were never classified as dispense outputs
// and no DISPENSE ever fired - while the INDEXER, which dispatches the sub-command, DID
// register it. Money-bearing (the buyer's coin is spent and nothing comes back) and a live
// decoder/indexer divergence. Third instance of this defect class, already fixed twice elsewhere.
//
// These tests drive the REAL block loop (decoder.start), the same harness
// batchPaymentOutputCapture.test.js uses, and assert on what reaches db.insertDispenser,
// db.extendOpenDispenserExpirationBySource and db.insertTransactionOutput.
//
// Two things this harness models that the row-21 one did not, because registration depends
// on both:
//   * the dispensers PRIMARY KEY (tx_index, address_id). A batch can carry several creates
//     under ONE tx_index, and every create that omits GET_ADDRESS operates on the same
//     SOURCE, so the key really does collide and the second INSERT really does come back
//     DUPLICATED_TRANSACTION.
//   * parseTransaction's dispense/payment split, which is the whole point of the registry:
//     an output paying an OPEN dispenser address becomes a dispense output
//     (XChainDecoder.js ~1344). Without it "registered" proves nothing.
//
// SENSITIVITY: every above-gate BATCH assertion fails against pre-fix code (a batch
// registers nothing at all), and every below-gate assertion fails if the change lands
// ungated.

const {
    ABOVE_GATE,
    BELOW_GATE,
    CREATE_NO_TAIL,
    DELEGATE_A,
    EXP_EARLY,
    EXP_LATE,
    ORACLE_A,
    SOURCE,
    T0,
    assert,
    create,
    refill,
    runAll,
    runOne,
} = require('./batch_dispenser_registration.test/support/helpers.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('a top-level DISPENSER is untouched on both sides of the gate', function () {

        it('registers a top-level create above the gate', async () => {
            const decoder = await runOne(create({ oracle: ORACLE_A }), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.deepStrictEqual(decoder.model.rows[0], {
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null })
        })

        it('registers a top-level create below the gate, byte-identically', async () => {
            const decoder = await runOne(create({ oracle: ORACLE_A }), BELOW_GATE)
            assert.deepStrictEqual(decoder.model.rows, [{
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
        })

        it('defaults an omitted EXPIRATION from the block time on both sides', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(CREATE_NO_TAIL, venue)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].expiration,
                    decoder.getDefaultExpiration(T0))
            }
        })

        it('registers a delegated create on GET_ADDRESS and records the create SOURCE', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(create({ getAddress: DELEGATE_A }), venue)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].address, DELEGATE_A)
                assert.strictEqual(decoder.model.rows[0].sourceAddress, SOURCE)
            }
        })

        it('still extends on a top-level v2 edit, and registers no create row', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                    { id: 'edit01',   action: refill(EXP_LATE),                  source: SOURCE, outputs: [] },
                ], venue)
                assert.strictEqual(decoder.model.rows.length, 1, 'an edit creates no row')
                assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
                assert.strictEqual(decoder.model.extendCalls.length, 1)
            }
        })

        it('skips a top-level create whose coins name another chain, on both sides', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(create({ giveCoin: 'DOGE', getCoin: 'DOGE' }), venue)
                assert.deepStrictEqual(decoder.model.rows, [])
            }
        })
    })
})
