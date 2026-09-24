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
const { isDispenserExpiryRealignActive } = require('../protocol/dispenser_expiry_realign')
const { cancelGraceFloor } = require('../protocol/dispenser_cancel_grace')
const protocolTime = require('../protocol/protocol_time')
const { logger, SYNCED_THRESHOLD, DB_TRANSACTION_BLOCKS_QUANTITY, LOG_BLOCK_INTERVAL, DISPENSER_EXPIRE_SAFE_DEPTH } = require('./constants.js')
const { parkOrRethrow } = require('./sync_loop.js')
const { ingestTransaction } = require('./transaction_ingest.js')

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

async function loadOpenDispenserAddresses(block, nextBlockHeight){
    // Load the set of open-dispenser addresses once for this block (below the
    // realign gate, after expiring stale ones above; at/above it, before any
    // expiry runs, which is the whole point: a dispenser this block's header
    // time passes is still open for every tx in the block, as the indexer has
    // it) so parseTransaction can test each output
    // against it in JS instead of issuing one DB query per output; the
    // per-output lookup was thousands of serialized round-trips per mainnet
    // block. Kept current within the block by .add()ing any dispenser opened
    // by a transaction below, matching the previous per-output query timing.
    // null signals the query failed: decoding the block against an empty set
    // would silently drop every dispense output on this instance only, so
    // retry the block instead.
    //
    // CANCELLATION GRACE (at/above DISPENSER_CANCEL_GRACE_ACTIVATION): the floor
    // widens the set by dispensers whose expiration is inside the indexer's
    // cancellation grace period, which the indexer keeps fillable for an hour past
    // a cancel while the decoder's soft-expire knows nothing about cancels. Below
    // the gate the floor is null and the set is the unwidened one, so a
    // from-genesis re-decode reproduces what the fleet wrote. The floor derives
    // only from this block's protocol time, so every honest node loads the same set.
    let openDispenserAddresses = await this.db.getAllOpenDispenserAddresses(
        cancelGraceFloor(this.consensusNetwork, block.timestamp))
    if (openDispenserAddresses == null){
        logger.error(`Could not load open dispenser addresses for block ${nextBlockHeight}; retrying block`)
        await this.db.endTransaction()
        return 'rollback'
    }
    return openDispenserAddresses
}

async function retryFailedCommit(loop, nextBlockHeight){
    // commitTransaction returned false: the commit failed and the whole
    // block batch was rolled back (endTransaction). Do NOT advance the tip
    // to nextBlockHeight, which would permanently skip the rolled-back
    // window and leave a hole in the decoded chain. Reset to the last
    // durably committed block and retry, mirroring the block-decode
    // recovery path above.
    logger.error(`Commit failed at block ${nextBlockHeight}; resetting to last committed block and retrying`)
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    // Reset the in-memory log/ETA accumulators too, as the reorg
    // recovery path does. The rolled-back batch never reached the
    // DB, so leaving these set would double-count transactions and
    // skew the ms/block ETA on the retry. Logging-only, no tip effect.
    loop.transactionsCount = 0
    loop.validTransactionsCount = 0
    loop.outputCount = 0
    loop.blocksCount = 0
    loop.startTimeStamp = Date.now()
    await this.sleep(3000)
    return 'continue'
}

async function commitBlockBatch(loop, nextBlockHeight, nextBlockHash){
    if ((nextBlockHeight % LOG_BLOCK_INTERVAL === 0) || ((this.blockchainInfoLastBlock - nextBlockHeight) <= SYNCED_THRESHOLD)) {
        this.log("Parsing block "+(nextBlockHeight)+"("+nextBlockHash+") Txs ("+loop.transactionsCount+") Outputs ("+loop.outputCount+")")
        this.log("Inserting data Blocks ("+loop.blocksCount+") Valid Transactions ("+loop.validTransactionsCount+")")
    }
    const committed = await this.db.commitTransaction()
    if (!committed){
        return await retryFailedCommit.call(this, loop, nextBlockHeight)
    }

    // The block committed: any poison-tx positions for it are now permanently
    // recorded (PARSE_ERROR) and skipped, so drop them. Keeps insertQuarantine
    // bounded to the block being retried and prevents a stale height:pos entry
    // from surviving a later reorg that changes this height's content.
    if (loop.insertQuarantine.size > 0) loop.insertQuarantine.clear()

    // Hard-purge dispensers soft-expired at a reorg-safe depth. Runs
    // AFTER the block transaction commits (a transient failure here
    // must not roll back committed block data) and is deterministic
    // across nodes (keyed off canonical height, not wall clock).
    const safeDepth = this.dispenserExpireSafeDepth || DISPENSER_EXPIRE_SAFE_DEPTH
    await this.db.purgeExpiredDispensers(nextBlockHeight - safeDepth)

    loop.blocksCount = 0
    loop.transactionsCount = 0
    loop.validTransactionsCount = 0
    loop.outputCount = 0

    let endTimeStamp = Date.now()

    let msPerBlock = ((endTimeStamp - loop.startTimeStamp)/DB_TRANSACTION_BLOCKS_QUANTITY)
    loop.startTimeStamp = Date.now()

    let msLeft = (this.blockchainInfoLastBlock - nextBlockHeight)*msPerBlock

    if (msLeft > 0){
        let msPerBlockFormatted = this.millisecondsToTimeString(msPerBlock)
        let msLeftFormatted = this.millisecondsToTimeString(msLeft)
        logger.info("Last block time ("+msPerBlockFormatted+"). ETA: "+msLeftFormatted)
    }

    loop.blocksQuantity = -1
}

async function finishBlock(loop, block, nextBlockHeight, nextBlockHash, openDispenserAddresses, expireDispensersAtBlockEnd){
    var transactions = block.transactions
    loop.blocksCount = loop.blocksCount + 1

    for (let txIndex=0;txIndex < transactions.length;txIndex++){
        let nextTransaction = transactions[txIndex]
        const directive = await ingestTransaction.call(this, loop, block, nextBlockHeight, openDispenserAddresses, nextTransaction, txIndex)
        if (directive === 'rollback') return 'rollback'
        if (directive === 'continue') continue

        loop.outputCount = loop.outputCount + nextTransaction.outs.length
    }

    loop.transactionsCount = loop.transactionsCount + transactions.length

    // REALIGNED soft-expire (at/above DISPENSER_EXPIRY_REALIGN_ACTIVATION): the
    // block's transactions have all been seen, so expire now, exactly where the
    // indexer's utility.processExpirations sits. Every tx in this block therefore
    // saw the dispenser open on BOTH sides, and a boundary block yields the same
    // DISPENSE set. Runs INSIDE the block transaction (the commit below is what
    // makes it durable), so a reorg still restores the row through
    // deleteBlockByIndex, and the same-block extend above can still clear a stamp
    // this height wrote on a re-processed block. Same rollback contract as the
    // legacy call site: false means the UPDATE failed and the block transaction is
    // already rolled back, so retry the block rather than writing on past it.
    // Below the gate this is a no-op; the block-start call already ran.
    if (expireDispensersAtBlockEnd &&
        (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
        logger.error(`deleteOpenDispensers failed at end of block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }

    // Commit once the batch is full, or immediately on the block that reaches
    // the node tip so a caught-up decoder never holds a block uncommitted.
    if ((loop.blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
        if ((await commitBlockBatch.call(this, loop, nextBlockHeight, nextBlockHash)) === 'continue') return 'continue'
    }

    loop.blocksQuantity = loop.blocksQuantity + 1
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = nextBlockHeight
    // The one forward-progress site: a block is committed and the cursor
    // moved. Every other assignment to lastProcessedBlockIndex re-reads the
    // cursor after a rollback, which is recovery, not progress.
    this.lastAdvanceAt = Date.now()
}

async function fetchPreviousBlockTimes(nextBlockHeight, span){
    // MTP walks strictly backward from the block being resolved, oldest call
    // last, so a failure partway through never mixes heights from two
    // different reorg states. getBlockByIndex already retries transient
    // failures internally and only THROWS once it gives up (see its own
    // comment); a missing row (null, chain exhausted below genesis) is not a
    // failure and just ends the walk early, same as protocolTime.medianTimePast
    // mediating a short window rather than refusing.
    let previousBlockTimes = []
    for (let height = nextBlockHeight - 1; height >= 0 && previousBlockTimes.length < span; height--){
        let previousBlock
        try {
            previousBlock = await this.db.getBlockByIndex(height)
        } catch (err){
            logger.error(formatLogLine(`Could not resolve protocol time for block ${nextBlockHeight} (previous block ${height} lookup failed); block rolled back, retrying`, err))
            return null
        }
        if (!previousBlock) break
        previousBlockTimes.push(previousBlock.block_time)
    }
    return previousBlockTimes
}

async function storeBlock(loop, block, nextBlockHeight, nextBlockHash, previousBlockHash){
    if (loop.blocksQuantity == 0){
        await this.db.beginTransaction()
    }

    // Resolve protocol time BEFORE anything below reads block.timestamp: MTP
    // networks (protocol_time.js) key every downstream time-keyed gate off the
    // median of the previous MEDIAN_TIME_SPAN blocks rather than this block's own
    // (possibly future-dated) header stamp. Only armed networks pay the previous-
    // block lookup at all.
    let previousBlockTimes = []
    if (protocolTime.isProtocolTimeMtpActive(this.consensusNetwork)){
        previousBlockTimes = await fetchPreviousBlockTimes.call(this, nextBlockHeight, protocolTime.MEDIAN_TIME_SPAN)
        if (previousBlockTimes === null){
            await this.db.endTransaction()
            return 'rollback'
        }
    }
    const blockTimeContext = protocolTime.createBlockTimeContext(this.consensusNetwork, block.timestamp, previousBlockTimes)

    if (!(await this.db.insertBlock(
        {
            block_index:nextBlockHeight,
            block_hash:nextBlockHash,
            block_time:blockTimeContext.rawBlockTime,
            previous_block_hash:previousBlockHash
        }
    ))){
        // insertBlock's error path already rolled the block transaction back.
        logger.info("Error trying to insert a Block to the database")
        return 'rollback'
    }

    // Every site below this line, and everything downstream of finishBlock
    // (transaction_ingest.js, dispenser_registration.js), reads block.timestamp
    // for its own time-keyed gates. Re-stamping it here to the resolved protocol
    // time - after the raw stamp above is durably persisted - is the ONE seam
    // that threads protocolBlockTime through every one of those sites without
    // having to pass it call site by call site, mirroring how the indexer's own
    // protocol_time.stampProtocolTime re-stamps decoded rows at its own single
    // seam (xchain-indexer/src/XChainIndexer/block_parse.js).
    block.timestamp = blockTimeContext.protocolBlockTime

    // WHERE the dispenser soft-expire runs is a consensus decision, so it rides a
    // flag-day (DISPENSER_EXPIRY_REALIGN_ACTIVATION, keyed on block TIME).
    //
    // LEGACY (below the gate): here, at block START, before the transaction loop.
    // The open-dispenser address set loaded just below therefore excludes anything
    // this block's protocol time expired, so payments to it are not captured. The
    // INDEXER expires at block END (utility.processExpirations), so for every tx in
    // this same block it still treats that dispenser as open, and since it only sees
    // outputs the decoder persisted, the boundary block pays coin with no DISPENSE.
    // That defect is preserved verbatim below the gate: a from-genesis re-decode has
    // to reproduce what the fleet actually wrote, byte for byte.
    //
    // REALIGNED (at/above the gate): skipped here and run after the transaction loop
    // instead (same block transaction), which puts both services' measurement points
    // in the same place so a boundary block yields the same DISPENSE set on both.
    const expireDispensersAtBlockEnd =
        isDispenserExpiryRealignActive(this.consensusNetwork, block.timestamp)

    //Soft-expire open dispensers past their expiration (marks them with
    //this block height instead of deleting, so a reorg can restore them).
    //false means the UPDATE failed and the block transaction was already
    //rolled back; continuing would land every subsequent write on fresh
    //autocommit connections OUTSIDE any transaction (durable rows the
    //rollback was meant to discard), so retry the block instead.
    if (!expireDispensersAtBlockEnd &&
        (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
        logger.error(`deleteOpenDispensers failed at block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }

    const openDispenserAddresses = await loadOpenDispenserAddresses.call(this, block, nextBlockHeight)
    if (openDispenserAddresses === 'rollback') return 'rollback'

    return await finishBlock.call(this, loop, block, nextBlockHeight, nextBlockHash, openDispenserAddresses, expireDispensersAtBlockEnd)
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
