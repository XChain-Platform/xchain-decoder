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
 * XChain Decoder - the evidence-only walk that finishes a halted rollback
 *
 * Once the safe-depth halt marker is durable, the rollback goes on toward the fork
 * point so the abandoned branch is not left served, but only on the node's positive
 * evidence: agreeing hash readings to find the fork point, and for every delete,
 * the node's proof that it reorged away from that stored block. Used by
 * reorg_verification.js.
 *
 ********************************************************************/

const { format: formatLogLine } = require('node:util')
const { logger } = require('../constants.js')
const { safeDepthFor } = require('./reorg_depth.js')
const { proveReorgedAway, UNKNOWN_BLOCK_NOTE } = require('./reorged_away_proof.js')

// One node reading of the block hash at a height: the hash, or null when the call
// fails or answers anything but a non-empty string.
async function readNodeBlockHash(height){
    try {
        const hash = await this.connector.getBlockHash(height)
        return (typeof hash === 'string' && hash !== '') ? hash : null
    } catch (_) {
        return null
    }
}

// Delete one stored block of a halted walk, retrying a failed delete as the walk does.
// True once it is gone, false when every attempt failed.
async function deleteHaltedBlock(block, blocksDeleted){
    for (let attempt = 1; attempt <= 10; attempt++){
        try {
            await this.db.deleteBlockByIndex(block.block_index, block.block_hash)
            blocksDeleted.push({ "block_index": block.block_index, "block_hash": block.block_hash })
            return true
        } catch (err){
            logger.error(formatLogLine(`reorg: halted; failed to delete block ${block.block_index} (${block.block_hash}): `, err))
            if (attempt < 10) await this.sleep(3000)
        }
    }
    return false
}

// Read the halted walk down from the stored tip, deleting nothing: the stored blocks
// the node does not hold (doomed, top first) and the fork point under them, or
// { stop } saying why no fork point is confirmed. Heights above the node tip are
// doomed without a reading; every other height is read from the node twice, in
// separate calls, and a disagreement or a failed call stops the read.
async function readHaltedWalk(tip, budget){
    let storedTip
    try {
        storedTip = await this.db.getLastBlockIndex()
    } catch (_) {
        return { stop: 'the stored tip could not be read' }
    }
    const lowest = Math.max(this.startBlockIndex, storedTip - budget)
    const doomed = []
    for (let height = storedTip; height >= lowest; height--){
        let stored
        try {
            stored = await this.db.getBlockByIndex(height)
        } catch (_) {
            stored = null
        }
        if (!stored || typeof stored.block_hash !== 'string') return { stop: 'the stored block at height ' + height + ' could not be read' }
        const block = { block_index: height, block_hash: stored.block_hash }
        if (height > tip){
            doomed.push(block)
            continue
        }
        const first = await readNodeBlockHash.call(this, height)
        const second = (first === null) ? null : await readNodeBlockHash.call(this, height)
        if (first === null || second === null) return { stop: 'the node block hash at height ' + height + ' could not be read' }
        if (first !== second) return { stop: 'two readings of the node block hash at height ' + height + ' disagree' }
        if (first === stored.block_hash) return { storedTip, doomed, forkPoint: height }
        doomed.push(block)
    }
    return { stop: 'no height from the stored tip (' + storedTip + ') down to ' + lowest
        + ' holds the stored block on the node, so no fork point is confirmed within two safe-depth windows of rollback' }
}

// Delete the doomed blocks top first, each only once the node reports confirmations
// -1 for that stored hash. Asking immediately before each delete lets a node that
// moves back onto the stored chain stop the walk.
async function deleteProvenBlocks(doomed, blocksDeleted){
    for (const block of doomed){
        const proof = await proveReorgedAway.call(this, block)
        if (!proof.proven){
            return 'the node does not prove it reorged away from the stored block at height ' + block.block_index
                + ': ' + proof.why + '.' + (proof.unknown ? ' ' + UNKNOWN_BLOCK_NOTE : '')
        }
        if (!(await deleteHaltedBlock.call(this, block, blocksDeleted))){
            return 'the stored block at height ' + block.block_index + ' could not be deleted'
        }
    }
    return null
}

// Finish a halted walk down to the fork point, on the node's positive evidence only.
//
// With the REORG_HALT marker durable the database is condemned to a reset, and the
// rollback goes on only so the abandoned branch is not left served while it waits.
// That gain is small next to deleting a block the node still holds, which a flaky,
// wrong or lagging endpoint would otherwise cause, so past the halt the walk asks
// for more:
//  - It works against the node tip it halted on and never reads a new one, so a
//    lower tip after the halt deletes nothing (a failed read below stops the walk).
//  - It finds the fork point (a height where two agreeing readings give the stored
//    block) by reading alone, before any delete, and only where the whole rollback,
//    counting what this database already rolled back, fits two safe-depth windows:
//    the halt is the first window running out, and the finish may spend one more.
//    Finding no fork point there deletes nothing.
//  - A node holding the stored block at its own tip may simply be behind, so the
//    stored blocks above that tip stay. A legacy caller that passes no tip has no
//    above-tip region: every height is read.
//  - Every delete needs the node's proof that it reorged away from that very block
//    (getblockheader confirmations -1, reorged_away_proof.js). An endpoint that
//    never held the stored blocks answers not-found and stops the walk.
// So a node that lies, flaps, lags or drops out can stop the rollback early, leaving
// the halted decoder serving what develop always left, and never extend it. Records
// why it stopped on walk.haltStop, or null when it reached the fork point.
async function finishHaltedWalk(nodeTip, priorDepth, blocksDeleted, walk){
    walk.haltStop = null
    const tip = (nodeTip == null) ? Infinity : nodeTip
    const read = await readHaltedWalk.call(this, tip, 2 * safeDepthFor(this) - (priorDepth + blocksDeleted.length))
    if (read.stop){
        walk.haltStop = read.stop
        return
    }
    if (read.forkPoint === tip && read.storedTip > tip){
        walk.haltStop = 'the node holds the stored block at its own tip (' + nodeTip + '), so the '
            + (read.storedTip - nodeTip) + ' stored block(s) above it may still be on its chain'
        return
    }
    walk.haltStop = await deleteProvenBlocks.call(this, read.doomed, blocksDeleted)
}

module.exports = { finishHaltedWalk }
