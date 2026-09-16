/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz harness for XChainDecoder#parseTransaction()
 *
 * Targets: OP_RETURN, P2SH, P2WSH, multisig code paths, script decompilation,
 * dispenser detection, source resolution edge cases.
 */

const sinon = require('sinon')
const {
    buildOpReturnTx, randomActionString
} = require('../../support/mutators/structure_aware')
const {
    ITERATIONS, configureSuite, createDecoder, fuzzOne
} = require('./support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Dispenser address match with fuzzed outputs ---
    describe('dispenser detection with various output types', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} txs with dispenser-matching addresses`, async () => {
            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                // Every address matches a dispenser
                decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)

                const action = randomActionString()
                const tx = buildOpReturnTx(action)
                await fuzzOne(decoder, reporter, tx, 'dispenser_match')
            }
        })
    })
})
