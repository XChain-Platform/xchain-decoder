// XChainDecoder.test.js
const { BIP32Factory } = require('bip32')
const ecc = require('tiny-secp256k1')
const bip32 = BIP32Factory(ecc)
const bip39 = require('bip39')
const bitcoin = require('bitcoinjs-lib');
const assert = require('assert');
const XChainDecoder  = require('../src/XChainDecoder');
const nodeHelper = require('./nodeHelper')
const {ECPairFactory} = require('ecpair')

const MAGIC_WORD = "XCHN"
const magicWordBuffer = Buffer.from(MAGIC_WORD,'utf8')

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('XChainDecoder', () => {
	describe('#parsing', () => {
		it('should parse a OP_RETURN transaction from a Legacy source', async () => {
			var network = bitcoin.networks.regtest
		
			//var mnemonic = bip39.generateMnemonic()
			var mnemonic = 'erase average powder march guess lemon basic eight arena world once puzzle' //address should be mqhMKLhD68FAYyXjwdYD6P7AGASyYyEZkX
			console.log("The seed for the test is: " + mnemonic)

			var seed = bip39.mnemonicToSeedSync(mnemonic)
			var root = bip32.fromSeed(seed, network)
			var account = root.derivePath("m/44'/0'/0'/0")
			var address = account.derive(0).derive(0)
			var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
			console.log("address for the test: "+testAddress)

			let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
			let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
			let rawTx1Hex = await nodeClientTest.getRawTransaction(txId1)
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			
			//Create the tx
			let dataBuffer = Buffer.from("P2PKH to OP_RETURN", "utf-8")
			let data = Buffer.concat([magicWordBuffer, dataBuffer])
			
			let psbt = new bitcoin.Psbt({ network: network })
			let utxos = []
			let utxo1 = null
			let inputSatoshis = 0
			let fee = 10000
			for (let nextVoutIndex in rawTx1["vout"]){
				let nextVout = rawTx1["vout"][nextVoutIndex]
				
				if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
					psbt.addInput({
						hash: rawTx1["txid"],
						index: nextVout["n"],
						sequence: 0x00000001,
						nonWitnessUtxo: Buffer.from(rawTx1Hex, 'hex')
					})
					
					inputSatoshis = inputSatoshis + nextVout["value"]*100000000
				}
			}
			
			
			let obfuscatedData = await nodeHelper.obfuscate(data, txId1)
			let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })
					
			psbt.addOutput({
				script: opReturnScript.output,
				value: 0
			})
			//Change
			psbt.addOutput({
				address: testAddress,
				value: inputSatoshis - fee
			})
			
			//Sign the psbt
			var ECPair = ECPairFactory(ecc);

			let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

			for (let nextInputIndex in psbt.data.inputs){
				let proxInput = psbt.data.inputs[nextInputIndex]			  
				psbt.signInput(parseInt(nextInputIndex), keyToSign);
			}
			
			psbt.finalizeAllInputs();
			
			console.log("Sending the P2PKH/OP_RETURN transaction to the node")
			txHex = psbt.extractTransaction().toHex()
			
			console.log("txHex----------------------->")
			console.log(txHex)

			let txHash = await nodeHelper.broadcastTx(txHex)
			
			assert((txHash != null) && (txHash.length == 64))
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			let tx = null
			let tries = 3
			while ((tx == null) && (tries > 0)){
				tx = await db.getTransaction(txHash)
				
				if (tx == null){
					tries = tries - 1
					console.log("Couldn't get tx ("+txHash+"), trying again in a few seconds...")
					await sleep(1000)
				} else {
					console.log("Got tx ("+txHash+")!")
				}
			}
						
			assert(tx != null)
			assert(tx['source'] == testAddress)
		}),
		it('should parse a OP_RETURN transaction from a Segwit source', async () => {
			var network = bitcoin.networks.regtest
		
			//var mnemonic = bip39.generateMnemonic()
			var mnemonic = 'erase average powder march guess lemon basic eight arena world once puzzle' //address should be mqhMKLhD68FAYyXjwdYD6P7AGASyYyEZkX
			console.log("The seed for the test is: " + mnemonic)

			var seed = bip39.mnemonicToSeedSync(mnemonic)
			var root = bip32.fromSeed(seed, network)
			var account = root.derivePath("m/44'/0'/0'/0")
			var address = account.derive(0).derive(0)
			var testAddress = bitcoin.payments.p2wpkh({ pubkey: address.publicKey, network }).address
			console.log("address for the test: "+testAddress)

			let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
			let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
			let rawTx1Hex = await nodeClientTest.getRawTransaction(txId1)
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			
			//Create the tx
			let dataBuffer = Buffer.from("SEGWIT to OP_RETURN", "utf-8")
			let data = Buffer.concat([magicWordBuffer, dataBuffer])
			
			let psbt = new bitcoin.Psbt({ network: network })
			let utxos = []
			let utxo1 = null
			let inputSatoshis = 0
			let fee = 10000
			for (let nextVoutIndex in rawTx1["vout"]){
				let nextVout = rawTx1["vout"][nextVoutIndex]
				
				if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
					psbt.addInput({
						hash: rawTx1["txid"],
						index: nextVout["n"],
						sequence: 0x00000001,
						nonWitnessUtxo: Buffer.from(rawTx1Hex, 'hex')
					})
					
					inputSatoshis = inputSatoshis + nextVout["value"]*100000000
				}
			}
			
			
			let obfuscatedData = await nodeHelper.obfuscate(data, txId1)
			let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })
					
			psbt.addOutput({
				script: opReturnScript.output,
				value: 0
			})
			//Change
			psbt.addOutput({
				address: testAddress,
				value: inputSatoshis - fee
			})
			
			//Sign the psbt
			var ECPair = ECPairFactory(ecc);

			let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

			for (let nextInputIndex in psbt.data.inputs){
				let proxInput = psbt.data.inputs[nextInputIndex]			  
				psbt.signInput(parseInt(nextInputIndex), keyToSign);
			}
			
			psbt.finalizeAllInputs();
			
			console.log("Sending the SEGWIT/OP_RETURN transaction to the node")
			txHex = psbt.extractTransaction().toHex()
			
			console.log("txHex----------------------->")
			console.log(txHex)

			let txHash = await nodeHelper.broadcastTx(txHex)
			
			assert((txHash != null) && (txHash.length == 64))
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			let tx = null
			let tries = 3
			while ((tx == null) && (tries > 0)){
				tx = await db.getTransaction(txHash)
				
				if (tx == null){
					tries = tries - 1
					console.log("Couldn't get tx ("+txHash+"), trying again in a few seconds...")
					await sleep(1000)
				} else {
					//console.log("tx------------------>")
					//console.log(tx)
				}
			}
						
			assert(tx != null)
			assert(tx['source'] == testAddress)
		}),
		it('should parse a OP_RETURN transaction from a Taproot source', async () => {
			var network = bitcoin.networks.regtest
		
			//var mnemonic = bip39.generateMnemonic()
			var mnemonic = 'erase average powder march guess lemon basic eight arena world once puzzle' //address should be mqhMKLhD68FAYyXjwdYD6P7AGASyYyEZkX
			console.log("The seed for the test is: " + mnemonic)

			var seed = bip39.mnemonicToSeedSync(mnemonic)
			var root = bip32.fromSeed(seed, network)
			var account = root.derivePath("m/44'/0'/0'/0")
			var address = account.derive(0).derive(0)
			
			var onlyXPublicKey = address.publicKey.slice(1, 33)
			
			//var {testAddress, output} = bitcoin.payments.p2tr({ pubkey: onlyXPublicKey, network })
			let p2trPayment = bitcoin.payments.p2tr({ internalPubkey: onlyXPublicKey, network })
			let testAddress = p2trPayment["address"]
			let testAddressOutput = p2trPayment["output"]
			console.log("address for the test: "+testAddress)

			var tweakedAddress = address.tweak(
				bitcoin.crypto.taggedHash('TapTweak', onlyXPublicKey)
			)

			let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
			let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
			
			console.log(JSON.stringify(rawTx1))
			
			let rawTx1Hex = await nodeClientTest.getRawTransaction(txId1)
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			
			//Create the tx
			let dataBuffer = Buffer.from("P2TR to OP_RETURN", "utf-8")
			let data = Buffer.concat([magicWordBuffer, dataBuffer])
			
			let psbt = new bitcoin.Psbt({ network: network })
			let utxos = []
			let utxo1 = null
			let inputSatoshis = 0
			let fee = 10000
			for (let nextVoutIndex in rawTx1["vout"]){
				let nextVout = rawTx1["vout"][nextVoutIndex]
				
				if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
					psbt.addInput({
						hash: rawTx1["txid"],
						index: nextVout["n"],
						sequence: 0x00000001,
						witnessUtxo:{value: nextVout["value"]*100000000, script: testAddressOutput},
						tapInternalKey: onlyXPublicKey
					})
					
					inputSatoshis = inputSatoshis + nextVout["value"]*100000000
				}
			}
			
			
			let obfuscatedData = await nodeHelper.obfuscate(data, txId1)
			let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })
					
			psbt.addOutput({
				script: opReturnScript.output,
				value: 0
			})
			//Change
			psbt.addOutput({
				address: testAddress,
				value: inputSatoshis - fee
			})
			
			//Sign the psbt
			//var ECPair = ECPairFactory(ecc);

			//let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

			for (let nextInputIndex in psbt.data.inputs){
				let proxInput = psbt.data.inputs[nextInputIndex]			  
				//psbt.signInput(parseInt(nextInputIndex), keyToSign);
				psbt.signInput(parseInt(nextInputIndex), tweakedAddress);
			}
			
			psbt.finalizeAllInputs();
			
			console.log("Sending the P2TR/OP_RETURN transaction to the node")
			
			console.log(JSON.stringify(psbt))
			
			txHex = psbt.extractTransaction().toHex()
			
			console.log("txHex----------------------->")
			console.log(txHex)

			let txHash = await nodeHelper.broadcastTx(txHex)
			
			assert((txHash != null) && (txHash.length == 64))
			await nodeClientTest.generateToAddress(1, mainTestAddress)
			
			let tx = null
			let tries = 3
			while ((tx == null) && (tries > 0)){
				tx = await db.getTransaction(txHash)
				
				if (tx == null){
					tries = tries - 1
					console.log("Couldn't get tx ("+txHash+"), trying again in a few seconds...")
					await sleep(1000)
				} else {
					//console.log("tx------------------>")
					//console.log(tx)
				}
			}
						
			assert(tx != null)
			assert(tx['source'] == testAddress)
		})
    });
});