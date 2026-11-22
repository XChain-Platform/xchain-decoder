// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// extractPubkeyFromInput on P2SH and P2WSH carrier spends: the key is the middle
// push of a plain <sig> <pubkey> <redeemScript> scriptSig (or witness[1]), never a
// multisig or non-key-length push, and only when it hashes to the source address.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc    = require('tiny-secp256k1')
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// Real secp256k1 points, so the binding check sees well-formed keys.
const KEY_A = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x01), true))
const KEY_B = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x02), true))

let decoder
function prepareDecoder(){
    decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', 3306, 'db', 'u', 'p',
        '127.0.0.1', 18443, 'rpc', 'rpc', false, null
    )
}
const p2pkhOf  = (key) => bitcoin.payments.p2pkh({ hash: bitcoin.crypto.hash160(key), network: decoder.network }).address
const p2wpkhOf = (key) => bitcoin.payments.p2wpkh({ hash: bitcoin.crypto.hash160(key), network: decoder.network }).address

// The encoder's carrier script shape: a data push, then a P2PKH-style key check.
function carrierScript(pubkey){
    return bitcoin.script.compile([Buffer.alloc(20, 0x11), bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, bitcoin.crypto.hash160(pubkey), bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG])
}

function p2shSpend(pubkey){
    return { witness: [], script: bitcoin.script.compile([Buffer.alloc(71, 0x30), pubkey, carrierScript(pubkey)]) }
}

function p2wshSpend(pubkey){
    return { witness: [Buffer.alloc(71, 0x30), pubkey, carrierScript(pubkey)], script: Buffer.alloc(0) }
}

describe('XChainDecoder#extractPubkeyFromInput() P2SH carrier', () => {
    before(prepareDecoder)

    it('should extract the middle push from a P2SH carrier scriptSig <sig> <pubkey> <redeemScript>', () => {
        const pubkey = Buffer.alloc(33, 0x02)
        const sig    = Buffer.alloc(71, 0x30)
        const redeem = bitcoin.script.compile([Buffer.alloc(20, 0x11), bitcoin.opcodes.OP_DROP, bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, Buffer.alloc(20, 0x22), bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG])
        const input = { witness: [], script: bitcoin.script.compile([sig, pubkey, redeem]) }
        assert.strictEqual(decoder.extractPubkeyFromInput(input, p2pkhOf(pubkey)), pubkey.toString('hex'))
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

// The source of a carrier reveal is the commit funder, found by walking back a hop,
// so nothing on chain ties the spender's key to it. A key that does not hash to the
// source must never be recorded as that address's key.
describe('XChainDecoder#extractPubkeyFromInput() carrier key bound to the source', () => {
    before(prepareDecoder)

    it('should not record a valid middle-push key that does not hash to the source address', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_B), p2pkhOf(KEY_A)), null)
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_B), p2wpkhOf(KEY_A)), null)
    })

    it('should not record a middle-push key when no source address is given', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_A)), null)
    })

    it('should record the middle-push key when it hashes to a P2PKH source address', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_A), p2pkhOf(KEY_A)), KEY_A.toString('hex'))
    })

    it('should record the middle-push key when it hashes to a P2WPKH source address', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_A), p2wpkhOf(KEY_A)), KEY_A.toString('hex'))
    })

    it('should not record a middle-push key against a P2SH source address', () => {
        const scriptHashSource = bitcoin.payments.p2sh({ hash: bitcoin.crypto.hash160(KEY_A), network: decoder.network }).address
        assert.strictEqual(decoder.extractPubkeyFromInput(p2shSpend(KEY_A), scriptHashSource), null)
    })

    it('should not record a P2WSH-shaped witness key that does not hash to the source address', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2wshSpend(KEY_B), p2pkhOf(KEY_A)), null)
        assert.strictEqual(decoder.extractPubkeyFromInput(p2wshSpend(KEY_B), p2wpkhOf(KEY_A)), null)
    })

    it('should record a P2WSH-shaped witness key when it hashes to the source address', () => {
        assert.strictEqual(decoder.extractPubkeyFromInput(p2wshSpend(KEY_A), p2pkhOf(KEY_A)), KEY_A.toString('hex'))
    })
})
