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
 **********************************************************************/

const { format: formatLogLine } = require('node:util')
const { isDispenserExpiryRealignActive } = require('../protocol/dispenser_expiry_realign')
const { cancelGraceFloor } = require('../protocol/dispenser_cancel_grace')
const protocolTime = require('../protocol/protocol_time')
const { logger, SYNCED_THRESHOLD, DB_TRANSACTION_BLOCKS_QUANTITY, LOG_BLOCK_INTERVAL, DISPENSER_EXPIRE_SAFE_DEPTH } = require('./constants.js')
const { ingestTransaction } = require('./transaction_ingest.js')

async function loadOpenDispenserAddresses(block, nextBlockHeight){
    // Load the set once per block after any legacy expiry and before the
    // realigned end-of-block expiry. The grace floor preserves dispensers
    // that the indexer still considers fillable during cancellation grace.
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
    // Reset to the last durable block after commitTransaction rolls back the
    // batch. The in-memory counters reset too so the retry is not double-counted.
    logger.error(`Commit failed at block ${nextBlockHeight}; resetting to last committed block and retrying`)
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
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

    // Drop poison-tx positions only after their PARSE_ERROR rows commit.
    if (loop.insertQuarantine.size > 0) loop.insertQuarantine.clear()

    // Purge after commit at a deterministic, reorg-safe canonical height.
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

    // Realigned networks expire after every transaction in the block has seen
    // the dispenser open. A false result means the block was rolled back.
    if (expireDispensersAtBlockEnd &&
        (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
        logger.error(`deleteOpenDispensers failed at end of block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }

    // Commit a full batch, or commit immediately when this block reaches tip.
    if ((loop.blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
        if ((await commitBlockBatch.call(this, loop, nextBlockHeight, nextBlockHash)) === 'continue') return 'continue'
    }

    loop.blocksQuantity = loop.blocksQuantity + 1
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = nextBlockHeight
    this.lastAdvanceAt = Date.now()
}

async function fetchPreviousBlockTimes(nextBlockHeight, span){
    // Walk strictly backward so a failed lookup never mixes reorg states.
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

async function resolveBlockTimeContext(block, nextBlockHeight){
    // MTP networks resolve against the previous MEDIAN_TIME_SPAN blocks.
    let previousBlockTimes = []
    if (protocolTime.isProtocolTimeMtpActive(this.consensusNetwork)){
        previousBlockTimes = await fetchPreviousBlockTimes.call(this, nextBlockHeight, protocolTime.MEDIAN_TIME_SPAN)
        if (previousBlockTimes === null){
            await this.db.endTransaction()
            return null
        }
    }
    return protocolTime.createBlockTimeContext(
        this.consensusNetwork, block.timestamp, previousBlockTimes)
}

async function insertBlockRecord(blockTimeContext, nextBlockHeight, nextBlockHash, previousBlockHash){
    const inserted = await this.db.insertBlock({
        block_index:nextBlockHeight,
        block_hash:nextBlockHash,
        block_time:blockTimeContext.rawBlockTime,
        previous_block_hash:previousBlockHash
    })
    if (!inserted){
        // insertBlock's error path already rolled the block transaction back.
        logger.info("Error trying to insert a Block to the database")
        return false
    }
    return true
}

async function expireDispensersAtBlockStart(block, nextBlockHeight, expireAtEnd){
    // Legacy networks expire at block start. Realigned networks defer this
    // update until every transaction in the block has been processed.
    if (!expireAtEnd &&
        (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
        logger.error(`deleteOpenDispensers failed at block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }
}

async function storeBlock(loop, block, nextBlockHeight, nextBlockHash, previousBlockHash){
    if (loop.blocksQuantity == 0) await this.db.beginTransaction()

    const blockTimeContext = await resolveBlockTimeContext.call(this, block, nextBlockHeight)
    if (blockTimeContext === null) return 'rollback'
    if (!(await insertBlockRecord.call(
        this, blockTimeContext, nextBlockHeight, nextBlockHash, previousBlockHash))) return 'rollback'

    // Persist raw header time, then expose protocol time to all downstream gates.
    block.timestamp = blockTimeContext.protocolBlockTime
    const expireAtEnd = isDispenserExpiryRealignActive(
        this.consensusNetwork, block.timestamp)
    if ((await expireDispensersAtBlockStart.call(
        this, block, nextBlockHeight, expireAtEnd)) === 'rollback') return 'rollback'

    const openAddresses = await loadOpenDispenserAddresses.call(this, block, nextBlockHeight)
    if (openAddresses === 'rollback') return 'rollback'
    return await finishBlock.call(
        this, loop, block, nextBlockHeight, nextBlockHash, openAddresses, expireAtEnd)
}

module.exports = { storeBlock }
