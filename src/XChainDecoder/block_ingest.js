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

const util = require('../util')
const { format: formatLogLine } = require('node:util')
const { logger, SYNCED_THRESHOLD } = require('./constants.js')
const { parkOrRethrow } = require('./sync_loop.js')
const { storeBlock } = require('./block_store.js')

async function fetchNextBlock(nextBlockHeight){
    let nextBlockHash = null
    let nextBlockHex = null
    // Track consecutive fetch failures at this exact height. A transient
    // RPC hiccup clears on the next success; a deterministic failure (e.g.
    // a malformed AuxPoW section that makes getBlockWithoutAuxPow throw)
    // would otherwise retry here silently forever. We never skip the block
    // (that would corrupt the index): after a few attempts we escalate to
    // parseErrors so the stall is visible to monitoring, and on an AuxPoW
    // chain fetchBlockHex switches to per-tx block reassembly, which
    // recovers the identical pure block without touching the AuxPoW bytes.
    //
    // TWO counters, because they answer different questions.
    // _fetchErrorCount counts EVERY consecutive failure at this height and
    // exists purely for operator visibility (the parseErrors bump below), so
    // a stall stays observable on non-AuxPoW chains too. Only
    // _auxPowParseErrorCount, which counts content faults, drives the
    // per-tx reassembly escalation in fetchBlockHex.
    if (this._fetchErrorHeight !== nextBlockHeight) {
        this._fetchErrorHeight = nextBlockHeight
        this._fetchErrorCount = 0
        this._auxPowParseErrorCount = 0
    }
    try {
        nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)
        nextBlockHex = await this.fetchBlockHex(nextBlockHash, nextBlockHeight)
        this._fetchErrorCount = 0
        this._auxPowParseErrorCount = 0
    } catch (e){
        this._fetchErrorCount++
        // Only a fault in the AuxPoW header strip is evidence that THIS BLOCK's
        // bytes are the problem; getBlockWithoutAuxPow tags those (and only
        // those) with auxPowParseFailure. A transport fault, which on a
        // Dogecoin 1.14 node under RPC-queue pressure arrives as a bare
        // ECONNRESET/ECONNREFUSED socket error, propagates untagged and must
        // not push this height toward per-tx reassembly.
        if (e && e.auxPowParseFailure) {
            this._auxPowParseErrorCount++
        }
        if (this._fetchErrorCount === 5) {
            this.parseErrors++
        }
        logger.error(formatLogLine('Error fetching block at height ' + nextBlockHeight + ' (attempt ' + this._fetchErrorCount + '):', e))
        await this.sleep(3000)
        return 'continue'
    }
    return { nextBlockHash, nextBlockHex }
}

async function retryUndecodableBlock(loop, e, nextBlockHeight, nextBlockHash){
    this.parseErrors++
    logger.error(formatLogLine(`Failed to decode block ${nextBlockHeight} (${nextBlockHash}), retrying:`, e))
    await this.db.endTransaction()
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    await this.sleep(3000)
    return 'continue'
}

async function rollBackDetectedReorg(loop, nextBlockHeight){
    await this.db.endTransaction()
    this.logWarn("A reorg has been detected at block " + nextBlockHeight + ". Cleaning blocks...")
    const preReorgBlock = loop.lastProcessedBlockIndex
    try {
        await this.verifyReorg(this.blockchainInfoLastBlock)
    } catch (err){
        // A REORG_HALT refusal parks the loop instead of exiting the
        // process; every other abort still propagates and halts loudly.
        parkOrRethrow.call(this, err, loop.lastProcessedBlockIndex)
        return 'continue'
    }
    // Re-clamp: same as the pre-loop guard and the node-tip regression path.
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    // Count rolled-back blocks as the difference between the pre-reorg tip
    // and the newly confirmed last good block so the log entry is actionable.
    const rolledBackCount = Math.max(0, preReorgBlock - loop.lastProcessedBlockIndex)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    loop.transactionsCount = 0
    loop.validTransactionsCount = 0
    loop.outputCount = 0
    loop.startTimeStamp = Date.now()
    this.log("Blocks were updated (" + rolledBackCount + " blocks rolled back)")
    return 'continue'
}

async function detectReorgAtBlock(loop, nextBlockHeight, previousBlockHash){
    let previousBlock = null
    try {
        previousBlock = await this.db.getBlockByIndex(nextBlockHeight - 1)
    } catch (err){
        // getBlockByIndex retries internally and THROWS when the read never
        // succeeds, so a failed read and a missing row are distinct cases;
        // both warrant the same response here, retry this height. The throw
        // must not escape start(), which would permanently stop the parse
        // loop (api.js only logs the rejection). Same log prefix as the
        // missing-row branch below so the retry regression coverage matches.
        logger.error(formatLogLine(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`, err))
        await this.sleep(3000)
        return 'continue'
    }

    // A null here means the row is genuinely absent (never a DB error). That
    // would dereference straight into `previousBlock.block_hash`
    // (TypeError), escape start(), and permanently stop the parse loop.
    // Treat it as transient and retry this height, matching the block-fetch
    // error path above.
    if (!previousBlock){
        logger.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`)
        await this.sleep(3000)
        return 'continue'
    }

    //previousBlockHash is not the same, it must be a reorg
    if (previousBlockHash != previousBlock.block_hash){
        return await rollBackDetectedReorg.call(this, loop, nextBlockHeight)
    }
}

async function ingestNextBlock(loop){
    // Too far behind to serve mempool: drop out of synced mode and stop the
    // mempool timer until catch-up finishes.
    if ((this.blockchainInfoLastBlock - loop.lastProcessedBlockIndex) > SYNCED_THRESHOLD){
        this.synced = false
        if (this.mempoolInterval != null){
            logger.info("Mempool updates stopped!")
            clearInterval(this.mempoolInterval)
            this.mempoolInterval = null
        }
    }

    let nextBlockHeight = loop.lastProcessedBlockIndex + 1

    const fetched = await fetchNextBlock.call(this, nextBlockHeight)
    if (fetched === 'continue') return 'continue'
    const { nextBlockHash, nextBlockHex } = fetched

    // A throw here would otherwise escape start() and permanently stop the
    // decode loop (api.js only logs the rejection), wedging the pipeline at
    // this height. Never skip a whole block: a block we cannot decode is a
    // parser bug, not data to discard. Stay alive and keep retrying so
    // the process remains visible to health checks and recovers if the
    // failure was transient (e.g. corrupted RPC response).
    var block = null
    let previousBlockHash = null
    try {
        block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
        previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
    } catch (e){
        return await retryUndecodableBlock.call(this, loop, e, nextBlockHeight, nextBlockHash)
    }

    //verify if there is an reorg
    if (nextBlockHeight > this.startBlockIndex){
        if ((await detectReorgAtBlock.call(this, loop, nextBlockHeight, previousBlockHash)) === 'continue') return 'continue'
    }

    return await storeBlock.call(this, loop, block, nextBlockHeight, nextBlockHash, previousBlockHash)
}

module.exports = { ingestNextBlock }
