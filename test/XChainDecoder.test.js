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
			
			let txHex = "02000000015552d72dad1fe85f76b6dd802e51cf83a5a836147c14dbe49ac474139963071"
						+"a010000006b483045022100d02acb87d688e0a34b33603fbd0b0ab3e9172a4e986d81c9f"
						+"c8bd67ce1661bff02203eb8cecfea9b75a54c139be70a0b9570a122f41956a8b209a0f7b"
						+"dee3538c7440121026fd46a6da1498e0b2fbd2c25f4593df8f1f3fa741ce3081bf9d88b3"
						+"89c1f4de101000000020000000000000000126a10d3f5ce1584ec5d95edf5e932657684a"
						+"df0b9f505000000001976a914061d0ea05b693223ee2a20c468fe0d2ef1c2188888ac000"
						+"00000"
			            
			let result = await decoder.parseRawTransaction(txHex)
			
			assert(result["data"].toString("utf-8") == "Small data")
		});
		it('should parse a multisign', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "0200000001603c167fa3e27ffde812c9d427bce4bf93642f69844e05498aaa945e0fd7b2c"
						+"3010000006b48304502210092d70aef1d96e5ab952b813f356c4844b7af024df47fb9204"
						+"3bfb1f2d11ba5df02200a9adafd8c87be04689bfdfbc2acaa004430a27568edc734a0844"
						+"4fb1458939f012103109e8964bbcfe494cfaa4b3f8c6eb374b7617d7b0ed7c5600710e42"
						+"f2921b22e0100000002e803000000000000695121029c33b1e19d03988ad626a6ec59d8e"
						+"58c0088311ec24a47a74ca4974c1cb0f8f121022b68f49a88fef9b7969392add17f5faa0"
						+"00000000000000000000000000000002103109e8964bbcfe494cfaa4b3f8c6eb374b7617"
						+"d7b0ed7c5600710e42f2921b22e53aef0b9f505000000001976a914df51d74b7cb5fb647"
						+"91223aa4b9693a7410e9b2288ac00000000"
						
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "Data for only one multisign output")
		});
		it('should parse a P2SH transaction', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "0200000001a809ebe88a79d3cb9a23d880dc2caae3fc638313cbac7ddf9e11f626279962d"
						+"f00000000de483045022100f4f1f1beaaa443c93ccad35baeb433bfe3b6004077a8be4c9"
						+"4105ff05392306a022069abe09cbbc5309fb83cc72cd7139a9c11a54a124e929505bc12c"
						+"fb11d64ce8a0121033606d299cb15e3cb41d85020f024281cc22ed7b3ec2459ee34dcca0"
						+"f6164c5774c714c555265616c6c7920626967206461746120666f7220703273682074657"
						+"3742c2069742073686f756c6420776569676874206d6f7265207468616e2038302062797"
						+"4657320746f20757365207032736820656e636f64657576a914fac1c1cc3d76d779989d7"
						+"b5919780c07c9845bce88ac01000000010000000000000000126a109a711fbc64c617fae"
						+"48b1293286fdf5900000000"
						
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "Really big data for p2sh test, it should weight more than 80 bytes to use p2sh encode")
		});
		it('should parse a P2WSH transaction', async () => {
			const decoder = new XChainDecoder("bitcoin-regtest", null, null, null, null, null, "http://127.0.0.1:8333", "rpc", "rpc");
			
			let txHex = "02000000000101808d16e3940f239840e671d314271036400f3e5622db51f213118c23809"
						+"374f0000000000001000000010000000000000000126a10697f08ba79fc76c3cc710957a"
						+"f31570403473044022014e67312edfdf00c7601555ff136d5b85e4f6bc1c1028b62e77d3"
						+"5265499dfaf022020758fe14f9bc9f8a21c79c9d4adaa450de87f4d5caa71b6341232e1a"
						+"a02a0880121031be3ecad1e5ffbac9b9e9280dcb43599db6be3209da79737f2d1c7f11ba"
						+"16184f44cd84142434445464748494a4b4c4d4e4f505152535455565758595a314142434"
						+"445464748494a4b4c4d4e4f505152535455565758595a324142434445464748494a4b4c4"
						+"d4e4f505152535455565758595a334142434445464748494a4b4c4d4e4f5051525354555"
						+"65758595a344142434445464748494a4b4c4d4e4f505152535455565758595a354142434"
						+"445464748494a4b4c4d4e4f505152535455565758595a364142434445464748494a4b4c4"
						+"d4e4f505152535455565758595a374142434445464748494a4b4c4d4e4f5051525354555"
						+"65758595a387576a91442c3702bf565ce6be94d4b831b4c7c55720990cb88ac00000000"
						
			let result = await decoder.parseRawTransaction(txHex)
			assert(result["data"] == "ABCDEFGHIJKLMNOPQRSTUVWXYZ1ABCDEFGHIJKLMNOPQRSTUVWXYZ2ABCDEFGHIJKLMNOPQRSTUVWXYZ3ABCDEFGHIJKLMNOPQRSTUVWXYZ4ABCDEFGHIJKLMNOPQRSTUVWXYZ5ABCDEFGHIJKLMNOPQRSTUVWXYZ6ABCDEFGHIJKLMNOPQRSTUVWXYZ7ABCDEFGHIJKLMNOPQRSTUVWXYZ8")			
		});
    });
});