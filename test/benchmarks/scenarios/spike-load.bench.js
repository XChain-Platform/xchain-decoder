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
 * Spike load benchmark.
 *
 * Simulates a burst of high-density blocks after a period of low activity.
 * Measures recovery time, memory spike amplitude, and throughput under
 * sudden load increase.
 */

const DEFAULT_CALM_BLOCKS = 50
const DEFAULT_SPIKE_BLOCKS = 30
const DEFAULT_SPIKE_TXS = 100

module.exports = {
    name: 'spike-load',
    description: 'Burst of dense blocks after calm period',

    async run(decoder, generator, metrics, config = {}) {
        const calmBlocks = config.calmBlocks || DEFAULT_CALM_BLOCKS
        const spikeBlocks = config.spikeBlocks || DEFAULT_SPIKE_BLOCKS
        const spikeTxs = config.spikeTxs || DEFAULT_SPIKE_TXS

        generator.reset()

        // Generate calm period (1-2 xchn txs per block)
        const calm = generator.generateBlockChain(calmBlocks, {
            xchnTxsPerBlock: 2,
            plainTxsPerBlock: 3
        })

        // Generate spike period (many xchn txs per block)
        const spike = generator.generateBlockChain(spikeBlocks, {
            xchnTxsPerBlock: spikeTxs,
            plainTxsPerBlock: 5
        })

        // Load all funding txs
        const allBlocks = [...calm.blocks, ...spike.blocks]
        for (const block of allBlocks) {
            for (const [txid, hex] of block.fundingTxStore) {
                decoder.connector.transactions.set(txid, hex)
            }
        }

        decoder.db.resetCounts()
        metrics.start()
        metrics.takeSnapshot('before_calm')

        // Process calm blocks
        const calmStart = process.hrtime.bigint()
        let calmTxs = 0

        for (const blockData of calm.blocks) {
            const block = decoder.xchainBlockDecoder.blockFromHex(blockData.blockHex)
            for (const tx of block.transactions) {
                await decoder.parseTransaction(tx)
                calmTxs++
            }
        }

        const calmElapsed = Number(process.hrtime.bigint() - calmStart) / 1e6
        metrics.takeSnapshot('after_calm')

        // Process spike blocks
        const spikeStart = process.hrtime.bigint()
        let spikeTxsProcessed = 0
        let spikeXchn = 0

        for (const blockData of spike.blocks) {
            const block = decoder.xchainBlockDecoder.blockFromHex(blockData.blockHex)
            for (const tx of block.transactions) {
                const result = await decoder.parseTransaction(tx)
                spikeTxsProcessed++
                if (result && result.data && result.data.length > 0) {
                    spikeXchn++
                }
            }
        }

        const spikeElapsed = Number(process.hrtime.bigint() - spikeStart) / 1e6
        metrics.takeSnapshot('after_spike')
        metrics.stop()

        const peakMem = metrics.getPeakMemory()
        const eventLoop = metrics.getEventLoopStats()

        return {
            scenario: 'spike-load',
            calm: {
                blocks: calmBlocks,
                txs: calmTxs,
                totalMs: Math.round(calmElapsed),
                blocksPerSec: Math.round((calmBlocks / calmElapsed) * 1000 * 10) / 10,
                txsPerSec: Math.round((calmTxs / calmElapsed) * 1000)
            },
            spike: {
                blocks: spikeBlocks,
                txsPerBlock: spikeTxs,
                totalTxs: spikeTxsProcessed,
                xchnTxs: spikeXchn,
                totalMs: Math.round(spikeElapsed),
                blocksPerSec: Math.round((spikeBlocks / spikeElapsed) * 1000 * 10) / 10,
                txsPerSec: Math.round((spikeTxsProcessed / spikeElapsed) * 1000)
            },
            throughputRatio: Math.round(
                ((calmBlocks / calmElapsed) / (spikeBlocks / spikeElapsed)) * 100
            ) / 100,
            peakMemory: peakMem,
            eventLoopLag: eventLoop,
            dbCalls: { ...decoder.db.callCounts }
        }
    }
}
