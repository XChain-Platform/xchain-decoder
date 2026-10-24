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
const { readRolledBackAboveTip } = require('./reorg_halt.js')

// Publish the current proof wait without resetting its start time on every poll.
function setReorgWait(err){
    const detail = (err && err.reorgWaitState) || {}
    const next = {
        stored_height: detail.stored_height ?? null,
        stored_hash: detail.stored_hash || null,
        class: detail.class || (err && err.refusalClass) || 'unread'
    }
    const prior = this.reorgWait
    const sameWait = prior && prior.stored_height === next.stored_height
        && prior.stored_hash === next.stored_hash && prior.class === next.class
    next.since = sameWait ? prior.since : new Date().toISOString()
    this.reorgWait = next
}

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

// Answer a failed reconcile: wait on an unproven stored block, park on a
// REORG_HALT refusal, and rethrow anything else. Shared by the three verifyReorg
// call sites so a not-found header never exits the parse loop or deletes a block.
//
// The park height is the stored tip after the rollback, not the loop cursor from
// before it: a halt that rolled back to the fork point leaves the cursor at the old
// branch's tip, so the cursors are re-derived from the database first, exactly as
// the rollback paths do. An unreadable tip keeps the cursor and parks anyway.
//
// Reset-only when the error says so (a safe-depth halt), else when rolled-back
// blocks sit above the tip or their count cannot be read: clear-reorg-halt refuses
// both. A db with no such count keeps the clear-and-resume wording.
async function parkOrRethrow(err, loop){
    if (err && err.reorgWait){
        setReorgWait.call(this, err)
        const refusalClass = err.refusalClass || 'unread'
        if (loop.tipBelowStoredTipRefused !== refusalClass) this.logWarn(err.message)
        loop.tipBelowStoredTipRefused = refusalClass
        await this.sleep(5000)
        return
    }
    if (!(err && err.reorgHalt)) throw err
    try {
        loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
        loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
        loop.blocksQuantity = 0
    } catch (readErr){
        logger.error(formatLogLine('Could not re-read the stored tip before parking; parking at the loop cursor:', readErr))
    }
    let resetOnly = err.resetOnly
    if (typeof resetOnly !== 'boolean'){
        const rolledBack = await readRolledBackAboveTip(this.db)
        resetOnly = rolledBack !== undefined && rolledBack !== 0
    }
    this.parkOnReorgHalt(err.message, loop.lastProcessedBlockIndex, { resetOnly })
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

// One parse-loop step for the REORG_HALT park: when a probe has just seen a halt for
// the first time, run the boot park check first, then, while parked, try to leave
// the park. True while the loop must not parse this pass.
async function reorgHaltHoldsLoop(loop){
    if (this.reorgHaltParkCheckDue){
        this.reorgHaltParkCheckDue = false
        await this.parkOnRolledBackHalt()
    }
    if (!this.reorgHaltParked) return false
    await leaveReorgHaltPark.call(this, loop)
    return true
}

// A different hash at the stored height is a reorg only once two readings of it agree:
// one stray answer (a failover onto an endpoint on another branch) must not roll back
// the stored tip. An unreadable re-read (the node's tip dropped below this height) ends
// the check with nothing deleted; the tip-regression branch takes that case next pass.
async function equalHeightSwapHolds(height, nodeHash, storedHash){
    const settled = await this.settleNodeReading(nodeHash, async () => {
        try {
            return (await this.connector.getBlockHash(height)) || null
        } catch (e){
            logger.error(formatLogLine('Error re-reading the node block hash at height ' + height + ' before a reconcile:', e))
            return null
        }
    }, 'node block hash at height ' + height)
    return settled !== null && settled !== storedHash
}

async function reconcileEqualHeightTip(loop){
    loop.tipHashCheckedAt = loop.lastBlockchainInfoRefreshAt
    // Guard ONLY the detection reads: an RPC/DB blip there is transient and
    // should log-and-skip until the next refresh, as before.
    let needsReconcile = false
    let nodeHash = null
    let storedBlock = null
    try {
        nodeHash = await this.connector.getBlockHash(loop.lastProcessedBlockIndex)
        storedBlock = await this.db.getBlockByIndex(loop.lastProcessedBlockIndex)
        needsReconcile = !!(storedBlock && nodeHash && storedBlock.block_hash !== nodeHash)
    } catch (e){
        logger.error(formatLogLine('Error during equal-height tip-hash detection reads, skipping:', e))
    }
    // The node holds the stored tip on its active chain, so any proof wait published
    // earlier is over (a node that was behind has caught up). Without this a resolved
    // wait stays on the health payloads and keeps isStalled() false for good.
    if (storedBlock && nodeHash && storedBlock.block_hash === nodeHash){
        this.reorgWait = null
        loop.tipBelowStoredTipRefused = false
    }
    if (needsReconcile){
        needsReconcile = await equalHeightSwapHolds.call(this, loop.lastProcessedBlockIndex, nodeHash, storedBlock.block_hash)
    }
    if (needsReconcile){
        // Run the reconcile OUTSIDE the detection try so a fail-closed verifyReorg
        // abort is never swallowed as a transient blip, which left a partially
        // rolled-back DB under a stale in-memory cursor while this.synced stayed
        // true. Its own catch classifies rather than swallows: a REORG_HALT
        // refusal parks the loop (nothing a restart can fix), every other abort
        // still propagates out of start() and halts loudly.
        this.logWarn("Equal-height tip replacement detected at height " + loop.lastProcessedBlockIndex + ". Reconciling...")
        await this.db.endTransaction()
        try {
            await this.verifyReorg(this.blockchainInfoLastBlock)
        } catch (err){
            await parkOrRethrow.call(this, err, loop)
            return 'continue'
        }
        this.reorgWait = null
        loop.tipBelowStoredTipRefused = false
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

module.exports = { resetAfterRollback, setReorgWait, parkOrRethrow, leaveReorgHaltPark, reorgHaltHoldsLoop, waitAtTip }
