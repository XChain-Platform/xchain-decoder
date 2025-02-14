const util = require('./util')
const axios = require('axios');
axios.defaults.timeout = 5000


class BlockchainConnector {
	constructor(url, port, rpcUser, rpcPassword) {
		this.url = "http://"+url+":"+port
		this.rpcUser = rpcUser
		this.rpcPassword = rpcPassword
	}

	async getNetworkInfo(){
		const data = {
			jsonrpc: '2.0',
			method: 'getnetworkinfo',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data, {
			auth: {
				username: this.rpcUser,
				password: this.rpcPassword,
			}
		})

		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting network info');
		}
	}
	
	async getBlockchainInfo(){
		const data = {
			jsonrpc: '2.0',
			method: 'getblockchaininfo',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data, {
			auth: {
				username: this.rpcUser,
				password: this.rpcPassword,
			}
		})
		
		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting blockchain info');
		}
	}

	async getBlockHash(blockindex) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getblockhash',
				params: [blockindex],
				id: 1,
			}

			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting block hash');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	}

	async getBlock(blockhash, hexFormat=true) {
		let tries = 10
		
		
		while (tries > 0){
			try {
				const data = {
					jsonrpc: '2.0',
					method: 'getblock',
					params: [blockhash, (hexFormat?0:1)],
					id: 1,
				}

				// Make the request to the node
				const response = await axios.post(this.url, data, {
					auth: {
						username: this.rpcUser,
						password: this.rpcPassword,
					}
				})

				// Verify if there is a result and return it
				if (response.data.result) {
					return response.data.result;
				} else {
					throw new Error('Error getting block hex');
				}
			} catch (error) {
				if (error.code === 'ECONNABORTED'){
					tries = tries - 1
					console.log("Getting timeout trying to get block hex, trying again...")
					//Do nothing, let the while to try again
				} else {
					console.error('Error:', error);
					throw error;
				}
			}
		}
		
		throw new Error("There were problems getting a block hex. ")
	}
	
	async getRawMempool(){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getrawmempool',
				id: 1
			}
			
			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting raw mempool info');
			}
		} catch (error){
			console.error('Error:', error.message);
			throw error;
		}
	}
	
	async getMempoolEntry(txid){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getmempoolentry',
				params: [txid],
				id: 1
			}
			
			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting mempool entry');
			}
		} catch (error){
			console.error('Error:', error.message);
			throw error;
		}
	}
	
	async getRawTransaction(txid) {
		return new Promise(async (resolve, reject) => {
			let maxTries = 10
			let tries = 0
			while (tries < maxTries) {
				tries++
				try {
					const data = {
						jsonrpc: '2.0',
						method: 'getrawtransaction',
						params: [txid],
						id: 1
					}

					// Make the request to the node
					const response = await axios.post(this.url, data, {
						auth: {
							username: this.rpcUser,
							password: this.rpcPassword,
						}
					})

					// Verify if there is a result and return it
					if (response.data.result) {
						resolve(response.data.result);
						break
					} else {
						console.log(response.error)
						reject('Error getting raw transaction');
						break
					}
				} catch (error) {
					await util.sleep(500)
				}
			}

			if (tries >= maxTries) {
				reject(null)
			}
		})
	}

	async getRawTransactions(txIdArray) {
		let requests = []

		for (let nextTxIdIndex in txIdArray) {
			let nextTxId = txIdArray[nextTxIdIndex]

			requests.push(this.getRawTransaction(nextTxId))
		}

		return Promise.all(requests)
	}
}

module.exports = BlockchainConnector