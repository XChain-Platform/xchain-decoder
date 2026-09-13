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
 * Mempool stress benchmark.
 *
 * Tests the updateMempool() cycle with large transaction pools.
 * Measures cycle time, memory usage during Promise.all() batch fetches,
 * and per-transaction processing overhead.
 */

const MEMPOOL_SIZES = [100, 500, 1000, 3000]
const XCHN_RATIO = 0.1  // 10% of mempool txs are XChain

module.exports = {
    name: 'mempool-stress',
    description: 'Mempool update cycle at varying mempool sizes',

    async run(decoder, generator, metrics, config = {}) {
        const results = {}

        for (const mempoolSize of MEMPOOL_SIZES) {
            const entries = generator.generateMempoolEntries(mempoolSize, {
                xchnRatio: XCHN_RATIO
            })

            decoder.connector.mempoolTxIds = []
            for (const entry of entries) {
                decoder.connector.mempoolTxIds.push(entry.txId)
                decoder.connector.transactions.set(entry.txId, entry.txHex)
                if (entry.fundingTxId) {
                    decoder.connector.transactions.set(entry.fundingTxId, entry.fundingTxHex)
                }
            }
            decoder.connector.mempoolTxIds.sort()

            decoder.db.resetCounts()
            decoder.connector.resetCounts()
            decoder.mempoolBusy = false

            const startMem = process.memoryUsage()
            const startTime = process.hrtime.bigint()

            await decoder.updateMempool()

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const endMem = process.memoryUsage()

            metrics.record(`mempool_${mempoolSize}`, elapsed)

            results[`${mempoolSize}_txs`] = {
                mempoolSize,
                totalMs: Math.round(elapsed),
                txsPerSec: Math.round((mempoolSize / elapsed) * 1000),
                memoryDeltaMB: Math.round((endMem.heapUsed - startMem.heapUsed) / 1048576 * 100) / 100,
                peakRssMB: Math.round(endMem.rss / 1048576 * 10) / 10,
                rpcCalls: {
                    getRawMempool: decoder.connector.callCounts.getRawMempool,
                    getRawTransaction: decoder.connector.callCounts.getRawTransaction,
                    getRawTransactions: decoder.connector.callCounts.getRawTransactions
                },
                dbCalls: {
                    insertMempoolTransaction: decoder.db.callCounts.insertMempoolTransaction,
                    deleteAndCompareTxsNotInList: decoder.db.callCounts.deleteAndCompareTxsNotInList
                }
            }
        }

        return {
            scenario: 'mempool-stress',
            xchnRatio: XCHN_RATIO,
            results
        }
    }
}
