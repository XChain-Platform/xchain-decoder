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

// The decoder derives AES key/IV from the reversed hex of the first input's prevout hash.
// All test txs use the same prevout hash for simplicity.
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

// Build encrypted XCHN payload. The data after XCHN prefix must be a compiled bitcoin script.
function buildXchnPayload(data, rawData) {
    const parts = [Buffer.from(data)]
    if (rawData) parts.push(Buffer.from(rawData))
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

// Pre-built transaction hex strings (verified to decode correctly)
const TX_HEX = {
    opReturn: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000',
    opReturnWithRaw: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000226a205ed141846cc8c7e76787783472e71ffb177e0eda0d24b8406eccc9cd4be35b1000e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000',
    // Genuine AES-128-CTR encryption of "XCHN" + compile(["Multisig data"]) padded
    // to a full 64-byte chunk (matches real encoder output: the zero-padding is
    // applied to the plaintext before encryption, so it decrypts back to 0x00 / OP_0
    // and is harmlessly ignored by bitcoin.script.decompile at reassembly).
    multisig: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff02e803000000000000695121025ed141846dc8d3e27dce7b3c6cab14fb07115cbb7a04d9341aadaaa5268635642102e71ca15723d902414e2d1eabfe0fbd6380eb928110bbec51127fce0de72f14652103030303030303030303030303030303030303030303030303030303030303030353ae00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
}

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
    // A failed prevout lookup now throws (tagged rpcLookupFailure) instead of
    // resolving a null source, so parse-focused tests stub source resolution to
    // the deterministic null it used to observe. The getSourceFromOutput suite
    // deletes this own-property stub to exercise the real method.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('[REGRESSION P0] R-SCR-001: should return null for a coinbase transaction', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0].hash = Buffer.alloc(32, 0)

        const result = await decoder.parseTransaction(tx)
        assert.strictEqual(result, null)
    })

    // A source that index_addresses has never seen gets no id until
    // db.insertTransaction allocates one, so the opportunistic write inside
    // parseTransaction cannot fire. The key must still leave the parser, or the block
    // that exposed it records source_pubkey NULL forever.
    it('carries a first-ever source pubkey out of the parser even though no address id exists yet', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        decoder.getSourceFromOutput = sinon.stub().resolves('bcrt1qneverseen')
        decoder.extractPubkeyFromInput = sinon.stub().returns('02aabb')
        decoder.db.getAddressId = sinon.stub().resolves(null)
        decoder.db.hasPubkey    = sinon.stub().resolves(false)
        decoder.db.insertPubkey = sinon.stub().resolves(true)

        const result = await decoder.parseTransaction(tx, undefined, decoder.db)

        assert.ok(result)
        assert.strictEqual(result.sourcePubkey, '02aabb')
        assert.ok(decoder.db.insertPubkey.notCalled, 'the parser must not allocate a lookup id to write it here')
    })

    it('leaves sourcePubkey null when the input exposes no key', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        decoder.getSourceFromOutput = sinon.stub().resolves('bcrt1qneverseen')
        decoder.extractPubkeyFromInput = sinon.stub().returns(null)
        decoder.db.getAddressId = sinon.stub().resolves(null)

        const result = await decoder.parseTransaction(tx, undefined, decoder.db)

        assert.ok(result)
        assert.strictEqual(result.sourcePubkey, null)
    })

    it('should return null when standard_input is false', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0]['standard_input'] = false

        const result = await decoder.parseTransaction(tx)
        assert.strictEqual(result, null)
    })
})

describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('[REGRESSION P0] R-SCR-001: should decode an OP_RETURN transaction with XCHN payload', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.ok(result)
        assert.ok(result.data.length > 0)
        assert.strictEqual(result.data.toString('utf-8'), 'Small data test')
    })

    it('should decode OP_RETURN with data and rawData', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturnWithRaw)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'Main payload')
        assert.ok(result.rawData)
        assert.strictEqual(result.rawData.toString('utf-8'), 'Raw attachment')
    })

    it('should return null rawData when there is only one script push', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.strictEqual(result.rawData, null)
    })

    it('should return empty data for a transaction with no XChain-relevant outputs', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        // Remove the OP_RETURN output, keep only the P2PKH
        tx.outs = [tx.outs[1]]

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
        assert.strictEqual(result.dispenseOutputs.length, 0)
    })

    it('[REGRESSION P0] R-SCR-004: should decode a 1-of-3 multisig transaction', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.multisig)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'Multisig data')
    })

    it('should strip trailing zeros from multisig payload', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.multisig)
        const data = result.data

        assert.notStrictEqual(data[data.length - 1], 0)
    })
})
