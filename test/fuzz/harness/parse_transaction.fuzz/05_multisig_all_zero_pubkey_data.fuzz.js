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

const bitcoin = require('bitcoinjs-lib')
const { PREV_HASH } = require('../../support/mutators/structure_aware')
const { configureSuite, createDecoder, fuzzOne } = require('./support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Multisig with all-zero data ---
    describe('multisig: all-zero pubkey data', () => {
        it('should handle multisig where pubkeys are all zeros', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            const pubkey1 = Buffer.alloc(33, 0x00)
            pubkey1[0] = 0x02
            const pubkey2 = Buffer.alloc(33, 0x00)
            pubkey2[0] = 0x02
            const pubkey3 = Buffer.alloc(33, 0x03)

            const msScript = bitcoin.script.compile([
                bitcoin.opcodes.OP_1,
                pubkey1, pubkey2, pubkey3,
                bitcoin.opcodes.OP_3,
                bitcoin.opcodes.OP_CHECKMULTISIG
            ])
            tx.addOutput(msScript, 1000)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            await fuzzOne(decoder, reporter, tx, 'allzero_multisig')
        })
    })
})
