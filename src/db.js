//const Database = require('./db.js')

const mariadb = require('mariadb');

class Database {
	constructor(url, port, dbName, user, password) {
		this.url = url
		this.port = port
		this.dbName = dbName
		this.user = user
		this.password = password
		
		const DUPLICATED_TRANSACTION = 1
		
		let connectionParams = {
			host: url,
			user: user,
			password: password,
			database: dbName,
			connectionLimit: 10,
			connectTimeout: 0,
			port: port
		}
		
		this.pool = mariadb.createPool(connectionParams)	 
		this.transactionConnection = null
	}
	
	async sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	
	async createDatabase(){
		let connectionParams = {
			host: this.url,
			user: this.user,
			password: this.password,
			port: this.port
		}
		
		console.log("Creating database!")
		let connection = null
		let result = null
		let databaseCreated = false
		
		while (!databaseCreated){
			try {
				connection = await mariadb.createConnection(connectionParams)
				result = await connection.query(
					"CREATE DATABASE IF NOT EXISTS "+this.dbName
				)
				databaseCreated = true
			} catch(err){
				console.log("There was an error trying to connect to the database. Trying again in a few seconds...")
				await sleep(10000) //Waiting ten seconds
			}
		}
		
		await connection.end()
		await this.createTables()
		return true
	}
	
	async verifyDatabaseExists(){
		let connectionParams = {
			host: this.url,
			user: this.user,
			password: this.password,
			port: this.port
		}
		
		while (true){
			try{
				let connection = await mariadb.createConnection(connectionParams)
				
				let result = await connection.query(
					"SELECT * FROM information_schema.tables"
					+" WHERE table_schema = ? AND table_name = ?"
					, [this.dbName, 'Block']
				)
				await connection.end()
				
				if (result.length > 0){
					return true
				}
				
				return false
			} catch (e) {
				console.log(e)
				console.log("There were problems when trying to check if the database exists. Trying again...")
				await this.sleep(5000)
			}
		}
	}
	
	async createTables() {
		const blockTable = `
		CREATE TABLE IF NOT EXISTS Block (
			block_index INT UNIQUE,
			block_hash VARCHAR(64) UNIQUE,
			block_time INTEGER,
			previous_block_hash VARCHAR(64) UNIQUE,
			PRIMARY KEY (block_hash)
		) ENGINE=InnoDB`;
		
		const transactionTable = `
		CREATE TABLE IF NOT EXISTS Transaction (
			tx_index INTEGER UNIQUE,
			tx_hash VARCHAR(64) UNIQUE,
			block_index INTEGER NOT NULL,
			source VARCHAR(64),
			destination VARCHAR(64),
			amount INTEGER,
			fee INTEGER,
			data BLOB,
			FOREIGN KEY (block_index) REFERENCES Block(block_index),
			PRIMARY KEY (tx_hash)
		) ENGINE=InnoDB`;
		
		const blockIndexIndex = `
		CREATE INDEX IF NOT EXISTS block_block_index_index ON Block (block_index)`;
		
		const transactionIndexIndex = `
		CREATE INDEX IF NOT EXISTS transaction_tx_index_index ON Transaction (tx_index)`;
		
		let connection = await this.getConnection()
		try{
			await connection.query(blockTable)
			await connection.query(transactionTable)
			await connection.query(blockIndexIndex)
			await connection.query(transactionIndexIndex)
			
			await connection.release()
		} catch(err){
			console.log("Error trying to create the tables")
			console.log(err)
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
	
	async getConnection() {
		if (this.transactionConnection){
			return this.transactionConnection
		}
		
		var connection = null
		
		while (connection == null){		
			try {
				connection = await this.pool.getConnection()
				//console.log("Connected to database!")
			} catch (e){
				console.log(e)
				console.log("Can't connect to mariadb. Trying again...")
				connection = null
				await this.sleep(1000)
			}
		}
		return connection
	}
	
	async getLastBlock(){
		const query = `
			SELECT MAX(block_index) AS max_height FROM Block ;
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
		INSERT INTO Block (
        block_index,
		block_hash,
        block_time,
        previous_block_hash
		) VALUES (?, ?, ?, ?);
		`;
		
		
		let connection = await this.getConnection()
		
		try {
			await connection.query(query, [
				block.block_index,
				block.block_hash,
				block.block_time,
				block.previous_block_hash
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
			SELECT * FROM Transaction WHERE tx_hash = ?;
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
			INSERT INTO Transaction (
			tx_index,
			tx_hash,
			block_index,
			source,
			destination,
			amount,
			fee,
			data
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
		`;
		
		let connection = await this.getConnection()
		
		try {
			await connection.query(query, [
				tx.index,
				tx.hash,
				tx.block_index,
				tx.source,
				tx.destination,
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
		
		const dropBlockTable = "DROP TABLE IF EXISTS Block"
		const dropTransactionTable = "DROP TABLE IF EXISTS Transaction"
		
		let connection = await this.getConnection()
		
		await connection.query(dropTransactionTable)
		await connection.query(dropBlockTable)
		await connection.release()
	}
}

module.exports = Database