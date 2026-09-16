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
const {
    checkParseTransactionResult, configureSuite, createDecoder,
    isInjectedRpcFailure, withTimeout
} = require('./support.cjs')

describe('Fuzz: parseTransaction', function () {
    this.timeout(300000)
    const reporter = configureSuite()

    // --- Transactions with no inputs ---
    describe('edge: transaction with no inputs', () => {
        it('should handle transaction with empty ins array', async () => {
            const decoder = createDecoder()
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
            // tx.ins is empty. This case DID crash: the two genuine crash
            // records this suite ever produced are both from here, a
            // `Cannot read properties of undefined (reading 'hash')` out of
            // parseTransaction. Current code returns null instead, verified
            // by running exactly this input, so the case now guards a fix
            // rather than reporting an open bug.

            try {
                const result = await withTimeout(() => decoder.parseTransaction(tx), 5000)
                // Should return null or handle gracefully
                const check = checkParseTransactionResult(result)
                if (!check.ok) {
                    reporter.recordInvariantViolation(tx, check.violations, 'no_inputs')
                } else {
                    reporter.recordSuccess()
                }
            } catch (err) {
                if (isInjectedRpcFailure(err)) {
                    reporter.recordSuccess()
                } else {
                    reporter.recordCrash(tx, err, 'no_inputs')
                }
            }
        })
    })
})
