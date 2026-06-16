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
const crypto = require('crypto')
const XChainDecoder = require('../../src/XChainDecoder')
const fixtures = require('../fixtures/crypto.json')

// Helper to create a decoder instance without real DB/connector
function createDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
}

// Helper to encrypt data with the same scheme the decoder uses
function encrypt(plaintext, txid) {
    const key = txid.substr(0, 16)
    const iv = txid.substr(16, 16)
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    let encrypted = cipher.update(Buffer.from(plaintext))
    encrypted = Buffer.concat([encrypted, cipher.final()])
    return encrypted
}

describe('XChainDecoder#removeObfuscation()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    it('[REGRESSION P0] R-DEC-001: should decrypt a known XCHN payload correctly', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), fixtures.xchnPayload.plain)
        assert.ok(result.subarray(0, 4).equals(Buffer.from('XCHN')))
    })

    it('[REGRESSION P0] R-DEC-003: should decrypt non-XCHN data without error', async () => {
        const cipherBuf = Buffer.from(fixtures.nonXchnPayload.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), fixtures.nonXchnPayload.plain)
        assert.ok(!result.subarray(0, 4).equals(Buffer.from('XCHN')))
    })

    it('should decrypt XCHNp2sh marker correctly', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnP2sh.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.strictEqual(result.toString('utf-8'), 'XCHNp2sh')
    })

    it('should decrypt XCHNp2wsh marker correctly', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnP2wsh.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.strictEqual(result.toString('utf-8'), 'XCHNp2wsh')
    })

    it('should decrypt data that is exactly 4 bytes (XCHN prefix only)', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnEmpty.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.strictEqual(result.toString('utf-8'), 'XCHN')
        assert.strictEqual(result.length, 4)
    })

    it('[REGRESSION P0] R-DEC-004: should return null for non-Buffer input (string)', async () => {
        const result = await decoder.removeObfuscation('not a buffer', fixtures.txid)
        assert.strictEqual(result, null)
    })

    it('should return null for null input', async () => {
        const result = await decoder.removeObfuscation(null, fixtures.txid)
        assert.strictEqual(result, null)
    })

    it('should return null for undefined input', async () => {
        const result = await decoder.removeObfuscation(undefined, fixtures.txid)
        assert.strictEqual(result, null)
    })

    it('should return null for a number input', async () => {
        const result = await decoder.removeObfuscation(12345, fixtures.txid)
        assert.strictEqual(result, null)
    })

    it('should handle an empty Buffer', async () => {
        const result = await decoder.removeObfuscation(Buffer.alloc(0), fixtures.txid)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 0)
    })

    it('should produce consistent results across multiple calls', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
        const result1 = await decoder.removeObfuscation(cipherBuf, fixtures.txid)
        const result2 = await decoder.removeObfuscation(Buffer.from(fixtures.xchnPayload.cipher, 'hex'), fixtures.txid)

        assert.ok(result1.equals(result2))
    })

    it('[REGRESSION P0] R-DEC-005: should decrypt correctly with different txids (different key/iv)', async () => {
        const txid1 = 'aaaaaaaaaaaaaaaa1111111111111111ccccccccccccccccdddddddddddddddd'
        const txid2 = 'bbbbbbbbbbbbbbbb2222222222222222ccccccccccccccccdddddddddddddddd'
        const plaintext = 'XCHNtest data'

        const cipher1 = encrypt(plaintext, txid1)
        const cipher2 = encrypt(plaintext, txid2)

        // Different keys produce different ciphertext
        assert.ok(!cipher1.equals(cipher2))

        // Both decrypt back to the same plaintext
        const result1 = await decoder.removeObfuscation(cipher1, txid1)
        const result2 = await decoder.removeObfuscation(cipher2, txid2)
        assert.strictEqual(result1.toString('utf-8'), plaintext)
        assert.strictEqual(result2.toString('utf-8'), plaintext)
    })

    it('should handle a large payload', async () => {
        const largePlain = 'XCHN' + 'A'.repeat(10000)
        const cipherBuf = encrypt(largePlain, fixtures.txid)
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.strictEqual(result.toString('utf-8'), largePlain)
    })

    it('[REGRESSION P0] R-DEC-005: should produce wrong plaintext when decrypted with wrong txid', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
        const wrongTxid = 'ffffffffffffffff0000000000000000aaaaaaaaaaaaaaaa1111111111111111'
        const result = await decoder.removeObfuscation(cipherBuf, wrongTxid)

        assert.ok(Buffer.isBuffer(result))
        assert.notStrictEqual(result.toString('utf-8'), fixtures.xchnPayload.plain)
    })

    it('should handle single-byte payload', async () => {
        const oneByte = Buffer.from([0x42])
        const result = await decoder.removeObfuscation(oneByte, fixtures.txid)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 1)
    })

    it('should handle binary data with null bytes', async () => {
        const binaryData = Buffer.from([0x00, 0x00, 0x00, 0x00, 0xff, 0x00])
        const result = await decoder.removeObfuscation(binaryData, fixtures.txid)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 6)
    })
})
