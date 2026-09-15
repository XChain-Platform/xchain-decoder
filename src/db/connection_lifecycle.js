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

const mariadb = require('mariadb');
const util = require('../util')
const { format: formatLogLine } = require('node:util');
const { logger } = require('./constants.js')

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Drain support (src/shutdown.js): release a transaction connection still
    // held, which the drain normally never sees because it waits for the parse
    // loop to break at a block boundary, then end the pool so nothing keeps the
    // event loop alive. Idempotent: a second call finds no pool and returns.
    async close(){
        if(this.transactionConnection){
            try { await this.transactionConnection.release(); } catch(_){}
            this.transactionConnection = null;
        }
        const pool = this.pool;
        if(!pool) return;
        this.pool = null;
        await pool.end();
    },

    // Seam over the driver: mariadb's createConnection export is
    // non-configurable, so tests stub this method instead of the module.
    createConnection(connectionParams){
        return mariadb.createConnection(connectionParams);
    },

    // Handle getting a database Connection (with exponential backoff + jitter).
    // Matches the indexer's retry shape so a transient MariaDB blip during
    // heavy concurrent load (e.g. e2etest container build + initial seeding)
    // doesn't crash the decoder process. ~5min worst-case patience before
    // surfacing a real outage.
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection  = null;
        var attempts    = 0;
        var maxAttempts = 30;
        var baseDelay   = 500;   // 500ms initial delay
        var maxDelay    = 15000; // 15s max delay
        while(connection == null){
            try {
                connection = await this.pool.getConnection();
            } catch (e){
                attempts++;
                if(attempts >= maxAttempts)
                    throw new Error('Failed to get database connection after ' + maxAttempts + ' attempts: ' + e.code)
                let delay      = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter     = Math.floor(Math.random() * delay * 0.3);
                let totalDelay = delay + jitter;
                logger.error(formatLogLine('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e))
                connection = null;
                await util.sleep(totalDelay);
            }
        }
        return connection;
    },

    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }
    },

    // DB liveness probe for the API health/status endpoints. Draws a connection
    // DIRECTLY from the pool, never via getConnection(): while a block is being
    // processed, getConnection() returns the shared transactionConnection, and a
    // probe that then .release()s it hands the block's live transaction
    // connection back to the pool while the block loop keeps writing on it.
    // Any monitor polling /status mid-block would break per-block atomicity.
    // No retry/backoff either: a health check wants the current truth.
    async ping(){
        let conn = await this.pool.getConnection();
        try {
            await conn.query('SELECT 1');
            return true;
        } finally {
            try { await conn.release(); } catch(_){}
        }
    },

    async acquireTransactionLock(){
        if (!this._transactionLock) {
            this._transactionLock = true
            return
        }
        await new Promise(resolve => this._transactionLockQueue.push(resolve))
    },

    releaseTransactionLock(){
        if (this._transactionLockQueue.length > 0) {
            let next = this._transactionLockQueue.shift()
            next()
        } else {
            this._transactionLock = false
        }
    },

    async beginTransaction(){
        await this.acquireTransactionLock()

        if (this.transactionConnection != null){
            await this.endTransaction()
        }

        this.transactionConnection = await this.getConnection()
        try {
            await this.transactionConnection.beginTransaction()
        } catch(err){
            await this.transactionConnection.release()
            this.transactionConnection = null
            this.releaseTransactionLock()
            throw err
        }
    },

    async endTransaction(){
        if (this.transactionConnection != null){
            logger.info("rolling back")
            await this.transactionConnection.rollback()
            await this.transactionConnection.release()
            this.transactionConnection = null
        }
        this.releaseTransactionLock()
    },

    async commitTransaction(){
        if (this.transactionConnection != null){
            try {
                await this.transactionConnection.commit()
                await this.transactionConnection.release()
                this.transactionConnection = null
                this.releaseTransactionLock()
                return true
            } catch (e){
                logger.error("There was an error trying to commit a transaction: " + e.code)
                await this.endTransaction()
            }
        }

        return false
    },
}
