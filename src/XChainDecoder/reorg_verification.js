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
const { chainTierMismatch } = require('../protocol/chain_identity')
const { logger, DISPENSER_EXPIRE_SAFE_DEPTH } = require('./constants.js')
const { haltReorg } = require('./reorg_halt.js')

function safeDepthFor(decoder){
    return decoder.dispenserExpireSafeDepth || DISPENSER_EXPIRE_SAFE_DEPTH
}

function refuseHaltedRollback(){
    // Mirror the durable marker into the in-memory health state so the health
    // surface agrees with the abort even before the next TTL probe.
    this.reorgHalted = true
    this.reorgHaltCheckedAt = Date.now()
    const msg = "verifyReorg: decoder is HALTED from a prior over-deep reorg abort. Refusing to "
        + "roll back further: a restart must not silently resume a rollback past the dispenser "
        + "safe-depth window (DISPENSER_EXPIRE_SAFE_DEPTH=" + safeDepthFor(this) + "), which "
        + "would permanently lose money-bearing dispenser state. Recovery: perform a full resync "
        + "from a known-good snapshot."
    logger.error(msg)
    // Tagged so the parse loop parks on this refusal instead of exiting into a
    // restart loop: the marker outlives every restart and is released only by
    // an audited operator clear, which lands while this process runs.
    const err = new Error(msg)
    err.reorgHalt = true
    throw err
}

async function readPriorRollbackDepth(){
    let priorDepth = 0
    let seedErr = null
    for (let attempt = 1; attempt <= 3; attempt++){
        try {
            priorDepth = await this.db.countReorgDeletesAboveTip(safeDepthFor(this) + 1)
            seedErr = null
            break
        } catch (err){
            seedErr = err
            logger.error(formatLogLine(`reorg: could not read the prior rollback depth (attempt ${attempt}/3)`, err))
            if (attempt < 3) await this.sleep(3000)
        }
    }
    if (seedErr){
        const msg = 'verifyReorg: the prior rollback depth could not be read, so the dispenser '
            + 'safe-depth ceiling cannot be enforced across a restart. Refusing to delete any block: '
            + (seedErr.message || String(seedErr))
        logger.error(msg)
        throw new Error(msg)
    }
    return priorDepth
}

// Fail-closed reorg-depth ceiling, parity with xchain-utxo-tracker's
// UNDO_BLOCKS guard (XChainUtxoTracker.js verifyReorg). Soft-expired
// dispensers are hard-purged once DISPENSER_EXPIRE_SAFE_DEPTH blocks
// deep (purgeExpiredDispensers), and deleteBlockByIndex can only
// resurrect a dispenser whose expired_block_index row still exists, so
// rolling back past that window would silently and permanently lose
// money-bearing dispenser state vs a from-scratch sync. A loud abort is
// strictly safer than a silently corrupt DB: stop and require an
// operator-driven resync. Called BEFORE each delete attempt (outside
// the per-block retry try/catch, so the throw is not retried away).
//
// The ceiling is measured over priorDepth + this run's deletes, because the
// dispenser purge window is a property of the DATABASE, not of one process:
// 100 blocks deleted before a restart and 100 after are 200 blocks past the
// tip either way, and counting only the current invocation is what let a
// restart finish an aborted over-deep rollback.
async function assertWithinSafeDepth(lastBlockIndex, priorDepth, blocksDeleted){
    const safeDepth = safeDepthFor(this)
    if (priorDepth + blocksDeleted.length >= safeDepth){
        const msg = "verifyReorg: reorg depth exceeds the dispenser safe-depth window "
            + "(DISPENSER_EXPIRE_SAFE_DEPTH=" + safeDepth + "). Already rolled back "
            + (priorDepth + blocksDeleted.length) + " blocks (" + blocksDeleted.length
            + " in this run, resumed from " + priorDepth + " already deleted above the tip); "
            + "soft-expired dispenser rows for block height "
            + lastBlockIndex + " and below have already been hard-purged, so continuing would "
            + "silently lose money-bearing dispenser state. Aborting. Recovery: perform a full "
            + "resync from a known-good snapshot."
        logger.error(msg)
        await haltReorg.call(this, msg, blocksDeleted)
        // Same tag as the entry guard above, and for the same reason: the marker
        // haltReorg just wrote is what every later rollback will refuse on, so
        // the parse loop parks rather than exiting. The delete-failure halts
        // below are deliberately NOT tagged: those are infrastructure faults,
        // where a fresh process and a fresh pool are a real repair attempt, and
        // their marker parks the next boot through the entry guard anyway.
        const err = new Error(msg)
        err.reorgHalt = true
        throw err
    }
}

async function deleteAboveTipBlock(lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount){
    await assertWithinSafeDepth.call(this, lastBlockIndex, priorDepth, blocksDeleted)

    // This branch knows its depth up front: every stored height above the
    // node tip is a delete. When that alone (on top of what is already
    // rolled back) would cross the ceiling, refuse NOW, before the first
    // delete, and WITHOUT the durable halt: nothing has been rolled back
    // past the window, so nothing is lost and no resync is owed. The
    // ceiling check above stays the authority once deletes have happened;
    // this only stops a run that is doomed from its first block from
    // spending the whole window to find that out (an operator's mainnet
    // node 2666 blocks behind lost 126 valid blocks and forty hours to
    // exactly that, 2026-09-07). Tagged so the parse loop can wait on it
    // instead of exiting into a restart loop.
    const aboveTip = lastBlockIndex - nodeTip
    const alreadyRolledBack = priorDepth + blocksDeleted.length
    const safeDepth = safeDepthFor(this)
    if (alreadyRolledBack + aboveTip > safeDepth){
        const msg = "verifyReorg: the node's tip (" + nodeTip + ") is " + aboveTip
            + " blocks below the stored tip (" + lastBlockIndex + "), which"
            + (alreadyRolledBack > 0 ? " with " + alreadyRolledBack + " block(s) already rolled back" : "")
            + " exceeds the dispenser safe-depth window (DISPENSER_EXPIRE_SAFE_DEPTH="
            + safeDepth + "). Refusing before any further delete: nothing has been "
            + "rolled back past the window, no REORG_HALT marker was written and this database needs "
            + "no resync. Either the node is still catching up (wait for it to pass " + lastBlockIndex
            + ") or it was rolled back below this database's tip (operator action)."
        // Not logged here: the parse loop retries this every poll and logs
        // the refusal once per transition; other callers let it escape.
        const err = new Error(msg)
        err.tipBelowStoredTip = true
        throw err
    }
    try {
        // Pass the block hash so the delete and its REORG audit marker commit
        // atomically; see deleteBlockByIndex for the durability rationale.
        await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])
        retryCount = 0
        blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
    } catch (err){
        logger.error(formatLogLine(`reorg: failed to delete above-tip block ${lastBlockIndex} (${lastBlock.block_hash}): `, err))
        if (++retryCount >= 10){ await haltReorg.call(this, 'verifyReorg: deleteBlockByIndex failed after 10 attempts (above-tip branch)', blocksDeleted); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
        await this.sleep(3000)
    }
    return retryCount
}

async function refreshReorgTip(nodeTip){
    try {
        const info = await this.connector.getBlockchainInfo()
        // Apply the block loop's chain-identity gate here too. This is
        // the SECOND path a node tip reaches nodeTip, and nodeTip is exactly what
        // the above-tip branch deletes valid local blocks against, so a foreign
        // endpoint answering this refresh reopens the data-loss path the loop-top
        // gate closes. On a proven mismatch keep the call-time tip and fall through
        // to the existing sleep-and-retry: refusing to move the tip is the
        // recoverable direction, deleting against another chain's height is not.
        const reorgChainMismatch = info ? chainTierMismatch(this.consensusNetwork, info["chain"]) : null
        if (reorgChainMismatch){
            this.logError('reorg: ignoring a tip refresh from a foreign endpoint: ' + reorgChainMismatch)
        } else if (info && typeof info.blocks === 'number') {
            // Tier agreement is not chain identity: a same-tier foreign node (BTC-mainnet
            // and DOGE-mainnet both report chain="main") passes the tier gate above, so
            // re-prove the chain with the genesis pin too, exactly as the block loop does
            // before it trusts a refreshed tip. verifyChainGenesis() never throws and returns
            // null when unpinned/unreadable/agreeing, so on anything but a PROVEN mismatch the
            // tip advances as before; a proven mismatch keeps the call-time tip and falls
            // through to sleep-and-retry (the recoverable direction).
            const reorgGenesisMismatch = await this.verifyChainGenesis()
            if (reorgGenesisMismatch){
                this.logError('reorg: ignoring a tip refresh from a foreign endpoint: ' + reorgGenesisMismatch)
            } else {
                nodeTip = info.blocks
            }
        }
    } catch (refreshErr) { /* node unreachable; retry with the existing tip */ }
    return nodeTip
}

async function deleteForkedBlock(lastBlockIndex, lastBlock, priorDepth, blocksDeleted, retryCount){
    await assertWithinSafeDepth.call(this, lastBlockIndex, priorDepth, blocksDeleted)
    try {
        // Pass the block hash so the delete and its REORG audit marker commit
        // atomically; see deleteBlockByIndex for the durability rationale.
        await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])

        // Per-block retry budget: reset after each successful delete so the
        // 10-attempt limit applies per block, not cumulatively across the whole
        // reorg run. Otherwise a multi-block reorg with one transient failure per
        // block could exhaust the budget and abort, leaving orphan blocks behind.
        retryCount = 0
        blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
    } catch (err){
        logger.error(formatLogLine(`reorg: failed to delete block ${lastBlockIndex} (${lastBlock.block_hash}): `, err))
        if (++retryCount >= 10){ await haltReorg.call(this, 'verifyReorg: deleteBlockByIndex failed after 10 attempts (hash-compare branch)', blocksDeleted); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
        await this.sleep(3000); return retryCount
    }
    return retryCount
}

async function readLastStoredBlock(){
    let lastBlockIndex
    let lastBlock
    try {
        lastBlockIndex = await this.db.getLastBlockIndex()
        lastBlock = await this.db.getBlockByIndex(lastBlockIndex)
    } catch (err){
        // A FAILED read is not a walk terminator. Both helpers retry
        // internally and then throw; letting that throw reach the `!lastBlock`
        // guard below (as the old error-null did) ended the rollback early and
        // returned "reorg reconciled" with orphan blocks still above the fork
        // point, and letting it escape verifyReorg would stop the parse loop
        // outright. Sleep and re-walk instead, exactly like the getBlockHash
        // catch further down: a DB outage is infrastructure, and this walk must
        // not finish until it has actually reconciled. Deliberately NOT a
        // REORG_HALT: that marker blocks every later reorg until an operator
        // clears it, which is the wrong response to a transient read fault.
        logger.error(formatLogLine('reorg: failed to read the last stored block; retrying the walk...', err))
        await this.sleep(3000)
        return null
    }
    return { lastBlockIndex, lastBlock }
}

async function walkReorg(nodeTip, priorDepth, blocksDeleted){
    let thereAreDifferences = true
    let retryCount = 0

    while (thereAreDifferences){
        const stored = await readLastStoredBlock.call(this)
        if (stored === null) continue
        const { lastBlockIndex, lastBlock } = stored

        // Stop the backward walk once the table is exhausted (getLastBlockIndex
        // returns -1 on an empty table, so getBlockByIndex(-1) yields null) or once
        // we have retreated past the configured start height. Without this guard a
        // deep reorg that invalidates every processed block would dereference a null
        // lastBlock below and crash before the REORG event is written, leaving the
        // decoder in an inconsistent restart state.
        if (!lastBlock || lastBlockIndex < this.startBlockIndex){
            thereAreDifferences = false
            break
        }

        // Blocks stored ABOVE the node's current tip are orphans the node no
        // longer has (deep reorg, node rollback, or restart onto a shorter chain).
        // getBlockHash(lastBlockIndex) would throw "Block height out of range",
        // and the transient-error catch below would retry it forever instead of
        // deleting it. Detect this with a deterministic height compare against
        // the tip passed in (no brittle RPC-error-string matching). nodeTip is
        // undefined for legacy callers (e.g. existing verifyReorg-only tests);
        // guard with != null so their behaviour is unchanged. The live parse loop
        // always passes the freshly-refreshed tip.
        if (nodeTip != null && lastBlockIndex > nodeTip){
            retryCount = await deleteAboveTipBlock.call(this, lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount)
            continue
        }

        let blockHashFromNode
        try {
            blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
        } catch (err){
            logger.error(formatLogLine("There was a problem trying to get a block hash from the node. Trying again...", err))
            // The node's tip may have regressed below lastBlockIndex mid-walk (node
            // restart onto a shorter chain, or a second reorg). Against the frozen
            // call-time nodeTip that makes getBlockHash(lastBlockIndex) throw "Block
            // height out of range" on every retry, wedging this walk forever.
            // Best-effort re-read the tip so the above-tip delete branch can
            // classify and delete this now-orphaned height on the next pass. If the
            // node is fully unreachable this refresh also fails and we keep the
            // existing sleep-and-retry outage tolerance (retry-forever) unchanged.
            nodeTip = await refreshReorgTip.call(this, nodeTip)
            await this.sleep(3000)
            continue
        }

        if (lastBlock["block_hash"] != blockHashFromNode){
            retryCount = await deleteForkedBlock.call(this, lastBlockIndex, lastBlock, priorDepth, blocksDeleted, retryCount)
        } else {
            thereAreDifferences = false
        }
    }
}

module.exports = {
    async verifyReorg(nodeTip){
        let blocksDeleted = []

        // Restart-durable halt guard. The safe-depth ceiling below is a per-invocation
        // counter over durably-committed per-block deletes: once it fired the loud
        // abort mid-rollback, nothing persisted the abort, so a plain process restart
        // re-entered here with a zeroed counter and silently completed the over-deep
        // rollback past the dispenser purge window (permanent, money-bearing
        // dispenser-state divergence). Every abort path now persists a durable
        // REORG_HALT marker (markReorgHalted); on entry we refuse to proceed while it
        // is set, so a restart cannot resume an over-deep rollback. Recovery is the
        // full resync the abort message demands (rebuilding the schema clears it).
        // Feature-detected so the minimal-mock verifyReorg tests stay unaffected.
        if (typeof this.db.isReorgHalted === 'function' && await this.db.isReorgHalted()){
            refuseHaltedRollback.call(this)
        }

        // Depth already rolled back and not yet re-synced, carried across restarts.
        //
        // The guard above depends on a marker written on the ABORT path, which is
        // exactly when the database may be the thing failing: markReorgHalted is
        // best-effort, so two failed writes leave the halt recorded nowhere and this
        // entry guard sees a clean database. The counter below does not have that
        // hole, because deleteBlockByIndex commits each block's REORG marker inside
        // the same transaction as the delete: whatever else fails, the evidence of a
        // completed delete is durable. Counting the marked heights above the current
        // tip therefore reconstructs the depth of an interrupted rollback, and the
        // ceiling holds across a restart with no successful abort-time write.
        //
        // Fail-closed: an unreadable count is retried, and a persistent fault throws
        // out of verifyReorg BEFORE any delete. Deliberately NOT a haltReorg - like
        // the walk's read-fault catch below, a read fault is infrastructure, and a
        // durable REORG_HALT would block every later reorg until an operator cleared
        // it. Feature-detected so the minimal-mock verifyReorg tests stay unaffected.
        let priorDepth = 0
        if (typeof this.db.countReorgDeletesAboveTip === 'function'){
            priorDepth = await readPriorRollbackDepth.call(this)
        }

        await walkReorg.call(this, nodeTip, priorDepth, blocksDeleted)

        if (blocksDeleted.length > 0){
            // Each rolled-back block already persisted its own REORG marker atomically with its
            // delete (deleteBlockByIndex), so there is no separate end-of-run event to write.
            // This is only an ops summary of the completed reorg.
            this.log(`reorg: rolled back ${blocksDeleted.length} block(s): ` + JSON.stringify(blocksDeleted.map(b => b.block_index)))
            // Once per RUN, never per deleted block: a per-block increment would report a
            // single depth-5 reorg as five reorgs and destroy the frequency signal.
            this.reorgCount++
            this.lastReorgDepth = blocksDeleted.length
        }

        return true
    },
}
