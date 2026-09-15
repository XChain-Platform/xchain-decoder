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

    // --- Hypothesis H8: Empty reassembled data buffer ---
    describe('H8: empty data buffer after output loop', () => {
        it('should handle txs where all OP_RETURN outputs decrypt to non-XCHN data', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            // Multiple OP_RETURN outputs, none with XCHN prefix
            for (let i = 0; i < 5; i++) {
                tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, crypto.randomBytes(32)]), 0)
            }
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            await fuzzOne(decoder, reporter, tx, 'empty_reassembled')
        })
    })
})
