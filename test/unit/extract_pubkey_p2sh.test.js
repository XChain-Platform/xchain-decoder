// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// extractPubkeyFromInput on P2SH carrier spends: the key is the middle push of
// a plain <sig> <pubkey> <redeemScript> scriptSig, never a multisig or
// non-key-length push.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc    = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

describe('XChainDecoder#extractPubkeyFromInput() P2SH carrier', () => {
    let decoder
    before(() => {
        decoder = new XChainDecoder(
            'bitcoin-regtest', 'h', 3306, 'db', 'u', 'p',
            '127.0.0.1', 18443, 'rpc', 'rpc', false, null
        )
    })

    it('should extract the middle push from a P2SH carrier scriptSig <sig> <pubkey> <redeemScript>', () => {
        const pubkey = Buffer.alloc(33, 0x02)
        const sig    = Buffer.alloc(71, 0x30)
        const redeem = bitcoin.script.compile([Buffer.alloc(20, 0x11), bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, Buffer.alloc(20, 0x22), bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG])
        const input = { witness: [], script: bitcoin.script.compile([sig, pubkey, redeem]) }
        assert.strictEqual(decoder.extractPubkeyFromInput(input), pubkey.toString('hex'))
    })

    it('should return null for a P2SH scriptSig whose middle push is not a key length', () => {
        const input = { witness: [], script: bitcoin.script.compile([Buffer.alloc(71, 0x30), Buffer.alloc(40, 0x02), Buffer.alloc(110, 0x51)]) }
        assert.strictEqual(decoder.extractPubkeyFromInput(input), null)
    })

    it('should not capture a key from a multisig P2SH scriptSig', () => {
        const input = { witness: [], script: bitcoin.script.compile([bitcoin.opcodes.OP_0, Buffer.alloc(71, 0x30), Buffer.alloc(71, 0x31), Buffer.alloc(105, 0x52)]) }
        assert.strictEqual(decoder.extractPubkeyFromInput(input), null)
    })
})
