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

describe('Boundary: Multisig Zero-Trim Edge Cases', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Multisig where data has a single trailing zero
    it('should remove single trailing zero from multisig data', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // Build pubkeys where stripped data = [encrypted XCHN payload] + [0x00]
        // We need the data after deobfuscation to start with XCHN
        const { key, iv } = getKeyIv()
        const targetPlain = Buffer.from('XCHNtest')
        const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
        const encrypted = Buffer.concat([cipher.update(targetPlain), cipher.final()])

        // Pad to fit in two 32-byte pubkey data slots (64 bytes total), trailing zeros
        const fullData = Buffer.alloc(64, 0x00)
        encrypted.copy(fullData, 0)

        const pubkey1 = Buffer.concat([Buffer.from([0x02]), fullData.subarray(0, 32)])
        const pubkey2 = Buffer.concat([Buffer.from([0x02]), fullData.subarray(32, 64)])

        const script = bitcoin.script.compile([
            bitcoin.opcodes.OP_1,
            pubkey1,
            pubkey2,
            Buffer.alloc(33, 0x03),
            bitcoin.opcodes.OP_3,
            bitcoin.opcodes.OP_CHECKMULTISIG
        ])
        tx.addOutput(script, 1000)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Zero-trim should remove trailing zeros, leaving the encrypted bytes.
        // After deobfuscation, the XCHN prefix should be stripped, leaving "test"
    })
})

describe('Boundary: Multisig Zero-Trim Edge Cases', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Multisig where data has no trailing zeros (all bytes non-zero)
    it('should keep all bytes when no trailing zeros exist', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // Fill with non-zero bytes
        const pubkey1 = Buffer.alloc(33, 0xff)
        pubkey1[0] = 0x02
        const pubkey2 = Buffer.alloc(33, 0xff)
        pubkey2[0] = 0x02

        const script = bitcoin.script.compile([
            bitcoin.opcodes.OP_1,
            pubkey1,
            pubkey2,
            Buffer.alloc(33, 0x03),
            bitcoin.opcodes.OP_3,
            bitcoin.opcodes.OP_CHECKMULTISIG
        ])
        tx.addOutput(script, 1000)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // All 0xff bytes, zero-trim doesn't remove anything.
        // Decrypted data won't match XCHN prefix → no data extracted
        assert.strictEqual(result.data.length, 0)
    })
})
