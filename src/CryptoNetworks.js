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