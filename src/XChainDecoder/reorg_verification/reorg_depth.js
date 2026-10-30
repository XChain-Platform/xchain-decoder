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
 * XChain Decoder - reorg depth ceiling and halt
 *
 * The dispenser safe-depth ceiling verifyReorg enforces, the durable halt it raises,
 * the entry guard on a halted database, and the fork-depth check an above-tip
 * rollback runs before its first delete. The walk that finishes a halted rollback is
 * halted_walk.js. Used by reorg_verification.js.
 *
 ********************************************************************/

const { format: formatLogLine } = require('node:util')
const { logger, DISPENSER_EXPIRE_SAFE_DEPTH } = require('../constants.js')
const { haltReorg, RESET_RECOVERY } = require('../reorg_halt.js')
const { proveForkReorgedAway, UNKNOWN_BLOCK_NOTE } = require('./reorged_away_proof.js')

function safeDepthFor(decoder){
    return decoder.dispenserExpireSafeDepth || DISPENSER_EXPIRE_SAFE_DEPTH
}

// The recovery tail of every safe-depth halt this file raises.
const SAFE_DEPTH_HALT_RECOVERY = "Once the halt marker is durable the rollback goes on down to the fork point only "
    + "where the node confirms the fork point with two agreeing readings, reports confirmations -1 for every "
    + "deleted stored block, and the whole rollback fits two safe-depth windows, and the decoder parks. Recovery: " + RESET_RECOVERY
    + " (a full re-decode of this decoder and its indexer). clear-reorg-halt refuses this halt whenever it left "
    + "rolled-back blocks above the stored tip: it needs that range re-parsed, and a halted decoder never re-parses it."

function refuseHaltedRollback(){
    // Mirror the durable marker into the in-memory health state so the health
    // surface agrees with the abort even before the next TTL probe.
    this.reorgHalted = true
    this.reorgHaltCheckedAt = Date.now()
    // Both recoveries are named, because which one applies turns on what the halt
    // left above the tip, and this guard runs before anything is counted. The park
    // that follows reads the count and names the one that fits (parkOrRethrow).
    const msg = "verifyReorg: decoder is HALTED from a prior over-deep reorg abort. Refusing to "
        + "roll back further: a restart must not silently resume a rollback past the dispenser "
        + "safe-depth window (DISPENSER_EXPIRE_SAFE_DEPTH=" + safeDepthFor(this) + "), which "
        + "would permanently lose money-bearing dispenser state. Recovery: " + RESET_RECOVERY
        + " while rolled-back blocks sit above the stored tip, which a halted decoder never re-parses; "
        + "`xchain-node clear-reorg-halt <chain> <network> --reason \"...\"` clears it only when it reads none there."
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
            // Default scan bound, never the height ceiling: the bound counts ROWS and the
            // method returns distinct HEIGHTS, so re-deleted heights would crowd out older ones.
            const depth = await this.db.countReorgDeletesAboveTip()
            // A non-count is a read fault, never a depth: NaN fails both ceiling comparisons open.
            if (!Number.isInteger(depth) || depth < 0){
                throw new Error('countReorgDeletesAboveTip returned a non-count depth (' + typeof depth + ' ' + String(depth) + ')')
            }
            priorDepth = depth
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
// dispensers become eligible for hard purge once DISPENSER_EXPIRE_SAFE_DEPTH
// blocks deep (purgeExpiredDispensers), and deleteBlockByIndex can only
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
async function assertWithinSafeDepth(lastBlockIndex, priorDepth, blocksDeleted, walk){
    // Already halted on this walk with a durable marker: the walk is finishing the
    // rollback down to the fork point (raiseSafeDepthHalt), so the ceiling has spoken.
    if (walk.haltError) return
    const safeDepth = safeDepthFor(this)
    if (priorDepth + blocksDeleted.length >= safeDepth){
        const msg = "verifyReorg: reorg depth exceeds the dispenser safe-depth window "
            + "(DISPENSER_EXPIRE_SAFE_DEPTH=" + safeDepth + "). Already rolled back "
            + (priorDepth + blocksDeleted.length) + " blocks (" + blocksDeleted.length
            + " in this run, resumed from " + priorDepth + " already deleted above the tip); "
            + "soft-expired dispenser rows for block height "
            + lastBlockIndex + " and below may already have been hard-purged, so this database can no "
            + "longer match a from-scratch sync. Aborting. " + SAFE_DEPTH_HALT_RECOVERY
        await raiseSafeDepthHalt.call(this, msg, blocksDeleted, walk)
    }
}

// Raise the durable halt for a rollback that cannot fit the dispenser safe-depth window.
//
// The window exists so a database that keeps being trusted never rolls back past
// the point where purged dispenser rows can be restored. Once haltReorg has
// confirmed the REORG_HALT row, this database is no longer trusted: the entry
// guard refuses every later rollback, a restart parks before parsing
// (parkOnRolledBackHalt), clear-reorg-halt refuses while rolled-back heights sit
// above the tip, and the bootstrap gate counts the halt row, so its only way back
// is a reset. Finishing the rollback down to the fork point then reopens nothing:
// a restore past the window is a no-op on a purged row, and what it buys is that
// the decoder and every indexer reading its tables (which follows the per-block
// REORG markers) hold only blocks on the node's chain while halted.
//
// So with the marker confirmed, record the halt on the walk; the walk stops deleting
// on its own evidence and hands over to finishHaltedWalk, which deletes only what the
// node confirms, and verifyReorg throws once that ends. Without the marker, throw now:
// nothing durable condemns this database (no boot park, nothing for the bootstrap gate
// to count), so it must not be rolled back past the window.
async function raiseSafeDepthHalt(msg, blocksDeleted, walk){
    logger.error(msg)
    await haltReorg.call(this, msg, blocksDeleted)
    // Same tag as the entry guard above, and for the same reason: the marker
    // haltReorg just wrote is what every later rollback will refuse on, so
    // the parse loop parks rather than exiting. The delete-failure halts
    // below are deliberately NOT tagged: those are infrastructure faults,
    // where a fresh process and a fresh pool are a real repair attempt, and
    // their marker parks the next boot anyway.
    const err = new Error(msg)
    err.reorgHalt = true
    // No resetOnly here: the halted walk may stop before deleting anything, so the
    // park reads the count above the tip to name the recovery that fits (parkOrRethrow).
    if (this.reorgHaltMarkerPersisted === true){
        walk.haltError = err
        return
    }
    throw err
}

// Refuse a rollback until the node proves the stored block was reorged out. The
// refusal is tagged for every verifyReorg caller to wait and retry without exiting.
async function requireReorgProof(block, nodeTip){
    const proof = await proveForkReorgedAway.call(this, block, nodeTip)
    if (proof.proven) return proof
    const refusalClass = proof.unknown ? 'unproven-fork' : (/^the node holds /.test(proof.why) ? 'same-chain' : 'unread')
    const msg = 'verifyReorg: waiting without deleting stored block ' + block.block_index
        + ' (' + block.block_hash + '): ' + proof.why + '. '
        + (proof.unknown ? UNKNOWN_BLOCK_NOTE + ' ' : '')
        + 'Only getblockheader confirmations -1 proves the block was reorged out.'
    const err = new Error(msg)
    err.reorgWait = true
    err.tipBelowStoredTip = true
    err.refusalClass = refusalClass
    err.reorgWaitState = { stored_height: block.block_index, stored_hash: block.block_hash, class: refusalClass }
    throw err
}

function raiseAboveTipWait(block, refusalClass, detail){
    const msg = 'verifyReorg: waiting without deleting stored block ' + block.block_index
        + ' (' + block.block_hash + '): ' + detail
    const err = new Error(msg)
    err.reorgWait = true
    err.tipBelowStoredTip = true
    err.refusalClass = refusalClass
    err.reorgWaitState = { stored_height: block.block_index, stored_hash: block.block_hash, class: refusalClass }
    throw err
}

// Prove the stored chain has already diverged at the node's own tip before treating
// a known but unconnected header above that tip as abandoned. Bitcoin Core reports
// confirmations -1 for both states, so the high header alone cannot distinguish a
// real fork from a node that is merely behind the decoder.
async function requireAboveTipForkProof(block, nodeTip){
    let boundary
    try {
        boundary = await this.db.getBlockByIndex(nodeTip)
    } catch (err){
        raiseAboveTipWait(block, 'unread', 'the stored block at the node tip (' + nodeTip + ') could not be read')
    }
    if (!boundary || typeof boundary.block_hash !== 'string' || boundary.block_hash === ''){
        raiseAboveTipWait(block, 'unread', 'the stored block at the node tip (' + nodeTip + ') is unavailable')
    }

    let nodeHash
    try {
        nodeHash = await this.connector.getBlockHash(nodeTip)
    } catch (err){
        raiseAboveTipWait(block, 'unread', 'the node block hash at its tip (' + nodeTip + ') could not be read')
    }
    if (typeof nodeHash !== 'string' || nodeHash === ''){
        raiseAboveTipWait(block, 'unread', 'the node returned no block hash at its tip (' + nodeTip + ')')
    }
    if (boundary.block_hash === nodeHash){
        raiseAboveTipWait(block, 'node_behind', 'the node still holds the stored block at its own tip ('
            + nodeTip + '), so it is behind the decoder and the higher stored blocks may still be valid')
    }

    await requireReorgProof.call(this, { block_index: nodeTip, block_hash: boundary.block_hash }, nodeTip)
    return boundary
}

// Check the fork at the node tip before any above-tip delete or durable halt. Once
// that fork is proven, halt before a rollback that cannot fit the dispenser window.
async function refuseOrHaltDeepGap(block, nodeTip, priorDepth, blocksDeleted, walk){
    const boundary = await requireAboveTipForkProof.call(this, block, nodeTip)
    const lastBlockIndex = block.block_index
    const aboveTip = lastBlockIndex - nodeTip
    const alreadyRolledBack = priorDepth + blocksDeleted.length
    const safeDepth = safeDepthFor(this)
    const floor = alreadyRolledBack + aboveTip
    if (floor <= safeDepth) return
    const rolledBackNote = (alreadyRolledBack > 0 ? " with " + alreadyRolledBack + " block(s) already rolled back" : "")
    const msg = "verifyReorg: the node reports confirmations -1 for stored block " + nodeTip
        + " (" + boundary.block_hash + "), proving the stored chain forked at or below the node tip, but the rollback above it needs more than "
        + aboveTip + " block(s)" + rolledBackNote + ", which exceeds the dispenser safe-depth window "
        + "(DISPENSER_EXPIRE_SAFE_DEPTH=" + safeDepth + "). Halting before rolling back past the window. "
        + SAFE_DEPTH_HALT_RECOVERY
    await raiseSafeDepthHalt.call(this, msg, blocksDeleted, walk)
}


module.exports = { safeDepthFor, refuseHaltedRollback, readPriorRollbackDepth, assertWithinSafeDepth, requireReorgProof, requireAboveTipForkProof, refuseOrHaltDeepGap }
