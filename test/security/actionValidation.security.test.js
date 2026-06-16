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
const XChainDecoder = require('../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

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

function buildXchnPayload(data) {
    const scriptPayload = bitcoin.script.compile([Buffer.from(data)])
    const plainBuf = Buffer.concat([Buffer.from('XCHN'), scriptPayload])
    return encryptBuf(plainBuf)
}

function buildTxWithPayload(payloadStr) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

    const cipher = buildXchnPayload(payloadStr)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)
    return tx
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

describe('Security: ACTION Data Validation', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // --- SEC-02/03: Post-decryption ACTION validation ---

    describe('Valid ACTION names', () => {
        const validActions = [
            'SEND|0|XCHAIN|1000',
            'ISSUE|0|MYTOKEN|1000000',
            'DESTROY|0|MYTOKEN|500',
            'DISPENSER|0|GIVE||||||GET|||||||3600',
            'BROADCAST|0|Hello world',
            'SWEEP|0|destination_addr',
            'ORDER|0|GIVE_TOKEN|GET_TOKEN|1000|500',
            'DIVIDEND|0|MYTOKEN|XCHAIN|1000',
            'MINT|0|MYTOKEN|1000',
            'BATCH|0|SEND|0|TOKEN|100;SEND|0|TOKEN2|200'
        ]

        for (const action of validActions) {
            it(`[REGRESSION P0] R-ACT-001: should accept valid ACTION: ${action.split('|')[0]}`, async () => {
                const tx = buildTxWithPayload(action)
                const result = await decoder.parseTransaction(tx)

                assert.ok(result)
                assert.ok(result.data.length > 0, 'Should have decoded data')
                assert.ok(result.data.toString('utf-8').startsWith(action.split('|')[0]))
            })
        }
    })

    describe('Invalid ACTION names', () => {
        it('[REGRESSION P0] R-ACT-002: should still decode raw data even with unknown ACTION name', async () => {
            // The decoder stores whatever passes the XCHN check at parse level,
            // the ACTION name validation happens at the block-processing level.
            // At parseTransaction level, data is returned regardless.
            const tx = buildTxWithPayload('FAKECMD|0|payload')
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            // Data should be present in result (parseTransaction doesn't validate ACTION names)
            assert.ok(result.data.length > 0)
        })
    })

    // --- SEC-03: Oversized payloads ---

    describe('Payload size limits', () => {
        it('[REGRESSION P0] R-ACT-003: should parse a payload under MAX_ACTION_DATA_LENGTH', async () => {
            const payload = 'SEND|0|XCHAIN|' + '1'.repeat(1000)
            const tx = buildTxWithPayload(payload)
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            assert.ok(result.data.length > 0)
        })

        it('[REGRESSION P0] R-ACT-003: parseResult.compiledDataLength reflects on-chain payload size, not the post-decompile length', async () => {
            // bitcoin.script.decompile strips the OP_PUSHDATA prefix (1-3 bytes depending on
            // payload size). The MAX_ACTION_DATA_LENGTH guard must compare against the on-chain
            // compiled size, otherwise compiled payloads of 8193-8195 bytes silently pass.
            const payload = 'SEND|0|XCHAIN|' + '1'.repeat(1000)
            const tx = buildTxWithPayload(payload)
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            assert.strictEqual(typeof result.compiledDataLength, 'number')
            assert.ok(
                result.compiledDataLength > result.data.length,
                `compiledDataLength (${result.compiledDataLength}) should exceed decompiled data.length (${result.data.length}) by the OP_PUSHDATA overhead`
            )
        })
    })

    // --- SEC-12: UTF-8 handling ---

    describe('UTF-8 data handling', () => {
        it('[REGRESSION P0] R-ACT-004: should decode valid ASCII ACTION data', async () => {
            const tx = buildTxWithPayload('SEND|0|XCHAIN|1000')
            const result = await decoder.parseTransaction(tx)

            assert.ok(result)
            const decoded = result.data.toString('utf-8')
            assert.strictEqual(decoded, 'SEND|0|XCHAIN|1000')
        })
    })

    // --- P2SH/P2WSH bounds safety (SEC-05) ---

    describe('P2SH input bounds safety', () => {
        it('[REGRESSION P0] R-ACT-005: should not crash on a P2SH marker with empty scriptSig inputs', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = Buffer.alloc(0) // empty scriptSig

            const p2shPlain = Buffer.from('XCHNp2sh')
            const p2shCipher = encryptBuf(p2shPlain)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, p2shCipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            // Should not crash, data may be empty since P2SH extraction will skip
            assert.strictEqual(result.data.length, 0)
        })

        it('[REGRESSION P0] R-ACT-005: should not crash on a P2SH marker with a short scriptSig (fewer than 3 elements)', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            // scriptSig with only 1 push (not the 3 expected)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(33, 0x02)])

            const p2shPlain = Buffer.from('XCHNp2sh')
            const p2shCipher = encryptBuf(p2shPlain)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, p2shCipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
        })
    })

    describe('P2WSH input bounds safety', () => {
        it('[REGRESSION P0] R-ACT-005: should not crash on a P2WSH marker with missing witness data', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            tx.ins[0].witness = [] // empty witness

            const p2wshPlain = Buffer.from('XCHNp2wsh')
            const p2wshCipher = encryptBuf(p2wshPlain)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, p2wshCipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
        })

        it('should not crash on a P2WSH marker with short witness (fewer than 3 elements)', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            tx.ins[0].witness = [Buffer.alloc(10)] // only 1 element instead of 3

            const p2wshPlain = Buffer.from('XCHNp2wsh')
            const p2wshCipher = encryptBuf(p2wshPlain)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, p2wshCipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
        })

        it('should not crash on a P2WSH marker with non-Buffer witness element at index 2', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            tx.ins[0].witness = [Buffer.alloc(10), Buffer.alloc(10), 'not a buffer']

            const p2wshPlain = Buffer.from('XCHNp2wsh')
            const p2wshCipher = encryptBuf(p2wshPlain)
            tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, p2wshCipher]), 0)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
        })
    })

    // --- Multisig with non-Buffer elements ---

    describe('Multisig safety', () => {
        it('[REGRESSION P0] R-ACT-005: should skip multisig output when pubkey elements are not Buffers', async () => {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(PREV_HASH, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])

            // Build a 6-element script that looks like multisig but has non-Buffer pubkeys
            const fakeScript = Buffer.alloc(6)
            fakeScript[0] = bitcoin.opcodes.OP_1
            fakeScript[5] = bitcoin.opcodes.OP_CHECKMULTISIG
            // The decompiler will produce opcodes, not Buffers, for bytes 1-4
            tx.addOutput(fakeScript, 1000)
            tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 100000000)

            const result = await decoder.parseTransaction(tx)
            assert.ok(result)
            // Should not crash, data should be empty
            assert.strictEqual(result.data.length, 0)
        })
    })
})
