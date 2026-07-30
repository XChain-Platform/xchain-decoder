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
 ********************************************************************/

const BitcoinCore = require('bitcoin-core');
const axios = require('axios');
const crypto = require('crypto');

// Where the test node lives. Resolved per call rather than at require time so a
// fixture can point the whole test tree at its own throwaway node by setting
// these before the first call (the integration tier does exactly that with its
// containerised regtest node). The defaults are the historical host-node values,
// so the older host-based tests behave as they always did.
function nodeConfig(){
	return {
		host: process.env.XCHAIN_TEST_NODE_HOST || 'localhost',
		port: parseInt(process.env.XCHAIN_TEST_NODE_PORT || '8333', 10),
		user: process.env.XCHAIN_TEST_NODE_USER || 'rpc',
		pass: process.env.XCHAIN_TEST_NODE_PASS || 'rpc'
	}
}

function rpcUrl(){
	const cfg = nodeConfig()
	return 'http://' + cfg.host + ':' + cfg.port
}

module.exports = {
	// bitcoin-core v5 takes ONE `host` option and it is a full URL; it has no
	// `port` and no `network` option. The old params passed `port` and `network`,
	// which the client silently ignored, so every wallet call here went to the
	// default http://localhost:8332 rather than the port the caller asked for.
	async getWalletConnection(walletName){
		const cfg = nodeConfig()
		let connectionParams = {
		   host: rpcUrl(),
		   username: cfg.user,
		   password: cfg.pass
		}

		let connection = new BitcoinCore(connectionParams)

		let walletList = await connection.listWallets()

		// listWallets returns an array of loaded wallet names. The membership test
		// used to be `walletName in walletList`, which asks whether the string is an
		// ARRAY INDEX and is therefore always false: every call re-ran createWallet
		// and threw on the second run against a node that already had the wallet.
		if (!walletList.includes(walletName)){
			console.log("Creating wallet "+walletName)
			await connection.createWallet(walletName)
		}

		// Scope the returned client to the wallet in both branches. When the wallet
		// was already loaded the old code returned an unscoped client, and the
		// wallet RPCs the fixtures call next (getnewaddress, getbalance) then go to
		// the node's default wallet or fail outright.
		connectionParams["wallet"] = walletName
		return new BitcoinCore(connectionParams)
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
			const cfg = nodeConfig()
			const response = await axios.post(rpcUrl(), data, {
				auth: {
					username: cfg.user,
					password: cfg.pass,
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
			const cfg = nodeConfig()
			const response = await axios.post(rpcUrl(), data, {
				auth: {
					username: cfg.user,
					password: cfg.pass,
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

