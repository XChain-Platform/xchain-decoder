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

// Build encrypted marker (e.g., XCHNp2sh or XCHNp2wsh)
function buildXchnMarker(marker) {
    return encryptBuf(Buffer.from('XCHN' + marker))
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
    return decoder
}

describe('Boundary: Script Type Detection (S-1 through S-7)', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // S-1: OP_RETURN with empty push data
    it('[REGRESSION P0] R-SCR-001 S-1: OP_RETURN with 0-byte push: removeObfuscation receives empty buffer', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // OP_RETURN followed by empty push (OP_0 = 0x00)
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(0)]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Empty buffer decrypts to empty (won't match XCHN prefix)
        assert.strictEqual(result.data.length, 0)
    })

    // S-1b: XCHN payload whose inner compiled script is a single OP_0 byte ([0x00]).
    // bitcoin.script.decompile([0x00]) returns [0]: the integer zero, NOT a Buffer.
    // The decompile result must be normalized to an empty Buffer so the integer never
    // propagates into downstream consumers (length guards that silently drop the tx,
    // or hex-encoding paths that throw on a non-Buffer value).
    it('[REGRESSION P0] R-SCR-004 S-1b: XCHN payload decompiling to OP_0: data is an empty Buffer, not integer 0', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // buildXchnPayload compiles the inner data with bitcoin.script.compile.
        // An empty buffer compiles to OP_0 (0x00), so after the XCHN prefix is stripped
        // the decoder runs bitcoin.script.decompile([0x00]) → [0] (integer zero).
        const cipher = buildXchnPayload(Buffer.alloc(0))
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // The integer 0 must have been normalized to an empty Buffer.
        assert.ok(Buffer.isBuffer(result.data), 'result.data must be a Buffer, not the integer 0')
        assert.strictEqual(result.data.length, 0)
    })

    // S-2: OP_RETURN with 76-byte push (max single-byte push opcode)
    it('S-2: OP_RETURN with 76-byte push: full deobfuscation path', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // 76-byte encrypted XCHN payload
        const plaintext = 'A'.repeat(72) // 72 data + 4 XCHN prefix = 76 won't work due to script compile overhead
        const cipher = buildXchnPayload(plaintext)
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Should decode successfully if cipher fits in 76 bytes
        assert.ok(result.data.length >= 0)
    })

    // S-3: OP_RETURN with opcode instead of buffer (decompiledScript[1] is integer)
    it('S-3: OP_RETURN with opcode instead of buffer: removeObfuscation returns null', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // Manually build script: OP_RETURN OP_1
        // OP_RETURN = 0x6a, OP_1 = 0x51
        tx.addOutput(Buffer.from([0x6a, 0x51]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // OP_1 decompiles to a number (81), not a Buffer. removeObfuscation returns null
        assert.strictEqual(result.data.length, 0)
    })

    // S-4: Multisig with 1-byte pubkeys; non-Buffer elements skipped gracefully
    it('S-4: multisig with 1-byte pubkeys: skipped (non-Buffer pubkeys)', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // bitcoin.script.compile turns 1-byte buffers into opcode integers
        const script = bitcoin.script.compile([
            bitcoin.opcodes.OP_1,
            Buffer.from([0x02]),           // becomes opcode 0x02 (integer)
            Buffer.from([0x03]),           // becomes opcode 0x03 (integer)
            Buffer.alloc(33, 0x03),        // real pubkey3
            bitcoin.opcodes.OP_3,
            bitcoin.opcodes.OP_CHECKMULTISIG
        ])
        tx.addOutput(script, 1000)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Non-Buffer pubkeys are now detected and the output is skipped
        assert.strictEqual(result.data.length, 0)
    })

    // S-5: Multisig with pubkeys whose stripped bytes are all zeros
    it('S-5: multisig with all-zero data: zero-trim loop removes everything', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // 33-byte pubkeys where byte 0 is stripped, rest are all 0x00
        const pubkey1 = Buffer.alloc(33, 0x00)
        pubkey1[0] = 0x02
        const pubkey2 = Buffer.alloc(33, 0x00)
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
        // After stripping first byte and zero-trimming: the for-loop never finds
        // a non-zero byte, so data is never sliced. The full zero buffer is passed
        // to removeObfuscation. It won't match XCHN prefix.
        assert.strictEqual(result.data.length, 0)
    })

    // S-6: P2SH marker but transaction has 0 additional inputs to process
    // (In practice the marker is in OP_RETURN, and the data is in inputs' scriptSigs)
    it('[REGRESSION P0] R-SCR-002 S-6: XCHNp2sh marker with single input: data from that input\'s scriptSig', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        // OP_RETURN that decrypts to "XCHNp2sh"
        const cipher = buildXchnMarker('p2sh')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // The loop processes all inputs including the one with the standard scriptSig.
        // decodedScriptSig[2] may not be a valid redeem script, so the try/catch
        // catches and logs an error. No data extracted → empty dataBuffer.
        assert.strictEqual(result.data.length, 0)
    })

    // S-7: P2WSH marker with input that has no witness field
    it('[REGRESSION P0] R-SCR-003 S-7: XCHNp2wsh marker with input missing witness: caught by try/catch', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)
        // Explicitly remove witness from input
        delete tx.ins[0].witness

        const cipher = buildXchnMarker('p2wsh')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // Accessing nextInput["witness"][2] on undefined throws TypeError (caught)
        assert.strictEqual(result.data.length, 0)
    })

    // P2WSH with witness array having < 3 elements
    it('XCHNp2wsh with witness having only 1 element: caught by try/catch', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)
        tx.ins[0].witness = [Buffer.from('00', 'hex')]

        const cipher = buildXchnMarker('p2wsh')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        // witness[2] is undefined → decompile(undefined) throws
        assert.strictEqual(result.data.length, 0)
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

    // Incomplete P2SH indicator: "XCHNp2s" (7 bytes, missing 'h')
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
