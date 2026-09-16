// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const sinon = require('sinon')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// The decoder derives AES key/IV from the reversed hex of the first input's prevout hash.
// All test txs use the same prevout hash for simplicity.
const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

function getKeyIv() {
    const display = Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: display.substr(0, 16), iv: display.substr(16, 16) }
}

function encryptBuf(plainBuf) {
    const { key, iv } = getKeyIv()
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    let enc = cipher.update(plainBuf)
    return Buffer.concat([enc, cipher.final()])
}

function addStandardInput(tx) {
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
}

function addP2PKHOutput(tx, value) {
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), value || 100000000)
}

// Create a decoder with mocked DB and connector
function createDecoder() {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false)
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

function buildFullMultisigChunkTx() {
    // A full 64-byte MULTISIGN chunk (magic(4) + 60 data bytes, no padding)
    // carries live AES-128-CTR ciphertext in its final byte. ~1/256 of the
    // time that byte is 0x00. The decoder must NOT strip it: doing so decrypts
    // one byte short and silently corrupts the decoded action. This test forces
    // the final ciphertext byte to 0x00 and asserts a byte-for-byte round trip.
    const { key, iv } = getKeyIv()

    // AES-CTR encrypting an all-zero buffer yields the raw keystream.
    const ksCipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    const keystream = Buffer.concat([ksCipher.update(Buffer.alloc(64, 0)), ksCipher.final()])

    // Build a 60-byte compiled script: 1-byte pushdata prefix + 59 data bytes.
    // Plaintext chunk = XCHN(4) + script(60) = exactly 64 bytes (both pubkey
    // halves full, no zero-pad), so plaintext[63] is the last data byte.
    const action = Buffer.alloc(59)
    for (let i = 0; i < action.length; i++) action[i] = 0x41 + (i % 26)
    // Force plaintext[63] == keystream[63] so ciphertext[63] == 0x00.
    action[action.length - 1] = keystream[63]

    const scriptPayload = bitcoin.script.compile([action])
    const plain = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    const cipher = encryptBuf(plain)

    // Split into two 32-byte halves, each 0x02-prefixed, as dataToPubkey() does.
    const pubkey1 = Buffer.concat([Buffer.from([0x02]), cipher.subarray(0, 32)])
    const pubkey2 = Buffer.concat([Buffer.from([0x02]), cipher.subarray(32, 64)])
    const pubkey3 = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 0x03)])

    const multisigScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_1,
        pubkey1,
        pubkey2,
        pubkey3,
        bitcoin.opcodes.OP_3,
        bitcoin.opcodes.OP_CHECKMULTISIG
    ])

    const tx = new bitcoin.Transaction()
    tx.version = 2
    addStandardInput(tx)
    tx.addOutput(multisigScript, 1000)
    addP2PKHOutput(tx)
    return { action, cipher, plain, scriptPayload, tx }
}

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('[REGRESSION P0] R-SCR-005: should not drop a 0x00 final ciphertext byte on a full multisig chunk', async () => {
        const { action, cipher, plain, scriptPayload, tx } = buildFullMultisigChunkTx()

        assert.strictEqual(scriptPayload.length, 60)
        assert.strictEqual(plain.length, 64)
        assert.strictEqual(cipher.length, 64)
        // Precondition: the bug only triggers when the final ciphertext byte is 0x00.
        assert.strictEqual(cipher[63], 0x00)

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.ok(Buffer.isBuffer(result.data))
        // Byte-for-byte: the decoded action must equal the original 59 bytes,
        // including the final byte the old strip loop would have dropped.
        assert.strictEqual(result.data.length, action.length)
        assert.ok(result.data.equals(action), 'decoded data must match original payload byte-for-byte')
    })
})

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Regression: a per-input redeem-script decompile throw must not be caught,
    // logged, and `continue`d, since that drops that input's chunk while
    // concatenation keeps going, letting a truncated ACTION payload commit
    // with no quarantine event. The extraction fails the whole tx instead, so
    // the block loop routes it through the retry-then-PARSE_ERROR quarantine path.
    it('[REGRESSION] P2SH: a mid-input extraction throw fails the whole tx instead of committing a truncated payload', async () => {
        // Force the P2SH reassembly branch deterministically.
        sinon.stub(decoder, 'removeObfuscation').resolves(Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2sh')]))

        // Scoped decompile stub: throw only for the POISON script, delegate the
        // rest (output script, input 0's valid scriptSig) to the real decoder.
        const POISON = Buffer.from('ba'.repeat(16), 'hex')
        const realDecompile = bitcoin.script.decompile
        sinon.stub(bitcoin.script, 'decompile').callsFake((script) => {
            if (Buffer.isBuffer(script) && script.equals(POISON)) throw new Error('malformed redeem script bytes')
            return realDecompile(script)
        })

        const dataChunk     = Buffer.from('actionpayloadchunk')
        const redeemScript  = bitcoin.script.compile([dataChunk])
        const goodScriptSig = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02), redeemScript])

        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(PREV_HASH, 1)          // input 0: valid data chunk
        tx.ins[0].script = goodScriptSig
        tx.addInput(PREV_HASH, 2)          // input 1: redeem-script decompile throws
        tx.ins[1].script = POISON
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(8, 0xAB)]), 0)
        addP2PKHOutput(tx)

        await assert.rejects(
            decoder.parseTransaction(tx),
            /P2SH data extraction failed for input 1/
        )
    })
})

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('[REGRESSION] P2WSH: a mid-input extraction throw fails the whole tx instead of committing a truncated payload', async () => {
        sinon.stub(decoder, 'removeObfuscation').resolves(Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2wsh')]))

        const POISON = Buffer.from('ba'.repeat(16), 'hex')
        const realDecompile = bitcoin.script.decompile
        sinon.stub(bitcoin.script, 'decompile').callsFake((script) => {
            if (Buffer.isBuffer(script) && script.equals(POISON)) throw new Error('malformed witness redeem script bytes')
            return realDecompile(script)
        })

        const dataChunk    = Buffer.from('actionpayloadchunk')
        const redeemScript = bitcoin.script.compile([dataChunk])

        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(PREV_HASH, 1)          // input 0: valid witness data chunk
        tx.ins[0].witness = [Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02), redeemScript]
        tx.addInput(PREV_HASH, 2)          // input 1: witness redeem-script decompile throws
        tx.ins[1].witness = [Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02), POISON]
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(8, 0xAB)]), 0)
        addP2PKHOutput(tx)

        await assert.rejects(
            decoder.parseTransaction(tx),
            /P2WSH data extraction failed for input 1/
        )
    })
})
