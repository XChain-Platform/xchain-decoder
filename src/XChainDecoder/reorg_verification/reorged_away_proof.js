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
 * XChain Decoder - proof that a stored block was reorged away
 *
 * Every rollback asks the node for the stored block by hash. A verbose header with
 * confirmations -1 proves that block left the active chain. A not-found answer does
 * not: the node may still be catching up, may be a fallback that never saw the block,
 * or may have lost its regtest blocks, and every such case waits without deleting.
 *
 ********************************************************************/

const { RESET_RECOVERY } = require('../reorg_halt.js')

// How long an unproven answer for the fork halt stands before the node is asked
// again. The parse loop re-runs that check every poll while it waits, and each
// not-found answer is an error line from the connector.
const UNPROVEN_RECHECK_MS = 60000

// What the wait or the park says about a node that does not know a stored block:
// either it never saw this chain (it comes back) or it lost the blocks (it never does).
const UNKNOWN_BLOCK_NOTE = 'A node that does not know a stored block is either an endpoint that never saw this '
    + 'chain (a lagging node, or NODE_URL_FALLBACK after a failover), which the decoder waits out, or a node that '
    + 'lost those blocks (an unclean stop of a regtest node), which never comes back: recover that case with '
    + RESET_RECOVERY + '.'

function unproven(why, unknown = false){
    return { proven: false, unknown, why }
}

// Read the node's header for a stored block: the verbose header, or an unproven
// answer saying why there is none (unknown when the node answers not-found, -5).
async function readStoredBlockHeader(block){
    const label = 'stored block ' + block.block_index + ' (' + block.block_hash + ')'
    if (!this.connector || typeof this.connector.getBlockHeader !== 'function'){
        return unproven('the node connector cannot read a block header for ' + label)
    }
    try {
        const header = await this.connector.getBlockHeader(block.block_hash, false)
        if (!header || typeof header !== 'object') return unproven('the node answered no usable header for ' + label)
        return { header, label }
    } catch (err){
        const notFound = !!err && (err.rpcCode === -5 || err.code === -5)
        return notFound
            ? unproven('the node does not know ' + label, true)
            : unproven('the node header of ' + label + ' could not be read')
    }
}

// Prove a stored block was reorged out only when getblockheader knows its hash and
// reports confirmations -1. Any other answer proves nothing and deletes nothing.
// Never throws. Returns { proven, unknown, why }; unknown marks not-found.
async function proveReorgedAway(block){
    const read = await readStoredBlockHeader.call(this, block)
    if (!read.header) return read
    const { header, label } = read
    if (header.confirmations !== -1){
        return Number.isInteger(header.confirmations) && header.confirmations >= 0
            ? unproven('the node holds ' + label + ' on its active chain (' + header.confirmations + ' confirmations)')
            : unproven('the node answered no confirmation count for ' + label)
    }
    return { proven: true, unknown: false, why: null }
}

// proveReorgedAway for the fork halt, which the parse loop re-runs every poll while it
// waits: an unproven answer for the same blocks at the same node tip stands for
// UNPROVEN_RECHECK_MS instead of asking the node again; a proof is never cached.
async function proveForkReorgedAway(block, nodeTip){
    const key = nodeTip + ':' + block.block_hash
    const now = Date.now()
    const cached = this.forkProofCache
    if (cached && cached.key === key && now >= cached.at && now - cached.at < UNPROVEN_RECHECK_MS) return cached.result
    const result = await proveReorgedAway.call(this, block)
    this.forkProofCache = result.proven ? null : { key, at: now, result }
    return result
}

module.exports = { proveReorgedAway, proveForkReorgedAway, UNKNOWN_BLOCK_NOTE }
