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
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

function buildActionTx(actionString) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    addStandardInput(tx)
    const cipher = buildXchnPayload(actionString)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
    addP2PKHOutput(tx)
    return tx
}

describe('Boundary: Combinatorial DISPENSER Scenarios', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    // Combo 4: DISPENSER data + source address resolution failure
    it('DISPENSER payload but getSourceFromOutput returns null: tx skipped', async () => {
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))

        const action = 'DISPENSER|0|BTC|JDOG|1|10|LTC||0.01|addr|||3600|||'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.ok(result.data.length > 0)
        // source is null because getSourceFromOutput failed
        assert.strictEqual(result.source, null)
        // The block-processing loop stores a tx only when data.length > 0 AND source
        // is non-null, so this one is skipped and no DISPENSER is created.
    })

    // Combo 5: BATCH string with DISPENSER as non-first command
    it('BATCH with DISPENSER as second command: decoder does not parse it', async () => {
        const action = 'SEND|0|BTC|100;DISPENSER|0|BTC|||LTC||||addr|||3600|||'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        // The full BATCH string is stored. startsWith("DISPENSER") is false
        // because the string starts with "SEND".
        assert.ok(!decoded.startsWith('DISPENSER'))
        assert.ok(decoded.includes('DISPENSER'))
        // The decoder does NOT create a dispenser for BATCH-embedded DISPENSERs.
    })

    // Combo: DISPENSER as first command in a BATCH (should be caught)
    it('BATCH with DISPENSER as first command: decoder does parse it', async () => {
        const action = 'DISPENSER|0|BTC|||||LTC|||addr||||3600|||;SEND|0|BTC|100'
        const tx = buildActionTx(action)
        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        const decoded = result.data.toString('utf-8')
        // startsWith("DISPENSER") is true
        assert.ok(decoded.startsWith('DISPENSER'))
        // But the split on "|" will include the ";SEND|0|BTC|100" in later fields
        // This could pollute the expiration and other fields
        const split = decoded.split('|')
        // EXPIRATION lives at index 14 in the current layout
        assert.strictEqual(split[14], '3600')
    })
})
