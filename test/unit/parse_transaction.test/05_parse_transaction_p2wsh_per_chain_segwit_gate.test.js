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

const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')
const WITNESS_PAYLOAD = Buffer.from('witness-carrier-payload')

function addP2PKHOutput(tx, value) {
    tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), value || 100000000)
}

function decoderFor(network) {
    const decoder = new XChainDecoder(
        network, null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = { isThereADispenserForAddress: sinon.stub().resolves(false) }
    decoder.connector = { getRawTransaction: sinon.stub().rejects(new Error('mocked')) }
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    // The chunk lanes set p2shFundingTxId, which drives a commit fetch this
    // test is not about. Stubbed on BOTH decoders so the only difference
    // between them stays the chain.
    sinon.stub(decoder, 'findFundingFeeOutputs').resolves([])
    sinon.stub(decoder, 'removeObfuscation').resolves(
        Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2wsh')])
    )
    return decoder
}

// One well-formed witness carrier: a 3-element stack whose third element
// decompiles to a single payload push, which is exactly what the extraction
// path reads. Byte-identical for both chains.
function witnessCarrierTx() {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(PREV_HASH, 1)
    tx.ins[0].witness = [
        Buffer.alloc(72, 0x30),
        Buffer.alloc(33, 0x02),
        // The extraction reads decompile(witness[2])[0] as this input's chunk,
        // and the reassembled chunks are themselves decompiled as the action
        // stream, so the carried chunk is a COMPILED push inside one more push.
        bitcoin.script.compile([bitcoin.script.compile([WITNESS_PAYLOAD])])
    ]
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(8, 0xAB)]), 0)
    addP2PKHOutput(tx)
    return tx
}

// Per-chain capability gate on the P2WSH witness carrier.
//
// The branch recognized the XCHNp2wsh marker and read payload out of
// transaction.ins[i].witness[2] on any chain, consulting only the witness stack's
// SHAPE. On a chain that declares no segwit the lane relied entirely on upstream
// node validation to keep witness data from ever arriving, while the sibling
// taproot envelope lane has carried an explicit per-chain gate all along.
//
// The BTC case is the control that makes the DOGE case mean something: the same
// bytes, the same stubs, the same helper, and the only difference is the chain.
// Without it a blanket disable of the whole P2WSH lane would look identical.
describe('XChainDecoder#parseTransaction() P2WSH per-chain segwit gate', () => {
    afterEach(() => {
        sinon.restore()
    })

    it('a segwit chain still extracts the witness payload (control)', async () => {
        const decoder = decoderFor('bitcoin-regtest')
        const result = await decoder.parseTransaction(witnessCarrierTx())

        assert.ok(result, 'the witness carrier must still produce an action on a segwit chain')
        assert.strictEqual(result.data.toString('utf-8'), WITNESS_PAYLOAD.toString('utf-8'))
    })

    it('a non-segwit chain extracts nothing from the same bytes and does not throw', async () => {
        const decoder = decoderFor('dogecoin-regtest')
        const result = await decoder.parseTransaction(witnessCarrierTx())

        const extracted = result && result.data ? result.data : Buffer.alloc(0)
        assert.strictEqual(extracted.length, 0,
            'a chain declaring supportsSegwit:false must read no payload out of a witness stack')
    })

    it('the gate is chain capability, not a parse error: the non-segwit chain records none', async () => {
        const decoder = decoderFor('dogecoin-regtest')
        const before = decoder.parseErrors
        await decoder.parseTransaction(witnessCarrierTx())
        assert.strictEqual(decoder.parseErrors, before,
            'skipping an impossible carrier is not a malformed-transaction event')
    })
})
