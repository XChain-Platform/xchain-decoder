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
const { jsonBigIntSafe } = require('./query_helpers.js')

module.exports = {
    async getAddressId(address){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            logger.error(formatLogLine('Error looking up address record id in index_addresses table:', err));
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return id;
    },

    async createAddress(address){
        // An empty address resolves to the reserved sentinel row id 1 rather than
        // interning a blank value.
        if(address==null||address=='')
            return 1;
        var id = await this.getAddressId(address);
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index, as in
            // createTransaction above.
            let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)"
            try {
                await db.query(query, [address]);
            } catch (err) {
                logger.error(formatLogLine('Error trying to create address record in index_addresses table:', err));
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getAddressId(address);
        }
        return id;
    },

    async hasPubkey(addressId){
        let db = await this.getConnection()
        try {
            let rows = await db.query("SELECT 1 FROM pubkeys WHERE address_id=? LIMIT 1", [addressId])
            return rows.length > 0
        } catch (err) {
            logger.error(formatLogLine('Error checking pubkey existence:', err))
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    },

    async insertPubkey(addressId, pubkey){
        let db = await this.getConnection()
        try {
            await db.query("INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)", [addressId, pubkey])
            return true
        } catch (err) {
            logger.error(formatLogLine('Error inserting pubkey:', err))
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    },

    // blockTime is a unix timestamp (seconds) from the block header. When provided,
    // PARSE_ERROR rows use the block timestamp so replicas that process the same
    // deterministic error at different wall-clock times produce byte-identical rows.
    // REORG events are operator-local by nature (each node's reorg exposure differs)
    // and may omit blockTime; they fall back to the current wall clock.
    async insertEvent(code, data, blockTime){
        const query = `
            INSERT INTO events (
            time,
            code,
            data
        ) VALUES (?, ?, ?);
        `;

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            let timeString = blockTime != null
                ? new Date(blockTime * 1000).toISOString().slice(0, 19).replace('T', ' ')
                : new Date().toISOString().slice(0, 19).replace('T', ' ');
            // Replacer keeps a stray BigInt field (jsonBigIntSafe above) from throwing
            // and silently failing the whole event write.
            let dataString = JSON.stringify(data, jsonBigIntSafe)

            await connection.query(query, [
                timeString,
                code,
                dataString
            ])

            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                logger.error(formatLogLine('Error inserting event:', err));
                if (this.transactionConnection){
                    // Roll back + free the transaction lock, matching every sibling
                    // insert. releaseConnection() alone leaves the transaction open on
                    // the pooled connection AND never calls releaseTransactionLock(),
                    // so the next beginTransaction() would wait on the lock forever.
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    async insertTransactionOutput(dispenseOutput) {
        const query = `
            INSERT INTO transaction_outputs (
            tx_index,
            vout,
            destination_id,
            amount
        ) VALUES (?, ?, ?, ?);
        `

        let connection = await this.getConnection()
        // Entry-time lease snapshot (rationale at insertBlock).
        const ownLease = (this.transactionConnection == null)

        try {
            let txIndex = dispenseOutput.txIndex
            let vout = dispenseOutput.vout
            let destinationId = await this.createAddress(dispenseOutput.destinationAddress)
            let amount = this.bigIntSatoshiToDecimalsString(dispenseOutput.amount)

            await connection.query(query, [
                txIndex,
                vout,
                destinationId,
                amount
            ])

            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                logger.error(formatLogLine('Error inserting dispense output:', err));
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },
}
