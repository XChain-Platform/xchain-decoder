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

// Pre-built transaction hex strings (verified to decode correctly)
const TX_HEX = {
    opReturn: '0200000001aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011010000006b4830303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303021020202020202020202020202020202020202020202020202020202020202020202ffffffff020000000000000000166a145ed141846fd6cbef65cb28316aff11ba07152fcf00e1f505000000001976a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac00000000'
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
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

describe('XChainDecoder#getSourceFromOutput()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
        // Exercise the real method, not the harness's null-source stub.
        delete decoder.getSourceFromOutput
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should throw a tagged rpcLookupFailure when the connector throws (a failed lookup is not a null source)', async () => {
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))

        await assert.rejects(
            () => decoder.getSourceFromOutput('deadbeef', 0),
            (err) => err.rpcLookupFailure === true
        )
    })

    it('should return null when output index is out of bounds', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 99)
        assert.strictEqual(result, null)
    })

    it('should return an address for a valid P2PKH output', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        // Output 1 is P2PKH
        const result = await decoder.getSourceFromOutput('sometxid', 1)
        assert.ok(result)
        assert.strictEqual(typeof result, 'string')
        assert.ok(result.length > 20, 'Address should be a non-trivial string')
    })
})

describe('XChainDecoder#getSourceFromOutput()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
        // Exercise the real method, not the harness's null-source stub.
        delete decoder.getSourceFromOutput
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should return null for OP_RETURN output (no valid address)', async () => {
        decoder.connector.getRawTransaction = sinon.stub().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 0)
        assert.strictEqual(result, null)
    })

    it('should chase P2SH outputs one level deeper', async () => {
        // Create a P2SH output script (23 bytes: OP_HASH160 PUSH20 <20 bytes> OP_EQUAL)
        const p2shScript = Buffer.alloc(23)
        p2shScript[0] = 0xa9   // OP_HASH160
        p2shScript[1] = 0x14   // PUSH 20 bytes
        p2shScript[22] = 0x87  // OP_EQUAL
        for (let i = 2; i < 22; i++) p2shScript[i] = 0xaa

        const outerTx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        outerTx.outs[1].script = p2shScript

        decoder.connector.getRawTransaction = sinon.stub()
        decoder.connector.getRawTransaction.onFirstCall().resolves(outerTx.toHex())
        decoder.connector.getRawTransaction.onSecondCall().resolves(TX_HEX.opReturn)

        const result = await decoder.getSourceFromOutput('sometxid', 1)
        // Should have chased one level
        assert.ok(decoder.connector.getRawTransaction.calledTwice)
    })
})
