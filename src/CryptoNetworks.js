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
 * XChain Decoder - Crypto Networks Class
 * 
 * This file handles getting a bitcoinJS config for a specific network
 * 
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');

class CryptoNetworks {
	static getBitcoinJsNetwork(networkName){
		switch(networkName){
			case "bitcoin-mainnet":
				return bitcoin.networks.bitcoin
			case "bitcoin-testnet":
				return bitcoin.networks.testnet			
			case "bitcoin-regtest":
				return bitcoin.networks.regtest
		}
	}
	
	static getFirstBlock(networkName){
		//TODO: this should get a config file from a server
		switch(networkName){
			case "bitcoin-mainnet":
				return 844000
			case "bitcoin-testnet":
				return 2816000
			case "bitcoin-regtest":
				return 0
		}
		
		return 0
	}
}

module.exports = CryptoNetworks