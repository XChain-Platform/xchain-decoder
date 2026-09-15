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
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

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

describe('XChainDecoder#isFutureSegwitScript()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    it('should return false for P2PKH script', () => {
        const script = Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex')
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_RETURN script', () => {
        const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('test')])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_0 (v0 segwit, handled by bitcoinjs)', () => {
        // P2WPKH: OP_0 <20-byte hash>
        const script = Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, 0xbb)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for OP_1 (v1 taproot, handled by bitcoinjs)', () => {
        // P2TR: OP_1 <32-byte key>
        const script = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xcc)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return true for OP_2 (v2 future segwit) with valid push length', () => {
        // OP_2=0x52, push 20 bytes
        const script = Buffer.concat([Buffer.from([0x52, 0x14]), Buffer.alloc(20, 0xdd)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })
})

describe('XChainDecoder#isFutureSegwitScript()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    it('should return true for OP_16 (v16 future segwit) with valid push length', () => {
        // OP_16=0x60, push 32 bytes
        const script = Buffer.concat([Buffer.from([0x60, 0x20]), Buffer.alloc(32, 0xee)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })

    it('should return false for version byte above OP_16', () => {
        const script = Buffer.concat([Buffer.from([0x61, 0x14]), Buffer.alloc(20, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false for script shorter than 4 bytes', () => {
        assert.strictEqual(decoder.isFutureSegwitScript(Buffer.from([0x52, 0x02, 0xaa])), false)
    })

    it('should return false for script longer than 42 bytes', () => {
        const script = Buffer.concat([Buffer.from([0x52, 0x29]), Buffer.alloc(41, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    it('should return false when push length does not match actual script length', () => {
        // OP_2 with push=20 but only 10 bytes of data
        const script = Buffer.concat([Buffer.from([0x52, 0x14]), Buffer.alloc(10, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })
})
