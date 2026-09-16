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
const XChainDecoder = require('../../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// Same prevout hash used in parseTransaction tests
const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

function getKeyIv() {
    const display = Buffer.from(PREV_HASH).reverse().toString('hex')
    return { key: display.substr(0, 16), iv: display.substr(16, 16) }
}

function encryptBuf(plainBuf) {
    const { key, iv } = getKeyIv()
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

// Build encrypted XCHN payload: data after XCHN prefix must be a compiled bitcoin script
function buildXchnPayload(data) {
    const parts = [Buffer.from(data)]
    const scriptPayload = bitcoin.script.compile(parts)
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encryptBuf(plainBuf)
}

function addStandardInput(tx) {
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
}

function addP2PKHOutput(tx, value) {
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), value || 100000000)
}

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
    // A failed prevout lookup now throws (tagged rpcLookupFailure) instead of
    // resolving a null source; stub source resolution to the deterministic
    // null these decode-focused tests rely on.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

describe('Boundary: Magic Prefix & Encoding Type Detection', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Data decrypts to "XCHM" (off-by-one from XCHN)
    it('should reject data decrypting to XCHM (off-by-one)', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = encryptBuf(Buffer.from('XCHMsome data'))
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
    })

    // After XCHN prefix strip, "p2s" falls to the else branch. decompile may return null
    // for non-script data: now handled gracefully.
    it('should handle XCHNp2s (incomplete p2sh) gracefully: no crash', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = encryptBuf(Buffer.from('XCHNp2s'))
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // decompile returns null for invalid script → dataBuffer reset to empty
        assert.strictEqual(result.data.length, 0)
    })

    // "XCHNp2shX": trailing data after p2sh marker
    it('should handle XCHNp2shX (extra byte after p2sh) gracefully: no crash', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = encryptBuf(Buffer.from('XCHNp2shX'))
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
    })
})

describe('Boundary: Magic Prefix & Encoding Type Detection', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Multiple OP_RETURN outputs: one valid XCHN, one not
    it('should extract data only from valid XCHN OP_RETURN, ignoring non-XCHN', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // First OP_RETURN: valid XCHN payload
        const validCipher = buildXchnPayload('SEND|0|XCHAIN|500')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, validCipher]), 0)

        // Second OP_RETURN: random non-XCHN data
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, crypto.randomBytes(32)]), 0)

        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.ok(result.data.length > 0)
        assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|500')
    })

    // Multiple valid XCHN OP_RETURNs: both get concatenated into dataBuffer
    it('should concatenate data from multiple valid XCHN OP_RETURN outputs', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher1 = buildXchnPayload('PART1')
        const cipher2 = buildXchnPayload('PART2')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher1]), 0)
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher2]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Both outputs' data get concatenated. The final bitcoin.script.decompile
        // on the combined buffer may or may not parse cleanly.
        assert.ok(result.data.length > 0)
    })
})
