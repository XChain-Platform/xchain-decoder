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
const { logger } = require('./constants.js')

module.exports = {
    async insertMempoolTransaction(tx) {
        const query = `
            INSERT INTO mempool_transactions (
            tx_hash,
            source,
            destination,
            amount,
            fee,
            data,
            raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            // Store raw strings here; never allocate index_addresses/index_transactions
            // ids. Mempool arrival order is node-local and non-deterministic, but those
            // lookup tables are replicated, so pre-allocating ids during mempool
            // observation would let two nodes assign different ids to the same
            // address/hash and silently diverge. Lookup ids are allocated only during
            // deterministic block-confirmation processing (see insertTransaction).
            await connection.query(query, [
                tx.hash,
                tx.source,
                tx.destination,
                tx.amount,
                tx.fee,
                tx.data,
                // Mirror insertTransaction: the encoder's second push (FILE bytes, gated
                // ciphertext) belongs on the pending row too, or the payload only appears
                // at confirmation and a pending row cannot be correlated with its twin.
                tx.raw_data || null
            ])

            return true
        } catch (err) {
            if (err.errno == 1062) {
                return this.DUPLICATED_TRANSACTION
            } else {
                logger.error(formatLogLine('Error inserting mempool transaction:', err));
                if (this.transactionConnection) {
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    },

    // Bounded read of the current mempool snapshot for the API's getmempool
    // method. Same raw-string columns the explorer's colocated-DB path reads
    // (tx_hash/source/data), plus first_seen (2026-08-22-mempool-first-seen.sql).
    // ORDER BY the unique-indexed tx_hash: the table has no primary key and is
    // rewritten row-by-row every poll cycle, so a bare LIMIT would return a
    // scan-order subset that churns between polls; callers diff/page this
    // window as a stable snapshot. Capped at 500 like the explorer's own
    // getDecoderMempoolRows window.
    //
    // ACTION-CARRYING ROWS ONLY. This table holds a row for EVERY mempool tx the
    // decoder observed, not just XChain ones: buildStoredActionRecord blanks
    // `data` to '' (never NULL) for a money-bearing tx whose ACTION was invalid
    // or unknown, which on a public chain is nearly all of them (measured on BTC
    // testnet 2026-08-22: 32 of 32 rows). An unfiltered window is useless to the
    // consumer, because on a busy chain all 500 slots fill with actionless rows
    // and the feed renders empty while real pending actions sit deeper in the
    // table. Consumers drop these rows at decode time anyway, so filter here,
    // where the LIMIT is applied.
    async getMempoolTransactions(limit) {
        const max = Math.max(1, Math.min(Number(limit) || 200, 500))
        const query = `
            SELECT tx_hash, source, data, first_seen
            FROM mempool_transactions
            WHERE data IS NOT NULL AND data != ''
            ORDER BY tx_hash
            LIMIT ${max};
        `;
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            return rows || []
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    },

    // Count of pending ACTION-carrying txs, companion to the bounded window
    // above so getmempool can report a true total when the matching set runs
    // past the 500-row cap. Carries the same `data != ''` filter and for the
    // same reason (see getMempoolTransactions): an unfiltered COUNT(*) here is
    // the size of the whole node mempool, so publishing it as the XChain
    // unconfirmed count reports every unrelated payment on the chain as a
    // pending XChain action.
    async getMempoolTransactionCount() {
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(
                "SELECT COUNT(*) AS count FROM mempool_transactions WHERE data IS NOT NULL AND data != '';")
            return (rows && rows.length) ? Number(rows[0].count) : 0
        } finally {
            if (ownLease) {
                await connection.release()
            }
        }
    },
}
