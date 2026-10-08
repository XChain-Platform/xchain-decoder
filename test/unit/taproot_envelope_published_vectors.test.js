/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const bitcoin = require('bitcoinjs-lib')
const { createDecoder } = require('./taproot_envelope.test/helpers/taproot_envelope.js')

const CHUNK_SIZE = 520
const CHUNKING_RECIPE = 'action "FILE|0|chunks.bin|application/octet-stream|||||||" '
    + '+ 1200 rawData bytes where byte[i] = (i*7+13) & 0xff'
const REBALANCE_RECIPE = 'action "FILE|0|rebalance.bin|application/octet-stream|||||||" '
    + '+ 985 rawData bytes where byte[i] = (i*7+13) & 0xff for i < 984 and byte[984] = 0x07'

function sha256(buf){
    return crypto.createHash('sha256').update(buf).digest('hex')
}

function generatedRawData(length, finalByte){
    const rawData = Buffer.alloc(length)
    for (let i = 0; i < length; i++) rawData[i] = (i * 7 + 13) & 0xff
    if (finalByte !== undefined) rawData[length - 1] = finalByte
    return rawData
}

function compiledPayload(action, rawData){
    return bitcoin.script.compile([Buffer.from(action, 'utf8'), rawData])
}

function envelopeChunks(payload){
    const chunks = []
    for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE){
        chunks.push(payload.subarray(offset, offset + CHUNK_SIZE))
    }
    const last = chunks[chunks.length - 1]
    if (chunks.length >= 2 && last.length === 1
        && ((last[0] >= 0x01 && last[0] <= 0x10) || last[0] === 0x81)){
        const previous = chunks[chunks.length - 2]
        chunks[chunks.length - 2] = previous.subarray(0, previous.length - 1)
        chunks[chunks.length - 1] = Buffer.concat([previous.subarray(previous.length - 1), last])
    }
    return chunks
}

function envelopeScript(payload, xonlyHex){
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_0,
        bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN'),
        Buffer.from([0x00]),
        ...envelopeChunks(payload),
        bitcoin.opcodes.OP_ENDIF,
        Buffer.from(xonlyHex, 'hex'),
        bitcoin.opcodes.OP_CHECKSIG
    ])
}

function assertPublishedRecognition(decoder, vectors, vector, payload){
    const chunks = envelopeChunks(payload)
    const script = envelopeScript(payload, vectors.envelope_grammar.internal_pubkey_xonly)
    const controlBlock = Buffer.from(vectors.envelope_grammar.control_block_hex, 'hex')

    assert.equal(payload.length, vector.compiled_payload_length)
    assert.equal(sha256(payload), vector.compiled_payload_sha256)
    assert.deepEqual(chunks.map(chunk => chunk.length), vector.push_lengths)
    if (vector.envelope_script_length !== undefined) assert.equal(script.length, vector.envelope_script_length)
    assert.equal(sha256(script), vector.envelope_script_sha256)

    const recognized = decoder.detectEnvelopeWitness([Buffer.alloc(64), script, controlBlock])
    assert.ok(recognized, 'published envelope script was not recognized')
    assert.deepEqual(recognized.script, script)
    assert.deepEqual(recognized.payload, payload)
}

describe('Taproot envelope published chunk vectors', function () {
    let vectors
    let decoder

    before(function () {
        if (!process.env.TAPROOT_VECTORS_FILE) this.skip()
        vectors = JSON.parse(fs.readFileSync(process.env.TAPROOT_VECTORS_FILE, 'utf8'))
        decoder = createDecoder()
    })

    it('recognizes and reassembles the published envelope_chunking vector', function () {
        const vector = vectors.envelope_chunking
        assert.equal(vector.payload_generation, CHUNKING_RECIPE)
        const payload = compiledPayload(
            'FILE|0|chunks.bin|application/octet-stream|||||||',
            generatedRawData(1200)
        )

        assertPublishedRecognition(decoder, vectors, vector, payload)
    })

    it('recognizes and reassembles the published chunk_rebalance vector', function () {
        const vector = vectors.chunk_rebalance
        assert.equal(vector.payload_generation, REBALANCE_RECIPE)
        const payload = compiledPayload(
            'FILE|0|rebalance.bin|application/octet-stream|||||||',
            generatedRawData(985, 0x07)
        )

        assert.equal(payload.length % CHUNK_SIZE, 1)
        assert.equal(payload[payload.length - 1], 0x07)
        assertPublishedRecognition(decoder, vectors, vector, payload)
    })
})
