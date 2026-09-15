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
const XChainDecoder = require('../../../../src/XChainDecoder')

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

describe('Boundary: isFutureSegwitScript additional edge cases', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    // Exactly 4 bytes (minimum valid length)
    it('should handle 4-byte script at minimum length boundary', () => {
        // OP_2 (0x52) + push 2 + 2 bytes data = 4 total
        const script = Buffer.from([0x52, 0x02, 0xaa, 0xbb])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })

    // Exactly 42 bytes (maximum valid length)
    it('should handle 42-byte script at maximum length boundary', () => {
        // OP_2 (0x52) + push 40 + 40 bytes data = 42 total
        const script = Buffer.concat([Buffer.from([0x52, 0x28]), Buffer.alloc(40, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), true)
    })

    // 3 bytes: below minimum
    it('should reject 3-byte script (below minimum)', () => {
        const script = Buffer.from([0x52, 0x01, 0xaa])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    // 43 bytes: above maximum
    it('should reject 43-byte script (above maximum)', () => {
        const script = Buffer.concat([Buffer.from([0x52, 0x29]), Buffer.alloc(41, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    // Version byte 0x51 (OP_1 / taproot): just below future segwit range
    it('should reject version byte 0x51 (OP_1 taproot, not future segwit)', () => {
        const script = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xcc)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })
})

describe('Boundary: isFutureSegwitScript additional edge cases', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    // Version byte 0x61 (just above OP_16 range)
    it('should reject version byte 0x61 (above OP_16)', () => {
        const script = Buffer.concat([Buffer.from([0x61, 0x14]), Buffer.alloc(20, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    // Push length 1 (below minimum witness program)
    it('should reject push length 1 (below minimum witness program size)', () => {
        const script = Buffer.from([0x52, 0x01, 0xaa])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    // Push length 41 (above maximum witness program)
    it('should reject push length 41 (above maximum witness program size)', () => {
        const script = Buffer.concat([Buffer.from([0x52, 0x29]), Buffer.alloc(41, 0xaa)])
        assert.strictEqual(decoder.isFutureSegwitScript(script), false)
    })

    // Empty buffer
    it('should reject empty buffer', () => {
        assert.strictEqual(decoder.isFutureSegwitScript(Buffer.alloc(0)), false)
    })
})
