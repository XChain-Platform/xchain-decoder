//const Database = require('./db.js')

const mariadb = require('mariadb');
const fs      = require('fs');
const util    = require('./util')

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
        this.transactionConnection = connection;
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
				this.transactionConnection.release()
				this.transactionConnection = null
				return true
			} catch (e){
				console.log(e)
				console.log("There was an error trying to commit a transaction")
				this.transactionConnection = null //the transaction is not valid anymore
			}
		}
		
		return false	  
	}
	
	async getLastBlock(){
		const query = `
			SELECT MAX(block_index) AS max_height FROM blocks ;
		`;
		
		let connection = await this.getConnection()
		
		try {
			const rows = await connection.query(query)
			await connection.release()
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
			await connection.release()
			if (rows.length > 0){
				return rows[0]
			} else {
				return null
			}
		} catch (err) {
			console.error('Error selecting a transaction from the db:', err);
			return false;
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
		}	
	}
	
	//This is only used in tests
	async dropDatabase(){
		console.log("Droping database")
		
		const dropBlockTable = "DROP TABLE IF EXISTS blocks"
		const dropTransactionTable = "DROP TABLE IF EXISTS transactions"
		const dropIndexAddressesTable = "DROP TABLE IF EXISTS index_addresses"
		const dropIndexTransactionsTable = "DROP TABLE IF EXISTS index_transactions"
		
		let connection = await this.getConnection()
		
		await connection.query(dropTransactionTable)
		await connection.query(dropBlockTable)
		await connection.query(dropIndexAddressesTable)
		await connection.query(dropIndexTransactionsTable)
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
        }
        await this.releaseConnection();
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
            }
            await this.releaseConnection();
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
        }
        await this.releaseConnection();
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
            }
            await this.releaseConnection();
        }
        return id;
    }

}

module.exports = Database