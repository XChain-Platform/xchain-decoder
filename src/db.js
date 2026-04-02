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

class Database {
    constructor(host, port, dbName, user, pass){
        this.sqlPath  = __dirname+'/sql';
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        const DUPLICATED_TRANSACTION = 1
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
                // console.log('e=',e);
                console.log("There was an error trying to check if the " + this.dbName + " database exists. Trying again in a few seconds...");
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
                let result = await db.query("CREATE DATABASE IF NOT EXISTS " + this.dbName);
                await db.end();
                databaseCreated = true;
            } catch(e){
                console.log('e=',e);
                console.log("There was an error trying to connect to the " + this.dbName + " database. Trying again in a few seconds...");
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
        // Loop through SQL files
        for (file of files){
            var isSql = file.indexOf('.sql');
            if(isSql){
                let table   = file.substring(0, file.indexOf('.sql'));
                console.log('Verifying ' + table + ' table exists...');
                try {
                    let result = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",[this.dbName, table]);
                    if(result.length > 0){
                        continue;
                    } else {
                        await this.createTable(file);
                    }
                } catch(e){
                    console.log('e=',e);
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
                // console.log('e=',e);
                util.throwError('Error while trying to create ' + table + ' table!');
            }
        }
        // Dont release connection after each table is created, connection released in verifyTables() after ALL tables created and verified
        // await this.releaseConnection();
    }

    // Handle getting a database Connection    
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection = null;
        while(connection == null){        
            try {
                connection = await this.pool.getConnection();
                // console.log("Connected to database!");
            } catch (e){
                console.log("Can't connect to mariadb. Trying again...");
                connection = null;
                await util.sleep(1000);
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

    async beginTransaction(){
        if (this.transactionConnection != null){
            await this.endTransaction()
        }
        
        this.transactionConnection = await this.getConnection()
        try {
            await this.transactionConnection.beginTransaction()
        } catch(err){
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
    }
    
    async commitTransaction(){
        if (this.transactionConnection != null){
            try {
                await this.transactionConnection.commit()
                await this.transactionConnection.release()
                this.transactionConnection = null
                return true
            } catch (e){
                console.log(e)
                console.log("There was an error trying to commit a transaction")
                await this.endTransaction()
            }
        }
        
        return false      
    }
    
    bigIntSatoshiToDecimalsString(bigIntValue) {
        const strBigInt = bigIntValue.toString();
        const bigIntLength = strBigInt.length;

        if (bigIntLength <= SATOSHIS_DECIMALS) {
            let missingZeros = SATOSHIS_DECIMALS - bigIntLength;
            let decimalPart = '0'.repeat(missingZeros) + strBigInt;
            return `0.${decimalPart}`;
        }

        const decimalSeparatorIndex = bigIntLength - SATOSHIS_DECIMALS;
        const integerPart = strBigInt.slice(0, decimalSeparatorIndex);
        const decimalPart = strBigInt.slice(decimalSeparatorIndex);

        return `${integerPart}.${decimalPart}`;
    }
    
    async deleteBlockByIndex(blockIndex){
        await this.beginTransaction()
        let connection = await this.getConnection()
        
        let query = `
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
            data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
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
                tx.data
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
            let query = "INSERT INTO index_transactions (`hash`) values (?)"
            try {
                let result = await db.query(query, [hash]);
                if(result.insertId)
                    id = result.insertId;
            } catch (err) {
                console.error('Error trying to create hash record in index_transactions table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
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
            let query = "INSERT INTO index_addresses (`address`) values (?)"
            try {
                let result = await db.query(query, [address]);
                if(result.insertId)
                    id = result.insertId;
            } catch (err) {
                console.error('Error trying to create address record in index_addresses table:', err);
            } finally {
                if (this.transactionConnection == null){
                    await db.release()
                }
            }
        }
        return id;
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
                let deleteQuery = `
                    DELETE FROM mempool_transactions WHERE tx_hash_id IN (`+ deletedTxHashIds.join(",") + `);
                `
                await db.query(deleteQuery);
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