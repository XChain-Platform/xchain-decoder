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
 *
 * XChain Decoder - Decoder Class
 *
 * This file handles starting the decoder and parsing blocks and transactions
 *
 ********************************************************************/

const { format: formatLogLine } = require('node:util')
const { logger, CHECK_BLOCK_DELAY_MS, MEMPOOL_INTERVAL, REORG_HALT_PARK_TICK_MS } = require('./constants.js')

// Re-derive the loop cursors from the DB after any mid-block rollback, then
// pause before the retry. Every rollback path MUST run this before continuing:
// in particular lastProcessedTxIndex advances in memory while a block is being
// parsed, so retrying a rolled-back block with the stale counter would assign
// different tx_index values than a clean instance decoding the same block
// (replicated content, so that is a cross-instance divergence, not cosmetics).
async function resetAfterRollback(loop){
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    await this.sleep(3000)
}

// Answer a failed reconcile: park on a REORG_HALT refusal, rethrow anything
// else. Shared by the three verifyReorg call sites so all three classify a halt
// the same way; before this, two of them let it escape start() into the
// exit-and-restart loop parkOnReorgHalt exists to end.
function parkOrRethrow(err, blockHeight){
    if (!(err && err.reorgHalt)) throw err
    this.parkOnReorgHalt(err.message, blockHeight)
}

async function leaveReorgHaltPark(loop){
    if (!(await this.resumeFromReorgHaltPark())){
        await this.sleep(REORG_HALT_PARK_TICK_MS)
        return
    }
    // Resumed. Re-derive the cursors from the stored tip exactly as the
    // rollback paths do, and drop the cached tip so the next pass re-polls
    // the node and re-runs the reorg check the clear has now unblocked.
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    loop.lastBlockchainInfo = null
}

async function reconcileEqualHeightTip(loop){
    loop.tipHashCheckedAt = loop.lastBlockchainInfoRefreshAt
    // Guard ONLY the detection reads: an RPC/DB blip there is transient and
    // should log-and-skip until the next refresh, as before.
    let needsReconcile = false
    try {
        const nodeHash = await this.connector.getBlockHash(loop.lastProcessedBlockIndex)
        const storedBlock = await this.db.getBlockByIndex(loop.lastProcessedBlockIndex)
        needsReconcile = !!(storedBlock && nodeHash && storedBlock.block_hash !== nodeHash)
    } catch (e){
        logger.error(formatLogLine('Error during equal-height tip-hash detection reads, skipping:', e))
    }
    if (needsReconcile){
        // Run the reconcile OUTSIDE the detection try so a fail-closed verifyReorg
        // abort is never swallowed as a transient blip, which left a partially
        // rolled-back DB under a stale in-memory cursor while this.synced stayed
        // true. Its own catch classifies rather than swallows: a REORG_HALT
        // refusal parks the loop (nothing a restart can fix), every other abort
        // still propagates out of start() and halts loudly.
        this.log("Equal-height tip replacement detected at height " + loop.lastProcessedBlockIndex + ". Reconciling...")
        await this.db.endTransaction()
        try {
            await this.verifyReorg(this.blockchainInfoLastBlock)
        } catch (err){
            parkOrRethrow.call(this, err, loop.lastProcessedBlockIndex)
            return 'continue'
        }
        loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
        loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
        loop.blocksQuantity = 0
        return 'continue'
    }
}

async function waitAtTip(loop){
    this.synced = true
    if (this.mempoolInterval == null){
        logger.info("Mempool parsing started!")
        this.updateMempool().catch(err => logger.error(formatLogLine('[updateMempool] unhandled error:', err)))
        this.mempoolInterval = setInterval(() => {
            this.updateMempool().catch(err => logger.error(formatLogLine('[updateMempool] unhandled error:', err)))
        }, MEMPOOL_INTERVAL)
    }

    // Equal-height tip-replacement check: if the node swapped its tip
    // for a different block at the same height (rare but possible), the
    // forward hash-compare below never fires until the NEXT block arrives.
    // Compare the node's current tip hash against the stored one on each
    // blockchain-info refresh (throttled so we add at most one RPC + one
    // DB query per 30-second refresh cycle, not every 1-second sleep tick).
    if (loop.lastBlockchainInfoRefreshAt > loop.tipHashCheckedAt && loop.lastProcessedBlockIndex >= this.startBlockIndex){
        if ((await reconcileEqualHeightTip.call(this, loop)) === 'continue') return
    }

    await this.sleep(CHECK_BLOCK_DELAY_MS)
}

module.exports = { resetAfterRollback, parkOrRethrow, leaveReorgHaltPark, waitAtTip }
