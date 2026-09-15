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

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const {
    PREV_HASH, encrypt
} = require('../../support/mutators/structure_aware')
const {
    ITERATIONS, configureSuite, createDecoder, fuzzOne
} = require('./support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- P2WSH with missing/corrupt witness data ---
    describe('P2WSH with missing/corrupt witness', () => {
        it(`should handle ${Math.min(ITERATIONS, 500)} P2WSH txs with corrupt witness`, async () => {
            for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
                const decoder = createDecoder()
                const tx = new bitcoin.Transaction()
                tx.version = 2
                tx.addInput(PREV_HASH, 1)
                tx.ins[0].script = Buffer.alloc(0)

                // Randomly corrupt witness
                const witnessType = crypto.randomInt(5)
                switch (witnessType) {
                    case 0: tx.ins[0].witness = []; break
                    case 1: tx.ins[0].witness = [crypto.randomBytes(10)]; break
                    case 2: tx.ins[0].witness = [crypto.randomBytes(10), crypto.randomBytes(10)]; break
                    case 3: tx.ins[0].witness = [crypto.randomBytes(10), crypto.randomBytes(10), crypto.randomBytes(crypto.randomInt(100))]; break
                    case 4: tx.ins[0].witness = [null, undefined, crypto.randomBytes(10)]; break
                }

                const txid = Buffer.from(PREV_HASH).reverse().toString('hex')
                const marker = encrypt(Buffer.from('XCHNp2wsh'), txid)
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, marker]), 0)
                tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

                await fuzzOne(decoder, reporter, tx, 'p2wsh_corrupt_witness')
            }
        })
    })
})
