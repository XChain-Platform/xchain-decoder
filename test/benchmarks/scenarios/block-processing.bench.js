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
 * Block processing benchmark.
 *
 * Measures end-to-end block processing throughput (blockFromHex + parse all
 * transactions + mock DB writes) for empty, light, and dense blocks.
 */

const DEFAULT_BLOCK_COUNT = 100

module.exports = {
    name: 'block-processing',
    description: 'End-to-end block processing at varying transaction densities',

    async run(decoder, generator, metrics, config = {}) {
        const blockCount = config.blockCount || DEFAULT_BLOCK_COUNT
        const results = {}

        const scenarios = [
            { label: 'empty',         xchnTxsPerBlock: 0,  plainTxsPerBlock: 0 },
            { label: 'plain_only_10', xchnTxsPerBlock: 0,  plainTxsPerBlock: 10 },
            { label: 'light_5',       xchnTxsPerBlock: 5,  plainTxsPerBlock: 5 },
            { label: 'medium_20',     xchnTxsPerBlock: 20, plainTxsPerBlock: 10 },
            { label: 'dense_50',      xchnTxsPerBlock: 50, plainTxsPerBlock: 20 }
        ]

        for (const scenario of scenarios) {
            // Reset generator state for clean block chain
            generator.reset()

            // Generate blocks
            const { blocks } = generator.generateBlockChain(blockCount, {
                xchnTxsPerBlock: scenario.xchnTxsPerBlock,
                plainTxsPerBlock: scenario.plainTxsPerBlock
            })

            // Load funding txs into mock connector
            for (const block of blocks) {
                for (const [txid, hex] of block.fundingTxStore) {
                    decoder.connector.transactions.set(txid, hex)
                }
            }

            // Reset DB mock counts
            decoder.db.resetCounts()

            let totalTxsParsed = 0
            let totalXchnFound = 0

            // Warm up with first 2 blocks
            for (let i = 0; i < Math.min(2, blocks.length); i++) {
                const block = decoder.xchainBlockDecoder.blockFromHex(blocks[i].blockHex)
                for (const tx of block.transactions) {
                    await decoder.parseTransaction(tx)
                }
            }

            // Timed run
            const startTime = process.hrtime.bigint()
            const startMem = process.memoryUsage()

            for (let i = 0; i < blocks.length; i++) {
                const block = decoder.xchainBlockDecoder.blockFromHex(blocks[i].blockHex)

                for (const tx of block.transactions) {
                    const result = await decoder.parseTransaction(tx)
                    totalTxsParsed++
                    if (result && result.data && result.data.length > 0) {
                        totalXchnFound++
                    }
                }
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const endMem = process.memoryUsage()
            const blocksPerSec = (blocks.length / elapsed) * 1000
            const txsPerSec = (totalTxsParsed / elapsed) * 1000

            metrics.record(`block_${scenario.label}`, elapsed)

            results[scenario.label] = {
                blockCount: blocks.length,
                totalTxsParsed,
                totalXchnFound,
                totalMs: Math.round(elapsed * 100) / 100,
                blocksPerSec: Math.round(blocksPerSec * 10) / 10,
                txsPerSec: Math.round(txsPerSec),
                avgBlockMs: Math.round((elapsed / blocks.length) * 100) / 100,
                memoryDeltaMB: Math.round((endMem.heapUsed - startMem.heapUsed) / 1048576 * 10) / 10,
                dbCalls: { ...decoder.db.callCounts }
            }
        }

        return {
            scenario: 'block-processing',
            blockCount,
            results
        }
    }
}
