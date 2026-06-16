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
    let encrypted = cipher.update(Buffer.from(plaintext))
    return Buffer.concat([encrypted, cipher.final()])
}

describe('Smoke: AES-128-CTR Deobfuscation', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    it('should round-trip an XCHN payload using fixture txid', async () => {
        const plaintext = 'XCHNSEND|0|XCHAIN|1000'
        const cipherBuf = encrypt(plaintext, fixtures.txid)
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.ok(Buffer.isBuffer(result))
        assert.strictEqual(result.toString('utf-8'), plaintext)
        assert.ok(result.subarray(0, 4).equals(Buffer.from('XCHN')))
    })

    it('should decrypt a known fixture XCHN payload', async () => {
        const cipherBuf = Buffer.from(fixtures.xchnPayload.cipher, 'hex')
        const result = await decoder.removeObfuscation(cipherBuf, fixtures.txid)

        assert.strictEqual(result.toString('utf-8'), fixtures.xchnPayload.plain)
    })

    it('should return null for non-Buffer input', async () => {
        const result = await decoder.removeObfuscation('not a buffer', fixtures.txid)
        assert.strictEqual(result, null)
    })

    it('should return null for null input', async () => {
        const result = await decoder.removeObfuscation(null, fixtures.txid)
        assert.strictEqual(result, null)
    })
})
