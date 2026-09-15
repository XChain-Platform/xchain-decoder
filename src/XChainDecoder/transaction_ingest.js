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
const { captureCommands, collapseDispenserRegistrations } = require('../protocol/batch_sub_command_capture')
const { logger, TX_PARSE_MAX_RETRIES } = require('./constants.js')
const { dispenserCommandPrefixFor, collectDispenserCreates, registerDispenser, dispenserEditExtension, extendEditedDispenser } = require('./dispenser_registration.js')

async function skipQuarantinedTransaction(block, nextBlockHeight, nextTransaction, txIndex){
    this.parseErrors++
    let quarantinedHash = null
    try { quarantinedHash = nextTransaction.getId() } catch(_){ /* unparseable id; leave null */ }
    let eventResult = await this.db.insertEvent("PARSE_ERROR", {
        block_index: nextBlockHeight,
        tx_position: txIndex,
        tx_hash: quarantinedHash,
        error: 'deterministic INSERT failure (quarantined after ' + TX_PARSE_MAX_RETRIES + ' block retries)'
    }, block.timestamp)
    if (eventResult === false){
        // insertEvent already rolled the block transaction back
        return 'rollback'
    }
    return 'continue'
}

async function handleParseFailure(loop, e, block, nextBlockHeight, nextTransactionHash, txIndex){
    if (e && e.rpcLookupFailure){
        // A prevout/fee-output RPC lookup failed even after the
        // connector's internal retries. That is node/infrastructure
        // trouble, not a poison transaction: quarantining would make
        // this instance skip a tx every healthy instance accepts
        // (instance-dependent block contents). Retry the block
        // indefinitely instead; rpc_errors/health make the stall
        // visible while the node recovers.
        logger.error(formatLogLine(`RPC lookup failed in block ${nextBlockHeight} (tx position ${txIndex}), retrying block:`, e))
        await this.db.endTransaction()
        return 'rollback'
    }

    if (loop.txParseRetryHeight != nextBlockHeight){
        loop.txParseRetryHeight = nextBlockHeight
        loop.txParseRetryCount = 0
    }
    loop.txParseRetryCount++

    if (loop.txParseRetryCount <= TX_PARSE_MAX_RETRIES){
        // Could be transient (DB hiccup inside parseTransaction):
        // roll the block back and re-parse it from scratch.
        logger.error(formatLogLine(`parseTransaction failed in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${loop.txParseRetryCount}/${TX_PARSE_MAX_RETRIES}), retrying block:`, e))
        await this.db.endTransaction()
        return 'rollback'
    }

    // The transaction keeps throwing after whole-block retries: treat it
    // as a poison transaction and quarantine it (skip + audit event) so
    // one undecodable tx cannot wedge the pipeline at this height forever.
    this.parseErrors++
    logger.error(formatLogLine(`Quarantining undecodable tx in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries:`, e))
    let eventResult = await this.db.insertEvent("PARSE_ERROR", {
        block_index: nextBlockHeight,
        tx_position: txIndex,
        tx_hash: nextTransactionHash,
        error: String((e && e.message) || e)
    }, block.timestamp)
    if (eventResult === false){
        // insertEvent already rolled the block transaction back
        return 'rollback'
    }
    return 'continue'
}

async function parseBlockTransaction(loop, block, nextBlockHeight, openDispenserAddresses, nextTransaction, txIndex){
    let nextTransactionHash = null
    let parseResult = null
    try {
        nextTransactionHash = nextTransaction.getId()
        parseResult = await this.parseTransaction(nextTransaction, openDispenserAddresses, undefined, nextBlockHeight)
    } catch (e){
        return await handleParseFailure.call(this, loop, e, block, nextBlockHeight, nextTransactionHash, txIndex)
    }
    return { nextTransactionHash, parseResult }
}

async function insertTransactionRow(loop, parseResult, nextTransactionHash, nextBlockHeight, stored, txIndex){
    let insertResult = await this.db.insertTransaction({
        index: loop.lastProcessedTxIndex,
        hash: nextTransactionHash,
        block_index: nextBlockHeight,
        source: parseResult["source"],
        source_pubkey: parseResult["sourcePubkey"],
        destination: parseResult["destination"],
        amount: parseResult["amount"],
        fee: 0,
        data: stored.data,
        raw_data: stored.rawData

    })
    if (insertResult === this.db.POISON_ROW){
        // Deterministic content/constraint rejection (block already
        // rolled back by insertTransaction). Retrying the block would
        // wedge it forever. Bound the retries like a parse-throw, then
        // quarantine this tx position so the re-parse skips it. (The
        // retry margin guards against a misclassified transient error;
        // the errno set is conservative, so this normally quarantines
        // on the first exceedance.)
        if (loop.insertQuarantineHeight != nextBlockHeight){
            loop.insertQuarantineHeight = nextBlockHeight
            loop.insertQuarantineCount = 0
        }
        loop.insertQuarantineCount++
        if (loop.insertQuarantineCount > TX_PARSE_MAX_RETRIES){
            loop.insertQuarantine.add(nextBlockHeight + ':' + txIndex)
            logger.error(`Quarantining tx with deterministic INSERT failure in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries`)
        } else {
            logger.error(`insertTransaction deterministic failure in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${loop.insertQuarantineCount}/${TX_PARSE_MAX_RETRIES}), retrying block`)
        }
        return 'rollback'
    } else if (insertResult === false){
        // Transient INSERT failure; insertTransaction's error path
        // already rolled the block back. Retry indefinitely (never skip
        // a tx a healthy instance accepts).
        return 'rollback'
    }
}

async function storeDispenseOutput(loop, nextOutput, nextBlockHeight){
    nextOutput.txIndex = loop.lastProcessedTxIndex
    let insertResult = await this.db.insertTransactionOutput(
        nextOutput
    )
    if (insertResult === false){
        logger.error(`insertTransactionOutput (dispense) failed at block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }
    if (insertResult === this.db.DUPLICATED_TRANSACTION){
        logger.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${loop.lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
    }
}

//Store payment outputs the indexer needs to read:
//  • COINPAY: every native-coin output (settlement is determined
//    per-output; the indexer fans out per-output by LEFT JOIN-ing
//    transaction_outputs in getDecoderBlockData).
//  • Any action: the native-coin fee output paying the protocol
//    FEE_DESTINATION, so the indexer can validate native-coin fee
//    payments (xchain-indexer/src/utility.js detectFeePaymentMode /
//    validateNativeCoinFee). Captured only when feeDestination is set.
//  • DISPENSER v0/v2: the PRICE v1 oracle-usage-fee output paying
//    the dispenser's ORACLE_ADDRESS, so the indexer can validate it
//    (utility.validateOracleFee). Gated on
//    ORACLE_FEE_OUTPUT_ACTIVATION, and a v2 refill resolves to one
//    address or to the source's whole open set depending on
//    ORACLE_FEE_SET_CAPTURE_ACTIVATION; see
//    resolveOracleFeeAddresses.
// The action strings the capture decision is taken over. Both tests
// below read these rather than the TOP-LEVEL action name alone, which
// would let a BATCH carrying either action persist nothing, so its settlement
// would never reach the indexer. For a non-BATCH transaction, and for
// every block below BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
// this list is exactly [decodedData] and both tests reduce to the
// startsWith they replace; at/above the gate a BATCH yields its
// SUB-COMMANDS instead, split to agree with
// xchain-indexer/src/actions/batch.js (see batchSubCommandCapture).
async function capturePaymentOutputs(loop, block, parseResult, nextTransactionHash, nextBlockHeight, decodedData){
    let commands = captureCommands(decodedData, this.consensusNetwork, block.timestamp)
    let isCoinpay = commands.some(nextCommand => nextCommand.startsWith("COINPAY|"))
    let oracleFeeAddresses = await this.resolveOracleFeeAddressesForCommands(commands, parseResult["source"], block.timestamp, nextTransactionHash)
    if (oracleFeeAddresses === false){
        // Deterministic DB fault while resolving a refill's oracle
        // address. Capturing nothing here would drop an output a
        // healthy node captures, so retry the block instead.
        logger.error(`resolveOracleFeeAddresses failed at block ${nextBlockHeight}; block rolled back, retrying`)
        return 'rollback'
    }
    // Membership set, empty when this transaction is associated with no
    // oracle at all. Below ORACLE_FEE_SET_CAPTURE_ACTIVATION it holds at
    // most the one legacy pick, so the capture decision is identical to
    // the equality test it replaced.
    let oracleFeeAddressSet = new Set(oracleFeeAddresses)
    if (isCoinpay || this.feeDestination || oracleFeeAddressSet.size > 0){
        for (let nextOutput of parseResult["paymentOutputs"]){
            // Both address tests are truthiness-guarded: an unset
            // feeDestination is null, and an output whose address could
            // not be resolved is null too, so a bare !== comparison
            // would capture it by accident. The oracle test is set
            // membership rather than equality (a v2 refill can resolve
            // to several open dispensers' oracles above the flag-day),
            // and the set never holds a null member, so an unresolved
            // output address cannot match it either.
            let isFeeOutput    = this.feeDestination && nextOutput.destinationAddress === this.feeDestination
            let isOracleOutput = nextOutput.destinationAddress && oracleFeeAddressSet.has(nextOutput.destinationAddress)
            if (!isCoinpay && !isFeeOutput && !isOracleOutput)
                continue
            nextOutput.txIndex = loop.lastProcessedTxIndex
            let insertResult = await this.db.insertTransactionOutput(
                nextOutput
            )
            if (insertResult === false){
                logger.error(`insertTransactionOutput (payment) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                return 'rollback'
            }
            if (insertResult === this.db.DUPLICATED_TRANSACTION){
                logger.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${loop.lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
            }
        }
    }
    return commands
}

async function persistTransaction(loop, block, nextBlockHeight, openDispenserAddresses, parseResult, nextTransactionHash, dispenseOutputs, stored, decodedData, txIndex){
    if ((await insertTransactionRow.call(this, loop, parseResult, nextTransactionHash, nextBlockHeight, stored, txIndex)) === 'rollback') return 'rollback'
    //Store dispenses outputs. false means the INSERT failed and
    //the block transaction was already rolled back: stop writing
    //(anything further would land outside a transaction) and
    //retry the block.
    for (let nextOutput of dispenseOutputs){
        if ((await storeDispenseOutput.call(this, loop, nextOutput, nextBlockHeight)) === 'rollback') return 'rollback'
    }

    const commands = await capturePaymentOutputs.call(this, loop, block, parseResult, nextTransactionHash, nextBlockHeight, decodedData)
    if (commands === 'rollback') return 'rollback'

    const dispenserCommandPrefix = dispenserCommandPrefixFor.call(this, block)
    let dispenserCreateCandidates = collectDispenserCreates.call(this, commands, dispenserCommandPrefix, parseResult, block, nextTransactionHash, loop.lastProcessedTxIndex)

    // Pass 1b: one row per OPERATING ADDRESS, in first-appearance order.
    // A transaction carrying a single create (every non-BATCH transaction,
    // and every transaction below the gate) collapses to that create
    // unchanged, so this insert is byte-identical to the one it replaces.
    for (let nextRegistration of collapseDispenserRegistrations(dispenserCreateCandidates)){
        if ((await registerDispenser.call(this, loop, nextRegistration, openDispenserAddresses)) === 'rollback') return 'rollback'
    }

    // Pass 2: the format-1/2 lifecycle mirrors, after every create of
    // this transaction is registered (see the ordering note above).
    // Same gated prefix as pass 1: the two passes must agree about what
    // a DISPENSER command IS, or a string one pass registers is a string
    // the other declines to mirror.
    for (let dispenserCommand of commands){
        const extension = dispenserEditExtension.call(this, dispenserCommand, dispenserCommandPrefix, parseResult, block)
        if (extension && (await extendEditedDispenser.call(this, extension, nextBlockHeight)) === 'rollback') return 'rollback'
    }
}

async function ingestTransaction(loop, block, nextBlockHeight, openDispenserAddresses, nextTransaction, txIndex){
    let nextTransactionHash = null
    let parseResult = null

    // Insert-quarantine skip: this tx position deterministically failed to
    // INSERT on a prior pass of this block. Skip it exactly like a quarantined
    // parse-throw - PARSE_ERROR event, NO tx_index consumed, no insert - so a
    // poison row cannot wedge the block. The block transaction is open here
    // (beginTransaction ran when blocksQuantity hit 0), so the event commits
    // with the block. Deterministic across instances, so parity holds.
    if (loop.insertQuarantine.has(nextBlockHeight + ':' + txIndex)){
        return await skipQuarantinedTransaction.call(this, block, nextBlockHeight, nextTransaction, txIndex)
    }

    const parsed = await parseBlockTransaction.call(this, loop, block, nextBlockHeight, openDispenserAddresses, nextTransaction, txIndex)
    if (typeof parsed === 'string') return parsed
    ;({ nextTransactionHash, parseResult } = parsed)

    if (parseResult != null){
        let dispenseOutputs = parseResult['dispenseOutputs']

        if (this.hasStorableContent(parseResult)){
            loop.lastProcessedTxIndex = loop.lastProcessedTxIndex + 1
            loop.validTransactionsCount = loop.validTransactionsCount + 1

            // Storage gate (buildStoredActionRecord): a tx can carry BOTH an
            // XChain ACTION and money-bearing dispense/payment outputs. When the
            // ACTION is oversized or names an unknown action, those outputs are
            // NOT dropped: the bad action is blanked and the row is still
            // written. Only a tx with nothing else to record is skipped, and
            // that skip still consumes a tx_index (changing tx_index assignment
            // for invalid-action txs would diverge from already-decoded history).
            let stored = this.buildStoredActionRecord(parseResult, nextTransactionHash, false)
            if (stored.skip) return 'continue'
            // The canonical ACTION string as stored; the dispenser and
            // COINPAY handling below reads the same value the row holds.
            let decodedData = stored.data
            return await persistTransaction.call(this, loop, block, nextBlockHeight, openDispenserAddresses, parseResult, nextTransactionHash, dispenseOutputs, stored, decodedData, txIndex)
        } else {
            // Verify a payload that says something has an author. A
            // record with no resolvable source address cannot be
            // attributed to anyone, so it is skipped rather than stored.
            if ((parseResult["data"].length > 0) && (parseResult["source"] == null)){
                logger.error(`Skipping tx ${nextTransactionHash}: XChain data found but source address could not be resolved`)
            }
        }
    }
}

module.exports = { ingestTransaction }
