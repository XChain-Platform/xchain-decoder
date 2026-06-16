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
 * Large payload benchmark.
 *
 * Tests how decoding performance scales with ACTION payload size,
 * from small (100B) to maximum (8192B) and oversized (rejected).
 */

const bitcoin = require('bitcoinjs-lib')

const PAYLOAD_SIZES = [100, 500, 1024, 2048, 4096, 6144, 8192]
const DEFAULT_ITERATIONS = 2000

module.exports = {
    name: 'large-payload',
    description: 'Decoding performance scaling with ACTION payload size',

    async run(decoder, generator, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const results = {}

        for (const size of PAYLOAD_SIZES) {
            // Pre-generate transactions with this payload size
            const txData = []
            for (let i = 0; i < iterations; i++) {
                const entry = generator.generateXChainOpReturnTx({
                    action: 'SEND|0|XCHAIN|100|destaddr|memo',
                    payloadSize: size
                })
                txData.push(entry)
                decoder.connector.transactions.set(entry.fundingTxId, entry.fundingTxHex)
            }

            // Warm up
            for (let i = 0; i < Math.min(10, txData.length); i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                const tx = bitcoin.Transaction.fromHex(txData[i].txHex)
                await decoder.parseTransaction(tx)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record(`payload_${size}B`, elapsed)

            results[`${size}B`] = {
                payloadSize: size,
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // Compute scaling factor (how much slower is 8KB vs 100B)
        const smallOps = results['100B'].opsPerSec
        const largeOps = results['8192B'].opsPerSec
        const scalingFactor = Math.round((smallOps / largeOps) * 100) / 100

        return {
            scenario: 'large-payload',
            payloadSizes: PAYLOAD_SIZES,
            scalingFactor,
            results
        }
    }
}
