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
 ********************************************************************/

const BitcoinCore = require('bitcoin-core');
const axios = require('axios');
const crypto = require('crypto');

const rpcUser = 'rpc';
const rpcPassword = 'rpc';
const url = 'http://localhost:8333';		

module.exports = {
	async getWalletConnection(walletName){
		let connectionParams = {
		   network: 'regtest',
		   username: 'rpc',
		   password: 'rpc',
		   port: 8333
		}
		
		let connection = new BitcoinCore(connectionParams)
		
		let walletList = await connection.listWallets()
		
		if (!(walletName in walletList)){
			console.log("Creating wallet "+walletName)
			await connection.createWallet(walletName)
			connectionParams["wallet"] = walletName
			connection = new BitcoinCore(connectionParams)
		}
		
		return connection
	},
	
	async broadcastTx(txHex){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'sendrawtransaction',
				params: [txHex],
				id: 1
			}

			// Realizar la solicitud JSON-RPC al nodo
			const response = await axios.post(url, data, {
				auth: {
					username: rpcUser,
					password: rpcPassword,
				},
			})

			// Verificar si la solicitud fue exitosa y devolver el hex de la transacción
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error al enviar la transacción');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
		
		
	},
	
	async getTransaction(txid, hexFormat=true) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getrawtransaction',
				params: [txid, !hexFormat],
				id: 1,
			}

			// Realizar la solicitud JSON-RPC al nodo
			const response = await axios.post(url, data, {
				auth: {
					username: rpcUser,
					password: rpcPassword,
				},
			})

			// Verificar si la solicitud fue exitosa y devolver el hex de la transacción
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error al obtener la transacción');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	},
	
	async removeObfuscation(data, txid){
		var cipherKey = txid.substr(0,16)
		var iv = txid.substr(16,16)
		
		var decipher = crypto.createDecipheriv('aes-128-cbc', cipherKey, iv);
		var decryptedData = decipher.update(data) // + decipher.final()
		decryptedData = Buffer.concat([decryptedData, decipher.final()])
		return decryptedData
	},
	
	async obfuscate(data, key){
		var cipherKey = key.substr(0,16)
		var iv = key.substr(16,16)
		
		var cipher = crypto.createCipheriv('aes-128-cbc', cipherKey, iv);
		var encryptedData = cipher.update(data)
		encryptedData = Buffer.concat([encryptedData,cipher.final()])
		return encryptedData
	}
}

