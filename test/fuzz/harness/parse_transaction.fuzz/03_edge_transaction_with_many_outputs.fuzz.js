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
const { PREV_HASH } = require('../../support/mutators/structure_aware')
const { configureSuite, createDecoder, fuzzOne } = require('./support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Many outputs ---
    describe('edge: transaction with many outputs', () => {
        it('should handle transaction with 100 random outputs', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            for (let i = 0; i < 100; i++) {
                const scriptType = crypto.randomInt(4)
                switch (scriptType) {
                    case 0: // OP_RETURN
                        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, crypto.randomBytes(crypto.randomInt(76))]), 0)
                        break
                    case 1: // P2PKH
                        tx.addOutput(Buffer.from('76a914' + crypto.randomBytes(20).toString('hex') + '88ac', 'hex'), crypto.randomInt(100000000))
                        break
                    case 2: // random script
                        tx.addOutput(crypto.randomBytes(crypto.randomInt(50) + 2), crypto.randomInt(100000000))
                        break
                    case 3: // empty script
                        tx.addOutput(Buffer.alloc(0), 0)
                        break
                }
            }

            await fuzzOne(decoder, reporter, tx, 'many_outputs')
        })
    })
})
