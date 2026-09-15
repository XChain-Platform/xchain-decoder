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

const { format: formatLogLine } = require('node:util');
const { SATOSHIS_DECIMALS, logger } = require('./constants.js')

async function deleteBlockRows(connection, blockIndex){
    // Resurrect any dispenser that THIS (now-orphaned) block soft-expired:
    // clear the expiry mark so it is open again. Must run before the
    // dispenser row-delete below (a dispenser both OPENED and expired in
    // this same orphaned block is hard-deleted by tx_index there, while one
    // opened in an EARLIER block but expired by this block is restored here.
    let query = `
        UPDATE dispensers SET expired_block_index = NULL WHERE expired_block_index = ?;
    `;
    await connection.query(query, [blockIndex])
    // Delete child rows first: transaction_outputs and dispensers are
    // keyed by tx_index, so they must be removed before the parent
    // transactions rows they reference are deleted. Otherwise the decoder
    // re-inserts the same block and hits duplicate-key errors, leaving
    // stale pre-reorg rows that the indexer reads as valid.
    query = `
        DELETE FROM transaction_outputs WHERE tx_index IN (SELECT tx_index FROM transactions WHERE block_index = ?);
    `;
    await connection.query(query, [blockIndex])
    query = `
        DELETE FROM dispensers WHERE tx_index IN (SELECT tx_index FROM transactions WHERE block_index = ?);
    `;
    await connection.query(query, [blockIndex])
    query = `
        DELETE FROM transactions WHERE block_index = ?;
    `;
    await connection.query(query, [blockIndex])
    query = `
        DELETE FROM blocks WHERE block_index = ?;
    `;
    await connection.query(query, [blockIndex])
}

async function insertReorgEvent(connection, blockIndex, reorgBlockHash){
    // index_addresses is intentionally NOT deleted on reorg: it is an append-only,
    // first-reference (INSERT IGNORE) lookup whose AUTO_INCREMENT id is a purely local
    // artifact. Downstream consumers resolve it to the canonical address string and never
    // treat the id as consensus-visible, so an orphan row left by a reorg is harmless. Do
    // not start feeding a raw lookup id into any consensus/hashed value.

    // events is likewise intentionally NOT deleted on reorg: it is an append-only audit
    // log with no block_index column (rows like PARSE_ERROR only carry a height inside
    // their JSON payload). Orphaned audit rows for rolled-back blocks are accepted as
    // stale-but-harmless history, and the REORG marker inserted below records the
    // deletion itself in that same log. The indexer's reorg detection consumes events
    // by ascending id and would misbehave if rows were retroactively removed.

    // Crash durability: the REORG audit marker is written in the SAME transaction that
    // deletes the block, so the delete and its marker are atomic. A single marker written
    // once at the end of verifyReorg leaves a crash window where the blocks are gone but no
    // marker exists, and the indexer (which detects decoder reorgs solely by reading these
    // events rows and rolling back to the lowest block_index across them) never retracts the
    // orphaned old-chain rows it already indexed: a silent, permanent divergence. The
    // indexer rolls back to the deepest block_index across all unprocessed markers, so N
    // single-block markers land it exactly where one combined event would have, and a marker
    // for block B becomes visible only once B is actually deleted, so it can never roll back
    // onto a block still present in a half-deleted decoder. Payload shape matches the
    // indexer's parser (array of {block_index, block_hash}); reorgBlockHash is omitted by
    // non-reorg callers, leaving deleteBlockByIndex a plain delete.
    if (reorgBlockHash != null){
        const eventQuery = `INSERT INTO events (time, code, data) VALUES (?, ?, ?);`
        const nowString  = new Date().toISOString().slice(0, 19).replace('T', ' ')
        const eventData  = JSON.stringify([{ block_index: blockIndex, block_hash: reorgBlockHash }])
        await connection.query(eventQuery, [nowString, 'REORG', eventData])
    }
}

module.exports = {
    bigIntSatoshiToDecimalsString(bigIntValue) {
        let negative = false
        if (bigIntValue < 0) {
            negative = true
            bigIntValue = typeof bigIntValue === 'bigint' ? -bigIntValue : -bigIntValue
        }

        const strBigInt = bigIntValue.toString();
        const bigIntLength = strBigInt.length;
        let result

        if (bigIntLength <= SATOSHIS_DECIMALS) {
            let missingZeros = SATOSHIS_DECIMALS - bigIntLength;
            let decimalPart = '0'.repeat(missingZeros) + strBigInt;
            result = `0.${decimalPart}`;
        } else {
            const decimalSeparatorIndex = bigIntLength - SATOSHIS_DECIMALS;
            const integerPart = strBigInt.slice(0, decimalSeparatorIndex);
            const decimalPart = strBigInt.slice(decimalSeparatorIndex);
            result = `${integerPart}.${decimalPart}`;
        }

        return negative ? `-${result}` : result;
    },

    async deleteBlockByIndex(blockIndex, reorgBlockHash){
        await this.beginTransaction()
        let connection = await this.getConnection()

        try {
            await deleteBlockRows(connection, blockIndex)
            await insertReorgEvent(connection, blockIndex, reorgBlockHash)

            const committed = await this.commitTransaction()
            if (!committed) throw new Error('deleteBlockByIndex: commit failed for block ' + blockIndex)

            return true
        } catch (err) {
            // A query failure here would otherwise escape with the transaction
            // lock still held and the connection still open, deadlocking every
            // later caller that waits on the lock. Roll back and release the
            // lock before propagating so the reorg retry path can recover.
            logger.error(formatLogLine('Error deleting block by index:', err));
            if (this.transactionConnection){
                await this.endTransaction()
            }
            throw err
        }
    },

    async getLastBlockIndex(){
        const query = `
            SELECT MAX(block_index) AS max_height FROM blocks ;
        `;
        // Retry a transient DB error a few times, then THROW. Never return a
        // non-numeric sentinel: the old `return false` was silently coerced to a
        // height (`false + 1 === 1`), which collided block 1 and wedged the parse
        // loop in an insert/rollback spin, and in verifyReorg turned
        // getBlockByIndex(false) into a null row that ended the walk early and
        // emitted a REORG event for a partial deletion. start() has no retry
        // wrapper, so a throw here surfaces loud (process visible to health checks)
        // instead of corrupting height math silently.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query)
                if (rows.length > 0 && rows[0]["max_height"] != null){
                    // block_index is BIGINT UNSIGNED, so the driver returns a JS BigInt.
                    // Coerce to Number: heights are well within Number.MAX_SAFE_INTEGER, and a
                    // BigInt breaks both arithmetic (`+1` in the parse loop) and JSON serialization
                    // Note: getBlockHash's axios body and insertEvent's JSON.stringify both throw
                    // "Do not know how to serialize a BigInt", which silently wedges verifyReorg.
                    return Number(rows[0]["max_height"])
                }
                return -1
            } catch (err) {
                lastErr = err
                logger.error(formatLogLine(`Error selecting max block height (attempt ${attempt}/${MAX_ATTEMPTS}):`, err));
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getLastBlockIndex failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    },

    async getLastTxIndex(){
        const query = `
            SELECT MAX(tx_index) AS max_tx_index FROM transactions;
        `;
        // Retry-then-throw, same rationale as getLastBlockIndex: a `return false`
        // reset the tx counter to 1 on any DB error, colliding tx_index 1.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query)
                if (rows.length > 0 && rows[0]["max_tx_index"] != null){
                    // tx_index is BIGINT UNSIGNED: coerce the BigInt to Number for the same
                    // reasons as getLastBlockIndex (arithmetic + JSON-RPC/event serialization).
                    return Number(rows[0]["max_tx_index"])
                }
                return -1
            } catch (err) {
                lastErr = err
                logger.error(formatLogLine(`Error selecting max tx index (attempt ${attempt}/${MAX_ATTEMPTS}):`, err));
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getLastTxIndex failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    },

    async getBlockByIndex(blockIndex){
        const query = `
            SELECT b.*, it.hash AS block_hash, previous_it.hash AS previous_block_hash FROM blocks b
            LEFT JOIN index_transactions it ON it.id = b.block_hash_id
            LEFT JOIN index_transactions previous_it ON previous_it.id = b.previous_block_hash_id
            WHERE block_index = ?;
        `;

        // Retry-then-throw, same rationale as getLastBlockIndex/getLastTxIndex above.
        // A `catch { return null }` makes a failed query indistinguishable from "no such
        // row", and verifyReorg's backward walk treats a null row as "table exhausted":
        // ONE failed read then ended the rollback walk and reported the reorg reconciled
        // while orphan blocks were still stored above the fork point. Here null means
        // exactly "no such row"; a read that never succeeds throws, so each caller decides
        // what to do with a failure.
        const MAX_ATTEMPTS = 5
        let lastErr = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query, [blockIndex])
                if (rows.length > 0){
                    return rows[0]
                } else {
                    return null
                }
            } catch (err) {
                lastErr = err
                logger.error(formatLogLine(`Error selecting block by index ${blockIndex} (attempt ${attempt}/${MAX_ATTEMPTS}):`, err));
            } finally {
                if (this.transactionConnection == null){
                    await connection.release()
                }
            }
            if (attempt < MAX_ATTEMPTS) await this.sleep(1000)
        }
        throw new Error('getBlockByIndex(' + blockIndex + ') failed after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr && lastErr.message))
    },

    async insertBlock(block) {
        const query = `
        INSERT INTO blocks (
        block_index,
        block_hash_id,
        block_time,
        previous_block_hash_id
        ) VALUES (?, ?, ?, ?);
        `;

        let blockHashId = await this.createTransaction(block.block_hash)
        let previousBlockHashId = await this.createTransaction(block.previous_block_hash)

        let connection = await this.getConnection()
        // Snapshot whether WE acquired this lease. Inside a block transaction
        // getConnection() returns the shared this.transactionConnection, and the catch
        // path's endTransaction() releases it and nulls the field, so the finally must key
        // off this entry-time snapshot, not the mutated field, or it would release the same
        // pooled socket a second time.
        const ownLease = (this.transactionConnection == null)

        try {
            await connection.query(query, [
                block.block_index,
                blockHashId,
                block.block_time,
                previousBlockHashId
            ])

            return true
        } catch (err) {
            logger.error(formatLogLine('Error inserting block:', err));
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },
}
