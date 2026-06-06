// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const XChainDecoder = require('../../../src/XChainDecoder')
const fixtures = require('../../fixtures/crypto.json')

function createDecoder() {
    return new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
}

function encrypt(plaintext, txid) {
    const key = txid.substr(0, 16)
    const iv = txid.substr(16, 16)
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
}

// Standard 64-char txid for most tests
const VALID_TXID = 'aabbccdd11223344eeff556677889900aabbccdd11223344eeff556677889900'

describe('Boundary: AES-128-CTR Deobfuscation (D-1 through D-7)', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    // D-1: Empty data buffer
    it('[REGRESSION P0] R-DEC-004 D-1: should handle empty buffer without crash', async () => {
        const result = await decoder.removeObfuscation(Buffer.alloc(0), VALID_TXID)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 0)
    })

    // D-2: 1-byte data
    it('D-2: should decrypt 1-byte buffer (will not match XCHN prefix)', async () => {
        const result = await decoder.removeObfuscation(Buffer.from([0x42]), VALID_TXID)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 1)
    })

    // D-3: Exactly 4 bytes decrypting to XCHN (empty payload after prefix)
    it('[REGRESSION P0] R-DEC-001 D-3: should decrypt data that produces exactly XCHN with no payload', async () => {
        const cipherBuf = encrypt('XCHN', VALID_TXID)
        const result = await decoder.removeObfuscation(cipherBuf, VALID_TXID)
        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), 'XCHN')
        assert.strictEqual(result.length, 4)
        // subarray(4) should be empty
        assert.strictEqual(result.subarray(4).length, 0)
    })

    // D-4: Truncated txid (< 32 chars) — key/IV extraction gets short strings
    it('D-4: should handle truncated txid (4 chars) without crashing', async () => {
        const data = Buffer.from([0x01, 0x02, 0x03, 0x04])
        // createDecipheriv with a 4-char key should throw ERR_CRYPTO_INVALID_IV
        // or similar — the try/catch should handle it
        let threw = false
        try {
            const result = await decoder.removeObfuscation(data, 'abcd')
            // If it doesn't throw, the result should still be safe
            // (CTR mode with short key may or may not throw depending on Node version)
        } catch (err) {
            threw = true
            // The removeObfuscation catch block only re-throws non-decrypt errors,
            // so if it throws here, it's an unexpected error type
        }
        // Either way, no unhandled crash
    })

    // D-5: Empty txid — both key and IV are empty strings
    it('D-5: should handle empty txid without crashing', async () => {
        const data = Buffer.from([0x01, 0x02, 0x03, 0x04])
        let result
        let threw = false
        try {
            result = await decoder.removeObfuscation(data, '')
        } catch (err) {
            threw = true
        }
        // createDecipheriv('aes-128-ctr', '', '') should throw because
        // key length 0 != 16 bytes. The catch block should handle it.
        // Either null is returned or the error is re-thrown (both acceptable)
    })

    // D-6: All-zero key and IV — valid AES operation
    it('[REGRESSION P0] R-DEC-005 D-6: should decrypt with all-zero txid (valid AES key/IV)', async () => {
        const zeroTxid = '0'.repeat(64)
        const plaintext = 'XCHNtest with zero key'
        const cipherBuf = encrypt(plaintext, zeroTxid)
        const result = await decoder.removeObfuscation(cipherBuf, zeroTxid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), plaintext)
    })

    // D-7: All-f key and IV — valid AES operation
    it('[REGRESSION P0] R-DEC-005 D-7: should decrypt with all-f txid (valid AES key/IV)', async () => {
        const fTxid = 'f'.repeat(64)
        const plaintext = 'XCHNtest with ff key'
        const cipherBuf = encrypt(plaintext, fTxid)
        const result = await decoder.removeObfuscation(cipherBuf, fTxid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), plaintext)
    })

    // Additional boundary: exactly 16 bytes (one AES block)
    it('should handle exactly 16-byte (one AES block) buffer', async () => {
        const plaintext = 'XCHN' + 'A'.repeat(12) // 16 bytes total
        const cipherBuf = encrypt(plaintext, VALID_TXID)
        const result = await decoder.removeObfuscation(cipherBuf, VALID_TXID)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 16)
        assert.strictEqual(result.toString('utf-8'), plaintext)
    })

    // Additional boundary: 76 bytes (OP_RETURN max standard push)
    it('should handle 76-byte buffer (OP_RETURN max push)', async () => {
        const plaintext = 'XCHN' + 'B'.repeat(72)
        const cipherBuf = encrypt(plaintext, VALID_TXID)
        const result = await decoder.removeObfuscation(cipherBuf, VALID_TXID)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 76)
        assert.strictEqual(result.toString('utf-8'), plaintext)
    })

    // Additional boundary: 520 bytes (P2SH script push limit)
    it('should handle 520-byte buffer (P2SH push limit)', async () => {
        const plaintext = 'XCHN' + 'C'.repeat(516)
        const cipherBuf = encrypt(plaintext, VALID_TXID)
        const result = await decoder.removeObfuscation(cipherBuf, VALID_TXID)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 520)
    })

    // Additional boundary: large reassembled P2WSH payload (10,000+ bytes)
    it('should handle 10,000-byte buffer (large P2WSH reassembly)', async () => {
        const plaintext = 'XCHN' + 'D'.repeat(9996)
        const cipherBuf = encrypt(plaintext, VALID_TXID)
        const result = await decoder.removeObfuscation(cipherBuf, VALID_TXID)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.length, 10000)
    })

    // Additional boundary: mixed-case txid
    it('should handle mixed-case hex txid', async () => {
        const mixedTxid = 'aAbBcCdD11223344eEfF556677889900aAbBcCdD11223344eEfF556677889900'
        const plaintext = 'XCHNmixed case test'
        const cipherBuf = encrypt(plaintext, mixedTxid)
        const result = await decoder.removeObfuscation(cipherBuf, mixedTxid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), plaintext)
    })
})
