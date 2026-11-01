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
const { logger, MIN_VERIFICATION_PROGRESS_TO_PARSE } = require('./constants.js')
const { haltReorg } = require('./reorg_halt.js')
const { nodeStillCatchingUp, blockchainInfoWellFormed } = require('./payload_helpers.js')
const { refuseHaltedRollback, readPriorRollbackDepth, assertWithinSafeDepth, requireReorgProof, refuseOrHaltDeepGap } = require('./reorg_verification/reorg_depth.js')
const { finishHaltedWalk } = require('./reorg_verification/halted_walk.js')

async function deleteAboveTipBlock(lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount, walk){
    const block = { block_index: lastBlockIndex, block_hash: lastBlock.block_hash }
    // A high header with confirmations -1 is ambiguous until the stored chain is
    // proven off the active chain at the node's own tip. This check also owns the
    // deep-gap halt, so no durable marker is written for a node that is merely behind.
    await refuseOrHaltDeepGap.call(this, block, nodeTip, priorDepth, blocksDeleted, walk)
    if (walk.haltError) return retryCount
    await requireReorgProof.call(this, block, nodeTip)
    await assertWithinSafeDepth.call(this, lastBlockIndex, priorDepth, blocksDeleted, walk)
    // A halt raised on this block deletes nothing here: the walk hands over to
    // finishHaltedWalk, which deletes only what the node proves it reorged away from.
    if (walk.haltError) return retryCount
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

// Return true while the node is in initial block download or below the parse threshold,
// the block loop's own two gates: the mid-walk refresh keeps its tip then, because a
// catching-up node is waited on, never rolled back (its low tip deletes valid blocks).
function nodeTipStillCatchingUp(info){
    return nodeStillCatchingUp(info) || info["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE
}

// Read the node tip through the block loop's gates. Answers nodeTip unchanged when the
// node cannot be read or a gate refuses the reply (malformed shape, foreign tier, foreign
// genesis, a node still catching up), so a refused reading is never below the tip the walk
// already has.
async function readReorgTip(nodeTip){
    try {
        const info = await this.connector.getBlockchainInfo()
        // Refuse the same malformed shape fetchChainTip refuses: without a numeric
        // verificationprogress the catching-up gate below cannot fire.
        if (info && !blockchainInfoWellFormed(info)){
            this.logWarn('reorg: ignoring a malformed tip refresh (missing or non-numeric blocks/verificationprogress)')
            return nodeTip
        }
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
        } else if (info) {
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
            } else if (nodeTipStillCatchingUp(info)) {
                this.logWarn('reorg: ignoring a tip refresh from a node still catching up')
            } else {
                nodeTip = info.blocks
            }
        }
    } catch (refreshErr) { /* node unreachable; retry with the existing tip */ }
    return nodeTip
}

// Re-read the node tip after a failed hash read mid-walk. A higher or equal tip deletes
// nothing by height and is taken at once; a lower one becomes the height every stored
// block above it is deleted against, so it is taken only once two readings agree. A
// reading that does not settle keeps the current tip and the walk retries. A refused
// re-read answers the current tip, so only two real readings can settle a lower one.
async function refreshReorgTip(nodeTip){
    const tip = await readReorgTip.call(this, nodeTip)
    if (tip === nodeTip || (nodeTip != null && tip >= nodeTip)) return tip
    const settled = await this.settleNodeReading(tip, () => readReorgTip.call(this, nodeTip), 'mid-walk node tip')
    return settled === null ? nodeTip : settled
}

async function deleteForkedBlock(lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount, walk){
    await requireReorgProof.call(this, { block_index: lastBlockIndex, block_hash: lastBlock.block_hash }, nodeTip)
    await assertWithinSafeDepth.call(this, lastBlockIndex, priorDepth, blocksDeleted, walk)
    if (walk.haltError) return retryCount
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

async function walkReorg(nodeTip, priorDepth, blocksDeleted, walk){
    let thereAreDifferences = true
    let retryCount = 0

    while (thereAreDifferences){
        // Halted with a durable marker: one reading per delete no longer suffices.
        if (walk.haltError) return finishHaltedWalk.call(this, nodeTip, priorDepth, blocksDeleted, walk)
        const stored = await readLastStoredBlock.call(this)
        if (stored === null) continue
        const { lastBlockIndex, lastBlock } = stored

        // Stop the backward walk once the table is exhausted (getLastBlockIndex
        // returns -1 on an empty table, so getBlockByIndex(-1) yields null) or once
        // we have retreated past the configured start height. Without this guard a
        // deep reorg that invalidates every processed block would dereference a null
        // lastBlock below and crash before the REORG event is written, leaving the
        // decoder in an inconsistent restart state.
        if (!lastBlock || lastBlockIndex < this.startBlockIndex) break
        // A stored block above the node tip cannot be checked by height because
        // getBlockHash would report it out of range. The height comparison selects
        // the hash-based header proof instead; only confirmations -1 permits deletion.
        // A caller without a node tip reaches the ordinary height-hash comparison.
        if (nodeTip != null && lastBlockIndex > nodeTip){
            retryCount = await deleteAboveTipBlock.call(this, lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount, walk)
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

        // Strict compare: a loose one could coerce a non-string into a false fork that deletes this block.
        if (lastBlock["block_hash"] !== blockHashFromNode){
            retryCount = await deleteForkedBlock.call(this, lastBlockIndex, lastBlock, nodeTip, priorDepth, blocksDeleted, retryCount, walk)
        } else {
            thereAreDifferences = false
        }
    }
}

// Close a walk: throw a halt it recorded, saying whether the halted walk reached the
// fork point or why it stopped above it, else summarise a completed reorg.
function finishReorgRun(blocksDeleted, walk){
    if (walk.haltError){
        this.logWarn(walk.haltStop
            ? `reorg: halted; rolled back ${blocksDeleted.length} block(s) in this run and stopped above the fork point, deleting nothing the node did not prove it reorged away from: ${walk.haltStop}`
            : `reorg: halted; rolled back ${blocksDeleted.length} block(s) in this run, down to the fork point the node confirmed`)
        throw walk.haltError
    }
    if (blocksDeleted.length > 0){
        // Each rolled-back block already persisted its own REORG marker atomically with its
        // delete (deleteBlockByIndex), so there is no separate end-of-run event to write.
        // This is only an ops summary of the completed reorg.
        this.logWarn(`reorg: rolled back ${blocksDeleted.length} block(s): ` + JSON.stringify(blocksDeleted.map(b => b.block_index)))
        // Once per RUN, never per deleted block: a per-block increment would report a
        // single depth-5 reorg as five reorgs and destroy the frequency signal.
        this.reorgCount++
        this.lastReorgDepth = blocksDeleted.length
    }
}

module.exports = {
    async verifyReorg(nodeTip){
        const blocksDeleted = []

        // Restart-durable halt guard. The safe-depth ceiling below is a per-invocation
        // counter over durably-committed per-block deletes: once it fired the loud
        // abort mid-rollback, nothing persisted the abort, so a plain process restart
        // re-entered here with a zeroed counter and silently completed the over-deep
        // rollback past the dispenser purge window (permanent, money-bearing
        // dispenser-state divergence). Every abort path now persists a durable
        // REORG_HALT marker (markReorgHalted); on entry we refuse to proceed while it
        // is set, so a restart cannot resume an over-deep rollback. The refusal names the
        // recovery that fits: `reset ... --with-indexer` while rolled-back blocks sit
        // above the tip, or the audited `clear-reorg-halt` when none do.
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

        // haltError: set once a safe-depth halt is durable, after which finishHaltedWalk
        // rolls back to the fork point only on the node's confirmed readings and the halt
        // is thrown here. haltStop: why that walk stopped above the fork point, if it did.
        const walk = { haltError: null, haltStop: null }
        await walkReorg.call(this, nodeTip, priorDepth, blocksDeleted, walk)

        finishReorgRun.call(this, blocksDeleted, walk)
        return true
    },
}
