/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Decoder - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const fs      = require('fs');
const util    = require('./util')
const bs = require("binary-search")

const SATOSHIS_DECIMALS = 8
const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/

class Database {
    constructor(host, port, dbName, user, pass){
        if (!DB_NAME_REGEX.test(dbName)) {
            throw new Error('Invalid database name: must contain only alphanumeric characters and underscores')
        }
        this.sqlPath  = __dirname+'/sql';
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        this.DUPLICATED_TRANSACTION = 1
        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:  10,
            //connectTimeout: 0,
            insertIdAsNumber: true
        };
        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
        this._transactionLock = false;
        this._transactionLockQueue = [];
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    

    // Verify a database exists and return true or false
    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        while(true){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(result.length > 0)
                    return true;
                return false;
            } catch (e){
                console.error('Error checking if database ' + this.dbName + ' exists:', e)
                await util.sleep(5000); // Wait 5 seconds
            }
        }
    }

    // Handle creating a database
    async createDatabase(){
        // First time connecting, do not specify database name or we throw error
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        let databaseCreated = false;
        console.log("Creating " + this.dbName + " database!");
        while(!databaseCreated){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                console.error('Error creating database ' + this.dbName + ':', e)
                await util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }
    
    // Handle verifying all database tables exist
    async verifyTables(){
        let path  = this.sqlPath;
        let files = fs.readdirSync(path);
        let file  = null;
        let db    = await this.getConnection();
        // Snapshot the set of tables currently in this database. SHOW TABLES is a
        // direct query (no parameter binding quirks) and gives a clean per-DB list,
        // so the existence check below is reliable on a fresh DB.
        let existing = new Set();
        try {
            let rows = await db.query("SHOW TABLES FROM `" + this.dbName + "`");
            for (let row of rows){
                // SHOW TABLES returns one column named "Tables_in_<dbname>".
                for (let key in row){
                    existing.add(String(row[key]));
                    break;
                }
            }
        } catch(e){
            console.log('Error listing tables in ' + this.dbName + ': ' + (e && e.sqlMessage ? e.sqlMessage : e));
            util.throwError('Error while listing tables in ' + this.dbName);
            await this.releaseConnection();
            return false;
        }
        // Loop through SQL files
        for (file of files){
            var isSql = file.indexOf('.sql');
            if(isSql){
                let table   = file.substring(0, file.indexOf('.sql'));
                console.log('Verifying ' + table + ' table exists...');
                try {
                    if(existing.has(table)){
                        continue;
                    } else {
                        await this.createTable(file);
                        existing.add(table);
                    }
                } catch(e){
                    console.log('Error verifying table ' + table + ': ' + e.code);
                    util.throwError('Error while trying to verify ' + table + ' table exists!');
                    return false;
                }
            }
        }
        await this.releaseConnection();
        return true;
    }

    // Handle creating database tables
    async createTable(file){
        let path    = this.sqlPath;
        let data    = fs.readFileSync(path + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        let db      = await this.getConnection();
        let queries = data.split(';');
        let query   = null;
        console.log('Creating ' + table + ' table and indexes...');
        // Loop through SQL queries
        for(query of queries){
            query = query.trim();
            // Ignore empty queries
            if(query=='')
                continue;
            try {
                let result = await db.query(query);
                if(result.length > 0)
                    continue;
            } catch(e){
                util.throwError('Error while trying to create ' + table + ' table!');
            }
        }
        // Dont release connection after each table is created, connection released in verifyTables() after ALL tables created and verified
        // await this.releaseConnection();
    }

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
                console.error('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e)
                connection = null;
                await util.sleep(totalDelay);
            }
        }
        return connection;
    }

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            // console.log("releasing database connection");
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    async _acquireTransactionLock(){
        if (!this._transactionLock) {
            this._transactionLock = true
            return
        }
        await new Promise(resolve => this._transactionLockQueue.push(resolve))
    }

    _releaseTransactionLock(){
        if (this._transactionLockQueue.length > 0) {
            let next = this._transactionLockQueue.shift()
            next()
        } else {
            this._transactionLock = false
        }
    }

    async beginTransaction(){
        await this._acquireTransactionLock()

        if (this.transactionConnection != null){
            await this.endTransaction()
        }

        this.transactionConnection = await this.getConnection()
        try {
            await this.transactionConnection.beginTransaction()
        } catch(err){
            await this.transactionConnection.release()
            this.transactionConnection = null
            this._releaseTransactionLock()
            throw err
        }
    }

    async endTransaction(){
        if (this.transactionConnection != null){
            console.log("rolling back")
            await this.transactionConnection.rollback()
            await this.transactionConnection.release()
            this.transactionConnection = null
        }
        this._releaseTransactionLock()
    }

    async commitTransaction(){
        if (this.transactionConnection != null){
            try {
                await this.transactionConnection.commit()
                await this.transactionConnection.release()
                this.transactionConnection = null
                this._releaseTransactionLock()
                return true
            } catch (e){
                console.error("There was an error trying to commit a transaction: " + e.code)
                await this.endTransaction()
            }
        }

        return false
    }
    
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
    }
    
    async deleteBlockByIndex(blockIndex){
        await this.beginTransaction()
        let connection = await this.getConnection()
        
        // Delete child rows first: transaction_outputs and dispensers are
        // keyed by tx_index, so they must be removed before the parent
        // transactions rows they reference are deleted. Otherwise the decoder
        // re-inserts the same block and hits duplicate-key errors, leaving
        // stale pre-reorg rows that the indexer reads as valid.
        let query = `
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
        await this.commitTransaction()
        
        return true
    }
    
    async getLastBlockIndex(){
        const query = `
            SELECT MAX(block_index) AS max_height FROM blocks ;
        `;
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query)
            //await connection.release()
            if (rows.length > 0){
                if (rows[0]["max_height"] == null){
                    return -1
                } else {
                    return rows[0]["max_height"]
                }
            } else {
                return -1   
            }
        } catch (err) {
            console.error('Error selecting max block height:', err);
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
    async getLastTxIndex(){
        const query = `
            SELECT MAX(tx_index) AS max_tx_index FROM transactions;
        `;
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query)
            if (rows.length > 0){
                if (rows[0]["max_tx_index"] == null){
                    return -1
                } else {
                    return rows[0]["max_tx_index"]
                }
            } else {
                return -1   
            }
        } catch (err) {
            console.error('Error selecting max tx index:', err);
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
    async getBlockByIndex(blockIndex){
        const query = `
            SELECT b.*, it.hash AS block_hash, previous_it.hash AS previous_block_hash FROM blocks b
            LEFT JOIN index_transactions it ON it.id = b.block_hash_id
            LEFT JOIN index_transactions previous_it ON previous_it.id = b.previous_block_hash_id
            WHERE block_index = ?;
        `;
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query, [blockIndex])
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error selecting max block height:', err);
            return null
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
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
        
        try {
            await connection.query(query, [
                block.block_index,
                blockHashId,
                block.block_time,
                previousBlockHashId
            ])
            
            return true
        } catch (err) {
            console.error('Error inserting block:', err);
            if (this.transactionConnection){
                await this.endTransaction()
            }
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
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
            console.error('Error selecting a transaction from the db:', err);
            return false;
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }
    
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

        try {
            let txHashId = await this.createTransaction(tx.hash)
            let sourceId = await this.createAddress(tx.source)
            let destinationId = await this.createAddress(tx.destination)

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

            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting transaction:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }   
    }

    async insertMempoolTransaction(tx) {
        const query = `
            INSERT INTO mempool_transactions (
            tx_hash_id,
            source_id,
            destination_id,
            amount,
            fee,
            data
        ) VALUES (?, ?, ?, ?, ?, ?);
        `;

        let connection = await this.getConnection()

        try {
            let txHashId = await this.createTransaction(tx.hash)
            let sourceId = await this.createAddress(tx.source)
            let destinationId = await this.createAddress(tx.destination)

            await connection.query(query, [
                txHashId,
                sourceId,
                destinationId,
                tx.amount,
                tx.fee,
                tx.data
            ])

            return true
        } catch (err) {
            if (err.errno == 1062) {
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting mempool transaction:', err);
                if (this.transactionConnection) {
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null) {
                await connection.release()
            }
        }
    }

    //This is only used in tests
    async dropDatabase(){
        console.log("Droping database")
        
        const dropBlockTable = "DROP TABLE IF EXISTS blocks"
        const dropTransactionTable = "DROP TABLE IF EXISTS transactions"
        const dropIndexAddressesTable = "DROP TABLE IF EXISTS index_addresses"
        const dropIndexTransactionsTable = "DROP TABLE IF EXISTS index_transactions"
        const dropEventsTable = "DROP TABLE IF EXISTS events"
        
        let connection = await this.getConnection()
        
        await connection.query(dropTransactionTable)
        await connection.query(dropBlockTable)
        await connection.query(dropIndexAddressesTable)
        await connection.query(dropIndexTransactionsTable)
        await connection.query(dropEventsTable)
        await connection.release()
    }

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        try {
            let rows = await db.query(query, [hash]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up hash record id in index_transactions table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        
        return id;
    }

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hashes and return hardcoded record id
        if(hash==null||hash=='')
            return 1;
        var id = await this.getTransactionId(hash);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same hash between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id — so two callers can never create duplicate rows.
            let query = "INSERT IGNORE INTO index_transactions (`hash`) values (?)"
            try {
                await db.query(query, [hash]);
            } catch (err) {
                console.error('Error trying to create hash record in index_transactions table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getTransactionId(hash);
        }
        return id;
    }

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up address record id in index_addresses table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return id;
    }

    // Create records in the 'index_addresses' table and return record id
    async createAddress(address){
        // Ignore empty address and return hardcoded record id
        if(address==null||address=='')
            return 1;
        var id = await this.getAddressId(address);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: if a
            // concurrent caller inserted the same address between our lookup and here,
            // the IGNORE skips the duplicate and the refetch below resolves to the
            // canonical row id — so two callers can never create duplicate rows.
            let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)"
            try {
                await db.query(query, [address]);
            } catch (err) {
                console.error('Error trying to create address record in index_addresses table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
            id = await this.getAddressId(address);
        }
        return id;
    }
    
    async hasPubkey(addressId){
        let db = await this.getConnection()
        try {
            let rows = await db.query("SELECT 1 FROM pubkeys WHERE address_id=? LIMIT 1", [addressId])
            return rows.length > 0
        } catch (err) {
            console.error('Error checking pubkey existence:', err)
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    }

    async insertPubkey(addressId, pubkey){
        let db = await this.getConnection()
        try {
            await db.query("INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)", [addressId, pubkey])
            return true
        } catch (err) {
            console.error('Error inserting pubkey:', err)
            return false
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
    }

    async insertEvent(code, data){
        const query = `
            INSERT INTO events (
            time,
            code,
            data
        ) VALUES (?, ?, ?);
        `;
        
        let connection = await this.getConnection()
        
        try {
            let timeString = new Date().toISOString().slice(0, 19).replace('T', ' ');
            let dataString = JSON.stringify(data)
        
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
                console.error('Error inserting event:', err);
                if (this.transactionConnection){
                    await this.releaseConnection()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }
    }

    async deleteAndCompareTxsNotInList(txidList) {
        let deletedTxHashIds = []
        let db = await this.getConnection();

        const query = `
            SELECT
                it.hash AS hash,
                mpt.tx_hash_id AS hash_id
                FROM mempool_transactions mpt
                LEFT JOIN index_transactions it ON it.id = mpt.tx_hash_id;
        `;

        try {
            let rows = await db.query(query);

            for (let nextRowIndex in rows) {
                let nextRow = rows[nextRowIndex]

                const txid = nextRow["hash"]
                const txHashId = nextRow["hash_id"]
                const txidIndex = bs(txidList, txid, function (element, needle) { return needle.localeCompare(element) })

                if (txidIndex < 0) {
                    deletedTxHashIds.push(txHashId)
                } else {
                    txidList.splice(txidIndex, 1)
                }
            }

            if (deletedTxHashIds.length > 0) {
                let placeholders = deletedTxHashIds.map(() => '?').join(',')
                let deleteQuery = `DELETE FROM mempool_transactions WHERE tx_hash_id IN (${placeholders})`
                await db.query(deleteQuery, deletedTxHashIds);
            }

            return { transactionsDeleted: deletedTxHashIds.length}
        } catch (err) {
            console.error('Error querying mempool_transactions:', err);
            return { transactionsDeleted: 0 }
        } finally {
            if (this.transactionConnection == null) {
                await db.release()
            }
        }
    }
    
    async insertDispenser(openDispenser) {
        const query = `
            INSERT INTO dispensers (
            tx_index,
            address_id,
            expiration
        ) VALUES (?, ?, FROM_UNIXTIME(?));
        `;
        
        let connection = await this.getConnection()
        
        try {
            let txIndex = openDispenser.txIndex
            let addressId = await this.createAddress(openDispenser.address)
            let expiration = openDispenser.expiration
            
            await connection.query(query, [
                txIndex,
                addressId,
                expiration
            ])
            
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting transaction:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }   
    }
    
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
                console.error('Error inserting dispense output:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }   
    }
    
    async isThereADispenserForAddress(address){
        let db    = await this.getConnection();
        let query = 
            `SELECT COUNT(*) AS dispensers_count
            FROM dispensers op 
            LEFT JOIN index_addresses ia ON ia.id = op.address_id
            WHERE ia.address = ?`
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                return rows[0]["dispensers_count"] > 0
        } catch (err) {
            console.error('Error looking up address record id in index_addresses table:', err);
        } finally {
            if (this.transactionConnection == null){
                await db.release()
            }
        }
        return false;
    }
    
    async deleteOpenDispensers(minExpiration) {
        const query = `
            DELETE FROM dispensers 
            WHERE expiration < FROM_UNIXTIME(?);
        `;
        
        let connection = await this.getConnection()
        
        try {
            await connection.query(query, [
                minExpiration
            ])
            
            return true
        } catch (err) {
            if (err.errno == 1062){
                return this.DUPLICATED_TRANSACTION
            } else {
                console.error('Error inserting transaction:', err);
                if (this.transactionConnection){
                    await this.endTransaction()
                }
                return false;
            }
        } finally {
            if (this.transactionConnection == null){
                await connection.release()
            }
        }   
    }
}

module.exports = Database