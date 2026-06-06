/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Sustained sync benchmark.
 *
 * Simulates catching up from a significant lag by processing a large number
 * of blocks continuously. Measures throughput stability over time and
 * detects memory leaks or performance degradation.
 */

const DEFAULT_BLOCK_COUNT = 500
const SNAPSHOT_INTERVAL = 50  // take memory snapshot every N blocks

module.exports = {
    name: 'sustained-sync',
    description: 'Process many blocks continuously, measuring throughput stability',

    async run(decoder, generator, metrics, config = {}) {
        const blockCount = config.blockCount || DEFAULT_BLOCK_COUNT

        // Generate a realistic mixed chain
        generator.reset()
        const { blocks } = generator.generateBlockChain(blockCount, {
            xchnTxsPerBlock: (i) => {
                // Variable density: mostly light with occasional dense bursts
                if (i % 50 < 3) return 30  // burst every 50 blocks
                return Math.floor(Math.random() * 5) + 1  // 1-5 xchn txs normally
            },
            plainTxsPerBlock: (i) => Math.floor(Math.random() * 8) + 2  // 2-9 plain txs
        })

        // Load all funding transactions
        for (const block of blocks) {
            for (const [txid, hex] of block.fundingTxStore) {
                decoder.connector.transactions.set(txid, hex)
            }
        }

        decoder.db.resetCounts()
        const throughputWindows = []  // blocks/sec measured in windows
        let totalTxs = 0
        let totalXchn = 0

        metrics.start()
        metrics.takeSnapshot('start')

        let windowStart = process.hrtime.bigint()
        let windowBlocks = 0

        for (let i = 0; i < blocks.length; i++) {
            const block = decoder.xchainBlockDecoder.blockFromHex(blocks[i].blockHex)

            for (const tx of block.transactions) {
                const result = await decoder.parseTransaction(tx)
                totalTxs++
                if (result && result.data && result.data.length > 0) {
                    totalXchn++
                }
            }

            windowBlocks++

            // Record throughput window
            if (windowBlocks >= SNAPSHOT_INTERVAL || i === blocks.length - 1) {
                const windowElapsed = Number(process.hrtime.bigint() - windowStart) / 1e6
                throughputWindows.push({
                    blockRange: `${i - windowBlocks + 1}-${i}`,
                    blocksPerSec: Math.round((windowBlocks / windowElapsed) * 1000 * 10) / 10,
                    windowMs: Math.round(windowElapsed)
                })
                metrics.takeSnapshot(`block_${i}`)
                windowStart = process.hrtime.bigint()
                windowBlocks = 0
            }
        }

        metrics.stop()
        metrics.takeSnapshot('end')

        const wallTime = metrics.getWallTime()
        const cpu = metrics.getCpuUsage()
        const eventLoop = metrics.getEventLoopStats()
        const peakMem = metrics.getPeakMemory()

        // Detect throughput degradation: compare first vs last window
        let throughputDelta = null
        if (throughputWindows.length >= 2) {
            const first = throughputWindows[0].blocksPerSec
            const last = throughputWindows[throughputWindows.length - 1].blocksPerSec
            throughputDelta = Math.round(((last - first) / first) * 100 * 10) / 10
        }

        return {
            scenario: 'sustained-sync',
            blockCount,
            totalTxs,
            totalXchn,
            wallTimeMs: Math.round(wallTime),
            blocksPerSec: Math.round((blockCount / wallTime) * 1000 * 10) / 10,
            txsPerSec: Math.round((totalTxs / wallTime) * 1000),
            xchnTxsPerSec: Math.round((totalXchn / wallTime) * 1000),
            cpuUserMs: Math.round(cpu.user / 1000),
            cpuSystemMs: Math.round(cpu.system / 1000),
            peakMemory: peakMem,
            eventLoopLag: eventLoop,
            throughputWindows,
            throughputDeltaPercent: throughputDelta,
            dbCalls: { ...decoder.db.callCounts }
        }
    }
}
