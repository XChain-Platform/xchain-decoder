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
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    SELLER,
    SOURCE,
    DispenserModel,
    assert,
    buildDecoder,
    create,
} = require('./support.js')

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('registration rides the SAME flag-day as payment-output capture', function () {

        // ONE gate, not two. The registry IS the address set that decides which outputs are
        // captured as dispenses, so a decoder that registered batch dispensers at one instant
        // and captured batch payment outputs at another would be half-batch-aware for a
        // stretch of chain with nothing gained. This drives the REAL helper by arming mainnet
        // in place, and fails the moment someone gives registration its own constant.
        const ARMED = 1789430400
        const BATCHED = 'BATCH|0|COINPAY|0|101;' + create({})
        const OUTPUTS = [{ destinationAddress: SELLER, vout: 0, amount: 100000000 }]

        async function probe(blockTime) {
            const model = new DispenserModel()
            const decoder = buildDecoder(
                [{ id: 'tx01', action: BATCHED, source: SOURCE, outputs: OUTPUTS }],
                model, { network: 'bitcoin-mainnet', blockTime, feeDestination: null })
            await decoder.start()
            return { registered: model.rows.length, captured: decoder.captured.length }
        }

        it('both are off one second below the instant and on AT it', async () => {
            const saved = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet
            BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = ARMED
            try {
                assert.deepStrictEqual(await probe(ARMED - 1), { registered: 0, captured: 0 })
                assert.deepStrictEqual(await probe(ARMED),     { registered: 1, captured: 1 })
            } finally {
                BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = saved
            }
            // Restore to the PRE-PROBE value, never to a baseline written in here: this test
            // borrows the map, so it owes back exactly what it took. A hardcoded baseline made
            // an operator arming mainnet fail in a test that is not about the instant at all.
            assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, saved,
                'the map must be back to its pre-probe value')
            // Behavioural half of the same check, one second below whatever mainnet now
            // carries; a DISARMED map is inactive at every block time, so the probe instant
            // serves there.
            const belowRestored = typeof saved === 'number' ? saved - 1 : ARMED
            assert.deepStrictEqual(await probe(belowRestored), { registered: 0, captured: 0 },
                'the decoder follows the restored map, not the probe value')
        })
    })
})
