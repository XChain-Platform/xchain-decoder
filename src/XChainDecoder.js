const util = require('./util')
const BitcoinCore = require('bitcoin-core');
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto');
const Database = require('./db.js')
const ecc = require('tiny-secp256k1')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const bs = require("binary-search")

//We need to init the ecc to parse taproot addresses from output scripts
bitcoin.initEccLib(ecc);

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const MEMPOOL_INTERVAL = 60000 //1 second between mempool checks
const MEMPOOL_BATCH_SIZE = 1000

const MAGIC_WORD = "XCHN"
const MAGIC_WORD_BUFFER = Buffer.from(MAGIC_WORD)
const P2SH_BUFFER = Buffer.from("p2sh")
const P2WSH_BUFFER = Buffer.from("p2wsh")

const SYNCED_THRESHOLD = 3 //Maximum blocks behind to be synced

const DB_TRANSACTION_BLOCKS_QUANTITY = 1 //How many transactions need to be processed before inserting the data into the database

class XChainDecoder {
	constructor(network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, auxPow) {
		this.network = CryptoNetworks.getBitcoinJsNetwork(network)
	  
		this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
		this.dbUrl = dbUrl
		this.dbPort = dbPort
		this.dbName = dbName
		this.dbUser = dbUser
		this.dbPassword = dbPassword
		this.startBlockIndex = CryptoNetworks.getFirstBlock(network)
	  
		this.db = null
		this.mempoolDb = null
		this.fm = null
	  
		this.debugTime = {}
	  
		this.synced = false
	  
		this.blockchainInfoLastBlock = -1
		this.mempoolInterval = null
		this.mempoolBusy = false

		this.stopFlag = false

		this.auxPow = auxPow
    }
	
	async sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	
	markTime(timeName){
		this.debugTime[timeName] = Date.now()
	}
	
	logTime(timeName){
		let endTime = Date.now()
		let msTime = (endTime - this.debugTime[timeName])
					
		console.log("Time('"+timeName+"'): "+(msTime)+"ms")
	}
	
	millisecondsToTimeString(ms){
		var milliseconds = Math.floor((ms % 1000) / 100),
		seconds = Math.floor((ms / 1000) % 60),
		minutes = Math.floor((ms / (1000 * 60)) % 60),
		hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
		days = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);

		hours = (hours < 10) ? "0" + hours : hours;
		minutes = (minutes < 10) ? "0" + minutes : minutes;
		seconds = (seconds < 10) ? "0" + seconds : seconds;

		return days+"d"+ hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
	}
	
	isSynced(){
		return this.synced
	}
	
	stop(){
		this.stopFlag = true
	}
	
	//This function is used to decipher the data inside xchain transaction
	async removeObfuscation(data, txid){
		var decryptedData = null
		
		if (Buffer.isBuffer(data)){
		
			try {
				var cipherKey = txid.substr(0,16)
				var iv = txid.substr(16,16)
				
				var decipher = crypto.createDecipheriv('aes-128-cbc', cipherKey, iv);
				decryptedData = decipher.update(data) // + decipher.final()
				decryptedData = Buffer.concat([decryptedData, decipher.final()])
			} catch (err){
				if ((err.code != "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH") && (err.code != "ERR_OSSL_BAD_DECRYPT")){
					throw err
				}
				decryptedData = null
			}
		}
		return decryptedData
	}
	
	async parseRawTransaction(rawTransaction){
		return await this.parseTransaction(bitcoin.Transaction.fromHex(rawTransaction))
	}
	
	//Gets the address from the output specified by the transaction hash id and the output index
	async getSourceFromOutput(txId, outputIndex){
		let source = null
		let output = null
		
		try {
			//Obtaining the output
			let outputRawTransaction = await this.connector.getRawTransaction(txId)
			let outputTransaction = bitcoin.Transaction.fromHex(outputRawTransaction)
			output = outputTransaction.outs[outputIndex]
		} catch (err){
			//Do nothing, the source will be null
		}
		
		if (output != null){
			try {
				source = bitcoin.address.fromOutputScript(output.script, this.network)
			} catch(err){
				//Ignoring specific sources
				/*let decompiledScript = bitcoin.script.decompile(output.script)
				if ( //P2PK
					(decompiledScript.length == 2)
					&&(Buffer.isBuffer(decompiledScript[0]))
					&& (decompiledScript[0].length == 33)
					&& (decompiledScript[1] == bitcoin.opcodes.OP_CHECKSIG)
				){
					//Do nothing, null will be returned
				} else if ( //MULTISIG
					(decompiledScript.length > 0)
					&& (decompiledScript[decompiledScript.length - 1] == bitcoin.opcodes.OP_CHECKMULTISIG)
				){
					//Do nothing, null will be returned
				} else {
					throw err
				}*/
				
				//Bitcoinjs-lib didn't find a valid address, ignore it, null will be returned
			}
		}
		
		return source
	}
	
	async parseTransaction(transaction){
		let nextTxId = transaction.getId()
		let firstInputTxId = util.uint8ArrayToHex(transaction.ins[0].hash.reverse())
		
		//Ignore coin base transactions
		if (firstInputTxId != "0000000000000000000000000000000000000000000000000000000000000000"){
			let source = null
			let dataBuffer = Buffer.allocUnsafe(0)
			
			for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
				let nextOutput = transaction.outs[txOutputIndex]
				let decompiledScript = bitcoin.script.decompile(nextOutput.script)
				let nextDataBuffer = new Buffer.allocUnsafe(0)
				
				if ((decompiledScript != null) && (decompiledScript.length > 0)){
					/*
					* OP_RETURN
					*
					*/
					
					if (
						(decompiledScript.length == 2)
						&& (decompiledScript[0] == bitcoin.opcodes.OP_RETURN)
					){
						if (source != null){
							source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
						}	
						let dataWithoutObfuscation = await this.removeObfuscation(decompiledScript[1], firstInputTxId)
						//let dataWithoutObfuscation = null
						
						if (dataWithoutObfuscation != null){
							if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
								/*
								* P2SH
								*
								*/
								if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2SH_BUFFER)){
									for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
										let nextInput = transaction.ins[txInputIndex]
										
										let decodedScriptSig = bitcoin.script.decompile(nextInput["script"])
										let decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
										let decodedData = Buffer.from(decodedRedeemScript[0],"hex")
										nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
									}
									
								/*
								* P2WSH
								*
								*/	
								} else if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2WSH_BUFFER)){
									for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
										let nextInput = transaction.ins[txInputIndex]
										
										let decodedRedeemScript = bitcoin.script.decompile(nextInput["witness"][2])
										let decodedData = Buffer.from(decodedRedeemScript[0],"hex")
										nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
									}
								} else {
									nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
								}
							}
						}
						
					} else 
					/*
					* MULTISIGN
					*
					*/				
					
					if (
						(decompiledScript.length == 6)
						&& (decompiledScript[5] == bitcoin.opcodes.OP_CHECKMULTISIG)
					){
						if (source != null){
							source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
						}
						
						let pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
						let pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning
						//let pubkey3 = decompiledScript[3] //actual pubkey
						
						let data = Buffer.concat([pubkey1, pubkey2])

						//Removing ending 00's
						for (let i=data.length - 1;i>=0;i--){
							if (data[i] !== 0){
								data = data.slice(0, i + 1)
								break
							}
						}
						
						let dataWithoutObfuscation = await this.removeObfuscation(data, firstInputTxId)					
						
						if (dataWithoutObfuscation != null){
							if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
								nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
							}
						}
					} 
				}

				if (nextDataBuffer.length > 0){
					dataBuffer = Buffer.concat([dataBuffer,nextDataBuffer])
				}
			}
			
			if ((dataBuffer.length > 0) && (source == null)){
				//Get the source from the output spent by the first input of this transaction
				//only if there is data and the source was not retrieved before
				source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
			}
			
			return {data:dataBuffer, source:source, destination:null}
		} else {
			return null
		}
	}
	
	async verifyReorg(){
		let thereAreDifferences = true
		let blocksDeleted = []
	
		while (thereAreDifferences){
			let lastBlockIndex = await this.db.getLastBlockIndex()
			let lastBlock = await this.db.getBlockByIndex(lastBlockIndex)
			let blockHashFromNode
			try {
				blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
			} catch (err){
				console.log("There was a problem trying to get a block hash from the node. Trying again...")
				await this.sleep(3000)
				continue
			}
			
			if (lastBlock["block_hash"] != blockHashFromNode){
				try {
					await this.db.deleteBlockByIndex(lastBlockIndex)
					
					blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["hash"]})
				} catch (err){
					console.log(err)
					console.log("There was a problem trying to delete a block while verifying a reorg")
				}
			} else {
				thereAreDifferences = false
			}
		}
		
		if (blocksDeleted.length > 0){
			await this.db.insertEvent("REORG", blocksDeleted)
		}
		
		return true
	}
	
	async start(){
		this.db = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
		

        // Verify the Decoder database exists
        let dbStatus   = await this.db.createDatabase();
        let dbVerified = await this.db.verifyDatabase();
        if(!dbVerified){
            util.throwError("Database " + this.dbName + " doesn't exist!");
        } else {
            // Verify the Indexer tables exists
            let tablesVerified = await this.db.verifyTables();
            if(!tablesVerified)
                util.throwError("Database " + this.dbName + " tables don't exist!");
        }
	
		console.log("Connected to database!")
		console.log("Parsing...")
		
		let lastProcessedBlockIndex = await this.db.getLastBlockIndex()
		let lastProcessedTxIndex = await this.db.getLastTxIndex()
		
		if (lastProcessedBlockIndex < this.startBlockIndex - 1){
			lastProcessedBlockIndex = this.startBlockIndex - 1
		}
		
		let lastBlockchainInfo = null
		this.blockchainInfoLastBlock = -1
	    let blocksQuantity = 0
		
		let startTimeStamp = Date.now()
		
		let blocksCount = 0
		let transactionsCount = 0
		let validTransactionsCount = 0
		let outputCount = 0
		
		main_parsing:
		while (true){
			if (this.stopFlag){
				if (this.mempoolInterval != null){
					console.log("Mempool updates stopped!")
					clearInterval(this.mempoolInterval)
					this.mempoolInterval = null
				}	
				break
			}
			
			//Getting network info to retrieve the last block index
			if (!lastBlockchainInfo || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)){
				try {
					lastBlockchainInfo = await this.connector.getBlockchainInfo()
					
					this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
				} catch (e){
					console.log(e)
					console.log("Error trying to get network info from the node. Trying again...")
					await this.sleep(3000)
					continue
				}
				
				if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
					if (lastProcessedBlockIndex == this.startBlockIndex - 1){
						console.log("Last block from the node ("+this.blockchainInfoLastBlock+") is still behind the starting block ("+this.startBlockIndex+")")	
					} else {
						console.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+")")
					}
					await this.sleep(5000)
					continue
				}
			}
			
			//If there is no new block, wait for some seconds to ask again
			if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
				this.synced = true
				if (this.mempoolInterval == null){
					console.log("Mempool parsing started!")
					this.updateMempool()
					this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
				}
				
				await this.sleep(CHECK_BLOCK_DELAY_MS)
			} else { //If there is a new block, parse it
				//Put the flag synced false if there are too many blocks behind
				if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
					this.synced = false
					if (this.mempoolInterval != null){
						console.log("Mempool updates stopped!")
						clearInterval(this.mempoolInterval)
						this.mempoolInterval = null
					}	
				}
				
				//Getting the raw block
				let nextBlockHeight = lastProcessedBlockIndex + 1
			
				let nextBlockHash = null
				let nextBlockHex = null				
				try {
					nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)

					if (this.auxPow) {
						nextBlockHex = await this.connector.getBlockWithoutAuxPow(nextBlockHash)
					} else {
						nextBlockHex = await this.connector.getBlock(nextBlockHash)
                    }
				} catch (e){
					console.log("Error trying to get next block from the node. Trying again...")
					await this.sleep(3000)
					continue
				}
				
				var block = bitcoin.Block.fromHex(Buffer.from(nextBlockHex,"hex"))
				let previousBlockHash = util.uint8ArrayToHex(block.prevHash.reverse())

				//verify if there is an reorg
				if (nextBlockHeight > this.startBlockIndex){
					let previousBlock = await this.db.getBlockByIndex(nextBlockHeight - 1)

					//previousBlockHash is not the same, it must be a reorg
					if (previousBlockHash != previousBlock.block_hash){
						await this.db.endTransaction()
						console.log("A reorg has been detected. Cleaning blocks...")
						await this.verifyReorg()
						lastProcessedBlockIndex = await this.db.getLastBlockIndex()
						lastProcessedTxIndex = await this.db.getLastTxIndex()
						blocksQuantity = 0
						transactionsCount = 0
						validTransactionsCount = 0
						outputCount = 0
						startTimeStamp = Date.now()
						console.log("Blocks were updated")
						continue
					}
				}



				//If there are no blocks pending then start the database transaction
				if (blocksQuantity == 0){
					await this.db.beginTransaction()
				}
				
				if (!(await this.db.insertBlock(
					{
						block_index:nextBlockHeight,
						block_hash:nextBlockHash, 
						block_time:block.timestamp, 
						previous_block_hash:util.uint8ArrayToHex(block.prevHash.reverse())
					}
				))){
					console.log("Error trying to insert a Block to the database")
					await this.sleep(3000)
					continue main_parsing
				}
				
				//Loop through the transactions and saving only the ones that have valid data
				var transactions = block.transactions
				blocksCount = blocksCount + 1

				for (let txIndex=0;txIndex < transactions.length;txIndex++){
					let nextTransaction = transactions[txIndex]
					let nextTransactionHash = nextTransaction.getId()
							
					let parseResult = await this.parseTransaction(nextTransaction)
					
					if (parseResult != null){
					
						if (parseResult["data"].length > 0){
							if (parseResult["source"] != null){
								lastProcessedTxIndex = lastProcessedTxIndex + 1
								validTransactionsCount = validTransactionsCount + 1
							
								if (!(await this.db.insertTransaction({
									index: lastProcessedTxIndex,
									hash: nextTransactionHash,
									block_index: nextBlockHeight,
									source: parseResult["source"],
									destination: parseResult["destination"],
									amount: parseResult["amount"],
									fee: 0,
									data: util.uint8ArrayToHex(parseResult["data"])
									
								}))){
									await this.sleep(3000)
									continue main_parsing
								}
							} else {
								throw new Error("Source missing in valid transaction!")
							}
						}
					}
					
					outputCount = outputCount + nextTransaction.outs.length
				}
				
				transactionsCount = transactionsCount + transactions.length
				
				//If the pendings blocks are enough, then commit the transaction and print statistics
				if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
					console.log("Parsing block "+(nextBlockHeight)+"("+nextBlockHash+") Txs ("+transactionsCount+") Outputs ("+outputCount+")")
					console.log("Inserting data Blocks ("+blocksCount+") Valid Transactions ("+validTransactionsCount+")")
					await this.db.commitTransaction()
					
					blocksCount = 0
					transactionsCount = 0
					validTransactionsCount = 0
					outputCount = 0
					
					let endTimeStamp = Date.now()
					
					let msPerBlock = ((endTimeStamp - startTimeStamp)/DB_TRANSACTION_BLOCKS_QUANTITY)
					startTimeStamp = Date.now()
					
					let msLeft = (this.blockchainInfoLastBlock - nextBlockHeight)*msPerBlock
					
					if (msLeft > 0){
						let msPerBlockFormatted = this.millisecondsToTimeString(msPerBlock)
						let msLeftFormatted = this.millisecondsToTimeString(msLeft)
						console.log("Last block time ("+msPerBlockFormatted+"). ETA: "+msLeftFormatted)
					}
					
					blocksQuantity = -1
				}
				
				blocksQuantity = blocksQuantity + 1
				lastProcessedBlockIndex = nextBlockHeight
			}
		}
	}
	
	async updateMempool(){
		if (!this.mempoolBusy) {
			let mempoolStartTime = Date.now()
			this.mempoolBusy = true
			let rawMempool = []
			try {
				let rawMempoolUnordered = await this.connector.getRawMempool()

				for (let nextUnorderedItemIndex in rawMempoolUnordered) {
					let nextUnorderedItem = rawMempoolUnordered[nextUnorderedItemIndex]

					let newIndex = bs(rawMempool, nextUnorderedItem, function (element, needle) { return needle.localeCompare(element) })

					if (newIndex < 0) {
						rawMempool.splice(-newIndex - 1, 0, nextUnorderedItem)
					}
				}



			} catch (error) {
				console.log(error)
				console.log("There were problems getting the mempool, trying again later.")
				this.mempoolBusy = false
				return
			}

			//let transactionsCount = 0
			let validTransactionsCount = 0
			
			//await this.mempoolDb.beginTransaction()
			//This deletes the txs that are in the database but not longer in the mempool. Also, it removes
			//the transactions that already exist in the database, leaving rawMempool only with the new transactions from the mempool
			let deletedInfo = await this.db.deleteAndCompareTxsNotInList(rawMempool)

			let deletedTransactionsCount = deletedInfo.transactionsDeleted
			
			let i = 0
			while (i < rawMempool.length) {
				let nextRawMempoolChunk = rawMempool.slice(i, i + MEMPOOL_BATCH_SIZE)

				let nextTxsHex = []
				try {
					nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)

				} catch (err) {
					console.log(err)
					console.log("There was an error trying to get raw transactions from the mempool. Trying again...")
					await this.sleep(1000)
					continue
				}

				//for (let nextTxHexIndex in nextTxsHex) {
				let nextTxHexIndex = 0
				while (nextTxHexIndex < nextTxsHex.length) { 
					let nextTxHex = nextTxsHex[nextTxHexIndex]

					if (nextTxHex != null) {
						let nextTx = bitcoin.Transaction.fromHex(Buffer.from(nextTxHex, "hex"))
						let nextTransactionHash = nextTx.getId()

						let parseResult = await this.parseTransaction(nextTx)

						if (!(await this.db.insertMempoolTransaction({
							hash: nextTransactionHash,
							source: parseResult["source"],
							destination: parseResult["destination"],
							amount: parseResult["amount"],
							fee: 0,
						data: (parseResult["data"] != null ? util.uint8ArrayToHex(parseResult["data"]) : null)

						}))) {
							await this.sleep(3000)
							continue
						} else {
							if ((parseResult["data"] != null) && (parseResult["data"].length > 0)) {
								validTransactionsCount = validTransactionsCount + 1
							}
						}

						//transactionsCount = transactionsCount + 1
						nextTxHexIndex = nextTxHexIndex + 1
					}
				}

				i = i + MEMPOOL_BATCH_SIZE
				//await this.sleep(10000)
			}

			//await this.mempoolDb.endTransaction()
			this.mempoolBusy = false
			let mempoolEndTime = Date.now()
			let timeString = this.millisecondsToTimeString(mempoolEndTime - mempoolStartTime)

			console.log("Mempool updated!"
				+ " Transactions (" + rawMempool.length + " in mempool, " + validTransactionsCount + " valid, " + deletedTransactionsCount + " less) [" + timeString + "]")
		} else {
			console.log("Mempool is still busy")
		}
	}
	
}

module.exports = XChainDecoder