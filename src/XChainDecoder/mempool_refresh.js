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
const { logger, MEMPOOL_BATCH_SIZE } = require('./constants.js')

function dedupNodeMempool(rawMempoolUnordered){
    // getrawmempool answers with an array of txids; rpcResult only guarantees the
    // result member is present, never its type. Reject any other shape HERE, at the
    // boundary, and let the catch below skip the poll: a malformed-but-iterable
    // answer (a bare string from an RPC proxy or a trimmed body) dedups into
    // per-character "txids", and deleteAndCompareTxsNotInList then anti-joins the
    // stored table against that snapshot and deletes every pending row, blanking
    // the published feed until a healthy poll refills it. Mirrors the shape check
    // the verbose-block consumer makes in BlockchainConnector.getBlockReassembled.
    if (!Array.isArray(rawMempoolUnordered)) {
        throw new Error('getrawmempool did not return an array')
    }

    // Dedup + single O(n log n) sort. The old per-txid binary-insert
    // (bs + splice) was O(n^2) in mempool size every poll cycle, a CPU
    // hazard under a mempool flood. What the consumer needs is the DEDUP:
    // db.js deleteAndCompareTxsNotInList seeds this array into a temp
    // table and filters it through a Set, so a repeated txid would be
    // fetched and inserted twice. The descending sort is deterministic
    // poll-order only (it preserves the order the old bs comparator
    // produced, which keeps logs and fixtures comparable); nothing in the
    // DB layer searches this array, so no ordering is load-bearing.
    return Array.from(new Set(rawMempoolUnordered))
        .sort((a, b) => b.localeCompare(a))
}

function decodeMempoolTransaction(nextTxHex, nextTxHexIndex){
    let nextTx
    try {
        nextTx = this.xchainBlockDecoder.transactionFromHex(nextTxHex)
    } catch (err) {
        this.parseErrors++
        logger.error(formatLogLine(`Mempool: failed to parse tx hex (batch index ${nextTxHexIndex}): `, err))
        return null
    }

    if (nextTx.ins.length === 0) {
        // HogEx / MWEB-only transactions have no inputs and carry no XChain data
        return null
    }
    return nextTx
}

function* parseMempoolTransaction(nextTx, nextTransactionHash){
    let parseResult = null
    try {
        // Pass mempoolDb so the pubkey-capture writes inside parseTransaction also
        // stay off the block transaction. The envelope
        // recognition height is gated on this decoder's own
        // next block (lastProcessedBlockIndex + 1): a pending
        // tx confirms at the earliest into that block, and the
        // mempool view is per-instance and non-consensus, so a
        // briefly-lagging instance near the flag boundary is
        // acceptable where a forked BLOCK parse would not be.
        parseResult = yield this.parseTransaction(nextTx, undefined, this.mempoolDb, this.lastProcessedBlockIndex + 1)
    } catch (err) {
        // The surrounding try has no catch (only a finally for the busy
        // flag), so a single undecodable mempool tx would abort the whole
        // mempool update cycle. Skip just the tx; it is retried on the
        // next cycle anyway since it never reaches the database.
        this.parseErrors++
        logger.error(formatLogLine(`Mempool: parseTransaction failed for tx ${nextTransactionHash}, skipping:`, err))
        return null
    }
    return parseResult
}

function* storeMempoolTransaction(nextTxHex, nextTxHexIndex){
    let nextTx = decodeMempoolTransaction.call(this, nextTxHex, nextTxHexIndex)
    if (nextTx == null) {
        return false
    }

    let nextTransactionHash = nextTx.getId()

    let parseResult = yield* parseMempoolTransaction.call(this, nextTx, nextTransactionHash)
    if (parseResult == null) {
        return false
    }

    // Same storage gate as the confirmed-block path, by construction:
    // buildStoredActionRecord owns the ceiling, the alias expansion, the
    // UTF-8 decode and the VALID_ACTION_NAMES check, so a pending tx can
    // never show one thing and then silently vanish on confirm. It stores
    // the canonical payload as the SAME UTF-8 string the block path writes,
    // not hex: otherwise mempool_transactions.data ("434f..." hex) and
    // transactions.data ("COINPAY|..." text) hold the same on-wire ACTION in
    // two encodings and content-correlation between a pending row and its
    // confirmed twin silently mismatches (uuid:26220713). A rejected ACTION
    // on a money-bearing tx blanks to '' (never SQL NULL) for the same reason.
    let stored = this.buildStoredActionRecord(parseResult, nextTransactionHash, true)
    if (stored.skip) return false

    if (!(yield this.mempoolDb.insertMempoolTransaction({
        hash: nextTransactionHash,
        source: parseResult["source"],
        destination: parseResult["destination"],
        amount: parseResult["amount"],
        fee: 0,
        data: stored.data,
        raw_data: stored.rawData

    }))) {
        yield this.sleep(3000)
        return false
    } else {
        return (parseResult["data"] != null) && (parseResult["data"].length > 0)
    }
}

function* storeMempoolBatches(rawMempool){
    let validTransactionsCount = 0
    let i = 0
    while (i < rawMempool.length) {
        let nextRawMempoolChunk = rawMempool.slice(i, i + MEMPOOL_BATCH_SIZE)

        let nextTxsHex = []
        try {
            nextTxsHex = yield this.connector.getRawTransactions(nextRawMempoolChunk)

        } catch (err) {
            logger.error(formatLogLine(`mempool: failed to fetch raw transactions for batch starting at index ${i}: `, err))
            logger.error(formatLogLine("Skipping batch and continuing...", err))
            i = i + MEMPOOL_BATCH_SIZE
            yield this.sleep(1000)
            continue
        }

        for (let nextTxHexIndex = 0; nextTxHexIndex < nextTxsHex.length; nextTxHexIndex++) {
            let nextTxHex = nextTxsHex[nextTxHexIndex]

            if (nextTxHex == null) {
                continue
            }

            if (yield* storeMempoolTransaction.call(this, nextTxHex, nextTxHexIndex)) {
                validTransactionsCount = validTransactionsCount + 1
            }
        }

        i = i + MEMPOOL_BATCH_SIZE
    }
    return validTransactionsCount
}

function* refreshMempoolRows(rawMempool, nodeMempoolCount, mempoolStartTime){
    let validTransactionsCount = 0

    // All mempool DB work runs on this.mempoolDb, never this.db, so it stays outside the
    // block loop's open transaction. Deletes txs no longer in the node mempool and
    // drops txs already stored, leaving rawMempool holding only the new arrivals.
    let deletedInfo = yield this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool)

    let deletedTransactionsCount = deletedInfo.transactionsDeleted
    // Read the length before the batch loop, while it still means "new arrivals":
    // the call above truncated rawMempool down to the txids this node has not stored.
    let newArrivalsCount = rawMempool.length

    validTransactionsCount = yield* storeMempoolBatches.call(this, rawMempool)

    let mempoolEndTime = Date.now()
    let timeString = this.millisecondsToTimeString(mempoolEndTime - mempoolStartTime)

    // nodeMempoolCount, not rawMempool.length: the db diff empties and refills
    // rawMempool in place, so by here its length is the new-arrival count.
    logger.info("Mempool updated!"
        + " Transactions (" + nodeMempoolCount + " in mempool, " + newArrivalsCount + " new, " + validTransactionsCount + " valid, " + deletedTransactionsCount + " less) [" + timeString + "]")
}

module.exports = {
    async updateMempool(){
        if (!this.mempoolBusy) {
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            // Mempool size as the node reported it, held separately because
            // deleteAndCompareTxsNotInList below empties and refills rawMempool in place.
            let nodeMempoolCount = 0
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()
                rawMempool = dedupNodeMempool(rawMempoolUnordered)

                // Snapshot the node's total mempool size for the API's getmempool
                // method (deduped count, matching what this cycle actually processes).
                nodeMempoolCount = rawMempool.length
                this.nodeMempoolTxCount = nodeMempoolCount
                this.nodeMempoolUpdatedAt = Date.now()

            } catch (error) {
                logger.info(error)
                logger.info(formatLogLine("There were problems getting the mempool, trying again later.", error))
                this.mempoolBusy = false
                return
            }

            try {
                // The row steps are generators that yield each node and database
                // promise to this loop, so a cycle suspends only where it waits on
                // a value, once per wait, and a tx it skips costs no suspension at
                // all. An async step awaited here would add a suspension after each
                // of its waits and on every skipped tx, and a concurrent caller
                // could then run between steps that belong to one stretch.
                const steps = refreshMempoolRows.call(this, rawMempool, nodeMempoolCount, mempoolStartTime)
                let next = steps.next()
                while (!next.done){
                    let settled
                    try {
                        settled = await next.value
                    } catch (err) {
                        next = steps.throw(err)
                        continue
                    }
                    next = steps.next(settled)
                }
            } finally {
                // Always clear the busy flag, even if a DB or parse operation above threw.
                // Otherwise a single transient failure would leave mempool tracking frozen
                // for the rest of the process lifetime.
                this.mempoolBusy = false
            }
        } else {
            logger.info("Mempool is still busy")
        }
    },
}
