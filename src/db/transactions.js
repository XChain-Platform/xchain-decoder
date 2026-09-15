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

const { getLogger } = require('../observability')
const { format: formatLogLine } = require('node:util');
const { DETERMINISTIC_WRITE_ERRNOS, logger } = require('./constants.js')

async function insertTransactionRow(database, connection, query, tx){
    let txHashId = await database.createTransaction(tx.hash)
    let sourceId = await database.createAddress(tx.source)
    let destinationId = await database.createAddress(tx.destination)

    // Record the key this transaction exposed for a source that had no
    // index_addresses row when parseTransaction ran: createAddress has just
    // allocated it, and nothing else writes the pubkey later, so without this the
    // first-ever action from an address leaves source_pubkey permanently NULL
    // across the decoder->indexer seam. Inside the block's open transaction, so
    // it commits or rolls back with the block. Sentinel id 1 (empty address) is
    // never a real source. insertPubkey is INSERT IGNORE against a PRIMARY KEY
    // and swallows its own errors, so a pubkey hiccup can never turn a good
    // transaction into a quarantined poison row.
    if (tx.source_pubkey && sourceId != null && sourceId !== 1){
        await database.insertPubkey(sourceId, tx.source_pubkey)
    }

    await connection.query(query, [
        tx.index,
        txHashId,
        tx.block_index,
        sourceId,
        destinationId,
        tx.amount,
        tx.fee,
        tx.data,
        tx.raw_data || null
    ])
}

async function seedMempoolSnapshot(connection, table, txidList, chunkSize){
    // Default temp storage engine (InnoDB) spills to disk, so a huge
    // mempool snapshot cannot blow max_heap_table_size the way a MEMORY
    // engine table would. Collation matches mempool_transactions.tx_hash so
    // the JOIN uses the unique index and compares identically.
    await connection.query(
        'CREATE TEMPORARY TABLE IF NOT EXISTS ' + table + ' (' +
        'tx_hash VARCHAR(250) CHARACTER SET utf8 COLLATE utf8_unicode_ci NOT NULL, ' +
        'INDEX (tx_hash)' +
        ')'
    )
    // A reused pooled connection may still hold a prior cycle's snapshot;
    // clear it before seeding this cycle's node mempool.
    await connection.query('DELETE FROM ' + table)

    if (txidList.length > 0) {
        for (let i = 0; i < txidList.length; i += chunkSize) {
            const chunk = txidList.slice(i, i + chunkSize)
            const placeholders = chunk.map(() => '(?)').join(',')
            await connection.query(
                'INSERT IGNORE INTO ' + table + ' (tx_hash) VALUES ' + placeholders,
                chunk
            )
        }
    }
}

async function reconcileMempoolSnapshot(connection, table, txidList){
    // (1) Delete stored rows absent from the node snapshot (anti-join).
    // With an empty snapshot (node mempool empty) this deletes every row.
    const deleteResult = await connection.query(
        'DELETE m FROM mempool_transactions m ' +
        'LEFT JOIN ' + table + ' s ON s.tx_hash = m.tx_hash ' +
        'WHERE s.tx_hash IS NULL'
    )
    const transactionsDeleted = Number((deleteResult && deleteResult.affectedRows) || 0)

    // (2) Which snapshot txids are already stored? Only the intersection is
    // returned, never the whole table. Skip the query entirely when there
    // is nothing to compare.
    let presentRows = []
    if (txidList.length > 0) {
        presentRows = await connection.query(
            'SELECT s.tx_hash AS hash FROM ' + table + ' s ' +
            'JOIN mempool_transactions m ON m.tx_hash = s.tx_hash'
        )
    }

    if (presentRows.length > 0) {
        const present = new Set(presentRows.map((r) => r.hash))
        // Filter preserves the caller's descending order; mutate the array
        // in place because the caller keeps using the same reference.
        const remaining = txidList.filter((h) => !present.has(h))
        txidList.length = 0
        for (const h of remaining) txidList.push(h)
    }
    return { transactionsDeleted }
}

async function dropMempoolSnapshot(connection, table){
    // Drop the temp table so a pooled connection never leaks it into an
    // unrelated later query, then release the lease we acquired.
    // Unlike the pool-release catches elsewhere in this file, a failed drop
    // has a DEFERRED consequence on another query: the temp table rides the
    // pooled connection into unrelated work and the next mempool diff fails
    // on a table it did not create, with nothing naming the drop that lost.
    try { await connection.query('DROP TEMPORARY TABLE IF EXISTS ' + table) }
    catch (e) {
        try {
            getLogger().warn('DB_TEMP_TABLE_DROP_FAILED', {
                table,
                err: e && e.message ? e.message : String(e)
            })
        } catch (_) { /* cleanup must not become the failure */ }
    }
}

module.exports = {
    async getTransaction(txid){
        const query = `
            SELECT
                t.*,
                ia_source.address AS source,
                ia_destination.address AS destination,
                it.hash AS hash
                FROM transactions t
                LEFT JOIN index_transactions it ON it.id = t.tx_hash_id
                LEFT JOIN index_addresses ia_source ON ia_source.id = t.source_id
                LEFT JOIN index_addresses ia_destination ON ia_destination.id = t.destination_id
                WHERE it.hash = ?;
        `;

        let connection = await this.getConnection()

        try {
            const rows = await connection.query(query,[txid])
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error(formatLogLine('Error selecting a transaction from the db:', err));
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    },

    async insertTransaction(tx) {
        const query = `
            INSERT INTO transactions (
            tx_index,
            tx_hash_id,
            block_index,
            source_id,
            destination_id,
            amount,
            fee,
            data,
            raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            await insertTransactionRow(this, connection, query, tx)
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                logger.error(formatLogLine('Error inserting transaction:', err));
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                // A deterministic content/constraint rejection can never insert as-is;
                // signal POISON_ROW so the block loop quarantines the tx after a few
                // retries rather than retrying the block forever (a permanent wedge).
                // A transient error stays `false`: the loop retries indefinitely, since
                // skipping a tx a healthy instance accepts would break cross-instance parity.
                return DETERMINISTIC_WRITE_ERRNOS.has(err.errno) ? this.POISON_ROW : false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    async getTransactionId(hash){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        try {
            let rows = await db.query(query, [hash]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            logger.error(formatLogLine('Error looking up hash record id in index_transactions table:', err));
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }

        return id;
    },

    async createTransaction(hash){
        // An empty hash resolves to the reserved sentinel row id 1 rather than
        // interning a blank value.
        if(hash==null||hash=='')
            return 1;
        var id = await this.getTransactionId(hash);
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same hash between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id, so two callers can never create duplicate rows.
            let query = "INSERT IGNORE INTO index_transactions (`hash`) values (?)"
            try {
                await db.query(query, [hash]);
            } catch (err) {
                logger.error(formatLogLine('Error trying to create hash record in index_transactions table:', err));
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getTransactionId(hash);
        }
        return id;
    },

    // Set-based diff of the stored mempool against the node's current mempool. The node's
    // mempool is seeded into a session-scoped temp table and the whole diff runs in SQL
    // against the unique `tx_hash` index, so only the intersection ever crosses the wire.
    // Streaming every stored row into Node and searching it in JS instead made the poll
    // cycle grow with mempool depth, which a fee-spike mempool turns into a real cost.
    //
    // Two effects:
    //   1. stored rows whose tx_hash is no longer in the node mempool are DELETEd (they
    //      confirmed or were evicted);
    //   2. txids already stored are removed from `txidList` IN PLACE, so the caller is
    //      left holding only the new arrivals to fetch and insert.
    async deleteAndCompareTxsNotInList(txidList) {
        // Snapshot the lease ownership: inside a block transaction getConnection() hands
        // back the shared transaction connection, which we must not release. Mempool
        // maintenance runs on its own Database handle, so ownLease is true here in
        // practice, but keep the guard for correctness.
        const ownLease = (this.transactionConnection == null)
        let connection = await this.getConnection();

        // Bounded multi-row INSERT size: 5000 single-column rows keeps each
        // statement well under the placeholder/packet limits even on a flood.
        const INSERT_CHUNK = 5000
        // A session temp table is scoped to this ONE connection. Pooled
        // connections are reused, so it is always dropped in finally; the name is
        // unlikely to collide with anything else on the connection.
        const TMP = '_mempool_node_snapshot'

        try {
            await seedMempoolSnapshot(connection, TMP, txidList, INSERT_CHUNK)
            return await reconcileMempoolSnapshot(connection, TMP, txidList)
        } catch (err) {
            logger.error(formatLogLine('Error diffing mempool_transactions:', err));
            return { transactionsDeleted: 0 }
        } finally {
            await dropMempoolSnapshot(connection, TMP)
            if (ownLease) {
                await connection.release()
            }
        }
    },
}
