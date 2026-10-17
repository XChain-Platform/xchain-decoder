/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * A single stale tip reading is not a rollback.
 *
 * One getblockchaininfo reply that runs behind the real tip (an RPC failover
 * onto a lagging fallback endpoint is the realistic source) must not send the
 * decoder into verifyReorg: acting on it would delete valid blocks and write
 * REORG markers (one reply 3 low, 3 of each; one reply 100 low, 100), and those
 * markers feed the indexer, so the marker stream would follow RPC timing
 * instead of chain history. A lower tip (and a swapped hash at the stored
 * height) is acted on only once two readings TIP_SETTLE_DELAY_MS apart agree, the
 * rule xchain-utxo-tracker already applies; a real, settled reorg rolls back
 * exactly what it did before.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { refreshChainTip } = require('../../../src/XChainDecoder/tip_refresh.js')
const { waitAtTip } = require('../../../src/XChainDecoder/sync_loop.js')

function makeDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.chainGenesisHash = null
    decoder.sleep = async () => {}
    return decoder
}

const info = (blocks) => ({ chain: 'regtest', blocks, verificationprogress: 1, initialblockdownload: false })

// A stored chain 0..top whose hashes agree with the node at and below `nodeTip`
// (and, above it, belong to a branch the node no longer has). `tips` is the run
// of getblockchaininfo heights the node answers in turn; the last one repeats.
function decoderOver({ top, nodeTip, tips, forkAt = null }) {
    const decoder = makeDecoder()
    const state = { top, deleted: [], markers: [], tipReads: 0 }
    const stored = (h) => (forkAt != null && h > forkAt ? 'old' + h : 'hash' + h)
    decoder.connector = {
        getBlockchainInfo: async () => info(tips[Math.min(state.tipReads++, tips.length - 1)]),
        getBlockHash: async (h) => {
            if (h > nodeTip) throw new Error('Block height out of range')
            return 'hash' + h
        }
    }
    decoder.db = {
        endTransaction:            async () => {},
        getLastBlockIndex:         async () => state.top,
        getLastTxIndex:            async () => 0,
        getBlockByIndex:           async (h) => (h < 0 || h > state.top ? null : { block_index: h, block_hash: stored(h) }),
        // The REORG marker commits with its delete, so the two lists move together.
        deleteBlockByIndex:        async (h, hash) => { state.deleted.push(h); state.markers.push({ block_index: h, block_hash: hash }); state.top = h - 1; return true },
        isReorgHalted:             async () => false,
        countReorgDeletesAboveTip: async () => 0,
        markReorgHalted:           async () => true
    }
    return { decoder, state }
}

// One parse-loop pass at the stored tip, as startup.js runs it.
async function onePass(decoder, top) {
    const loop = { lastProcessedBlockIndex: top }
    const result = await refreshChainTip.call(decoder, loop, top)
    return { loop, result }
}

describe('a node tip below the stored tip is settled before any rollback [REGRESSION P1]', function () {

    it('one stale reply 3 below the real tip deletes nothing and writes no REORG marker', async function () {
        const { decoder, state } = decoderOver({ top: 200, nodeTip: 200, tips: [197, 200] })
        const { result } = await onePass(decoder, 200)
        assert.strictEqual(result, 'continue')
        assert.deepStrictEqual(state.deleted, [], 'valid blocks rolled back on one stale reading')
        assert.deepStrictEqual(state.markers, [])
        assert.strictEqual(decoder.blockchainInfoLastBlock, 200, 'the settled reading replaces the stale one')
    })

    it('one stale reply 100 below the real tip deletes nothing and writes no REORG marker', async function () {
        const { decoder, state } = decoderOver({ top: 200, nodeTip: 200, tips: [100, 200] })
        await onePass(decoder, 200)
        assert.deepStrictEqual(state.deleted, [])
        assert.deepStrictEqual(state.markers, [])
        assert.strictEqual(decoder.blockchainInfoLastBlock, 200)
    })

    it('a tip that keeps moving ends the pass with nothing deleted', async function () {
        const { decoder, state } = decoderOver({ top: 200, nodeTip: 200, tips: [190, 191, 192, 193, 194, 195, 196] })
        const { result } = await onePass(decoder, 200)
        assert.strictEqual(result, 'continue')
        assert.deepStrictEqual(state.deleted, [])
        assert.strictEqual(state.tipReads, 6, 'the first reading plus five re-reads, then give up')
    })

    it('an unreadable re-read ends the pass with nothing deleted', async function () {
        const { decoder, state } = decoderOver({ top: 200, nodeTip: 194, tips: [194] })
        let reads = 0
        decoder.connector.getBlockchainInfo = async () => {
            if (reads++ === 0) return info(194)
            throw new Error('ECONNREFUSED')
        }
        await onePass(decoder, 200)
        assert.deepStrictEqual(state.deleted, [])
    })
})

describe('a settled lower tip rolls back exactly as before [REGRESSION P1]', function () {

    it('a settled real rollback deletes and marks exactly what it did before the settle', async function () {
        // Today's behaviour, measured by calling verifyReorg with the same tip directly.
        const direct = decoderOver({ top: 200, nodeTip: 194, tips: [194] })
        await direct.decoder.verifyReorg(194)

        const { decoder, state } = decoderOver({ top: 200, nodeTip: 194, tips: [194] })
        const { loop } = await onePass(decoder, 200)
        assert.deepStrictEqual(state.deleted, [200, 199, 198, 197, 196, 195])
        assert.deepStrictEqual(state.deleted, direct.state.deleted)
        assert.deepStrictEqual(state.markers, direct.state.markers)
        assert.strictEqual(loop.lastProcessedBlockIndex, 194, 'the cursor is re-derived after the rollback')
        assert.strictEqual(decoder.reorgCount, 1)
    })

    it('a settled real reorg below a lower tip still walks back to the fork point', async function () {
        // Node dropped to 196 on a branch that forked at 193: 200..197 are above the
        // tip, 196..194 differ by hash, 193 agrees.
        const direct = decoderOver({ top: 200, nodeTip: 196, tips: [196], forkAt: 193 })
        await direct.decoder.verifyReorg(196)

        const { decoder, state } = decoderOver({ top: 200, nodeTip: 196, tips: [196], forkAt: 193 })
        await onePass(decoder, 200)
        assert.deepStrictEqual(state.deleted, [200, 199, 198, 197, 196, 195, 194])
        assert.deepStrictEqual(state.markers, direct.state.markers)
    })
})

describe('the mid-walk tip refresh is settled before it moves the tip down [REGRESSION P1]', function () {

    it('one stale reading during a walk does not turn valid blocks into above-tip deletes', async function () {
        // Stored 0..105 all agree with a node at 105. A transient getBlockHash fault at
        // 105 sends the walk to its tip refresh, which answers 102 once.
        const { decoder, state } = decoderOver({ top: 105, nodeTip: 105, tips: [102, 105] })
        let faults = 0
        const real = decoder.connector.getBlockHash
        decoder.connector.getBlockHash = async (h) => {
            if (h === 105 && faults++ === 0) throw new Error('ETIMEDOUT')
            return real(h)
        }
        assert.strictEqual(await decoder.verifyReorg(105), true)
        assert.deepStrictEqual(state.deleted, [])
    })

    it('a settled lower tip mid-walk still drains the blocks above it', async function () {
        const { decoder, state } = decoderOver({ top: 105, nodeTip: 102, tips: [102] })
        assert.strictEqual(await decoder.verifyReorg(105), true)
        assert.deepStrictEqual(state.deleted, [105, 104, 103])
    })
})

describe('an equal-height tip swap is settled before the reconcile [REGRESSION P1]', function () {

    function atTip(hashes) {
        const { decoder, state } = decoderOver({ top: 200, nodeTip: 200, tips: [200] })
        let reads = 0
        const real = decoder.connector.getBlockHash
        decoder.connector.getBlockHash = async (h) => {
            if (h === 200 && reads < hashes.length) return hashes[reads++]
            return real(h)
        }
        decoder.mempoolInterval = 1
        decoder.blockchainInfoLastBlock = 200
        const loop = { lastProcessedBlockIndex: 200, lastBlockchainInfoRefreshAt: 2, tipHashCheckedAt: 1 }
        let reconciles = 0
        const verifyReorg = decoder.verifyReorg.bind(decoder)
        decoder.verifyReorg = async (tip) => { reconciles++; return verifyReorg(tip) }
        return { decoder, state, loop, reconciles: () => reconciles }
    }

    it('one stray hash at the stored height does not start a reconcile', async function () {
        const { decoder, state, loop, reconciles } = atTip(['stray200'])
        await waitAtTip.call(decoder, loop)
        assert.strictEqual(reconciles(), 0)
        assert.deepStrictEqual(state.deleted, [])
    })

    it('a swap that holds across two readings reconciles as before', async function () {
        // The node's block at 200 really is different: every read answers 'new200'.
        const { decoder, state, loop, reconciles } = atTip(['new200', 'new200', 'new200', 'new200'])
        await waitAtTip.call(decoder, loop)
        assert.strictEqual(reconciles(), 1)
        assert.deepStrictEqual(state.deleted, [200])
    })
})
