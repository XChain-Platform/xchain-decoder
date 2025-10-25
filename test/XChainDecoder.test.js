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

const bitcoin = require('bitcoinjs-lib');
const assert = require('assert');
const XChainDecoder = require('../src/XChainDecoder');
const nodeHelper = require('./nodeHelper')

describe('XChainDecoder', () => {
	describe('#parseRawTransaction', () => {
		it('should parse a OP_RETURN transaction', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "020000000187100629ac1603de9cce139ff34d2f335c767565bcc57237bc5afdcfe985292"
						+"a010000006a47304402203d77d9654c80f107192fc7f169cdf9ca36d348662fce04269a107"
						+"e3f9d6482b90220149efa4fa78168a5dfb6ace9623bb15c97d1f4b1280d7a77ebcd852b24d"
						+"a00a50121035916fd403a852853c4df7f0c9ec4775b471163f750c6db9cda7de30aece597a"
						+"f01000000020000000000000000226a20dbfb3cfc8041d85094c7b06aac5d0075ddc2c579d"
						+"78b29df1c653b71f60cf5ccf0b9f505000000001976a9143d116616fcb52df7f41e7889866"
						+"26efcc0bee77b88ac00000000"
						
			            
			let result = await decoder.parseRawTransaction(txHex)
			
			assert(result["data"].toString("utf-8") == "Small data")
		});
		it('should parse a multisign', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "0200000001009ffb964e60a50eb3bf5baa87413ffdc2ca10cf72c41296de62ae74e00609b4"
						+"010000006a4730440220541f5cdb2eb75a69782dd4482fdcd0b7f76bb93b2fbae426f3964"
						+"1e8878e62af02203898bb0bd4dd52206b349a2d53468478600bb07bbfd66567c3f84e41f9"
						+"703dfd0121030ba7000729cb4b1cfe3830cc2229a17a4a091bd54efc755c97251597937b2"
						+"f810100000002e803000000000000695121026bd60090a47bad423c9c0250e8e9ffecf8a3"
						+"1453e728a0dd10fa9b647c483c3f21028b51b24ae4dd206fa5b5243e803c5b59000000000"
						+"0000000000000000000000021030ba7000729cb4b1cfe3830cc2229a17a4a091bd54efc75"
						+"5c97251597937b2f8153aef0b9f505000000001976a914bfcd3a9da714bfba50a4fd8b499"
						+"a96d32fec7f1f88ac00000000"
						
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "Data for only one multisign output")
		});
		it('should parse a P2SH transaction', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "02000000015058f68955c7247a10f5d844fd85e5beb1ddccb409ce8a4016ac5613f61fcf5"
			            +"200000000fa47304402202a47b9b54b7012cb8e949ec4fc048c30d7de28064b4c6e3b2f0"
						+"ffede992131e502207101c136625b6d3400db1053f992cf8a32b6ec6927cf7a3904db6ba"
						+"e6c930bf8012103b64b0cb7b216db539e00e5ef286cd52930bdf2c24e8572fa6e2146e54"
						+"62505854c8e4c724c555265616c6c7920626967206461746120666f72207032736820746"
						+"573742c2069742073686f756c6420776569676874206d6f7265207468616e20383020627"
						+"974657320746f20757365207032736820656e636f64651a52617720646174612073686f7"
						+"56c642062652062696720746f6f7576a914f3c9e791dcb40249df5b56d5f326ab68df67d"
						+"01988ac01000000010000000000000000126a10726cb677ffba05d53e6b032b812958870"
						+"0000000"
				
				
				
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "Really big data for p2sh test, it should weight more than 80 bytes to use p2sh encode")
		});
		it('should parse a P2WSH transaction', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "020000000001017e6679ef3f44b1fbee19099490ee801b092287b756cca4cdab71546d40f"
			            +"a40ff000000000001000000010000000000000000126a1073903b98c5886f727eaa47286"
						+"87ca5a203483045022100e852a0bb8ad48ecc46745ac7018b8607e9726c898d82e2b8a0f"
						+"2d94ca847a294022009f0e066d2d937ba0838585362e6b0f6b5bd609c74081be96ab8558"
						+"d4ec735d40121022c3c0344d8f1be2c38e50f5a64f156f0c09b2c65bb26f82f3c87c4490"
						+"9c7e92afa4cde4cd84142434445464748494a4b4c4d4e4f505152535455565758595a314"
						+"142434445464748494a4b4c4d4e4f505152535455565758595a324142434445464748494"
						+"a4b4c4d4e4f505152535455565758595a334142434445464748494a4b4c4d4e4f5051525"
						+"35455565758595a344142434445464748494a4b4c4d4e4f505152535455565758595a354"
						+"142434445464748494a4b4c4d4e4f505152535455565758595a364142434445464748494"
						+"a4b4c4d4e4f505152535455565758595a374142434445464748494a4b4c4d4e4f5051525"
						+"35455565758595a38035261777576a914da325d0f640ffd6e7f083030234a962570c8f25"
						+"d88ac00000000"
				
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "ABCDEFGHIJKLMNOPQRSTUVWXYZ1ABCDEFGHIJKLMNOPQRSTUVWXYZ2ABCDEFGHIJKLMNOPQRSTUVWXYZ3ABCDEFGHIJKLMNOPQRSTUVWXYZ4ABCDEFGHIJKLMNOPQRSTUVWXYZ5ABCDEFGHIJKLMNOPQRSTUVWXYZ6ABCDEFGHIJKLMNOPQRSTUVWXYZ7ABCDEFGHIJKLMNOPQRSTUVWXYZ8")			
		});
    });
});