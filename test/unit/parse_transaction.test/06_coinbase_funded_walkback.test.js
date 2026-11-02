// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A source walk-back that reaches a coinbase has no funding output to fetch: the
// coinbase input's prevout is the all-zero txid, which no node returns. The throw
// must carry no rpcLookupFailure tag, so the block loop's retry-then-quarantine
// ladder handles it instead of retrying the height forever on every instance.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

const ZERO_TXID = '0'.repeat(64)

function createDecoder(network = 'bitcoin-regtest') {
    const decoder = new XChainDecoder(
        network, null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    // The connector answers a zero-txid lookup with null, as it does on RPC -5.
    decoder.connector = {
        getRawTransaction: sinon.stub().callsFake(async (txid) => (txid === ZERO_TXID ? null : coinbaseHex))
    }
    return decoder
}

// A coinbase paying the given scripts: one input on the all-zero prevout.
function coinbaseWithOutputs(scripts) {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from('0151', 'hex'))
    for (const script of scripts) tx.addOutput(script, 0)
    return tx
}

const P2SH_SCRIPT = Buffer.from('a914' + 'aa'.repeat(20) + '87', 'hex')
const P2WSH_SCRIPT = Buffer.from('0020' + 'bb'.repeat(32), 'hex')
const coinbaseTx = coinbaseWithOutputs([P2SH_SCRIPT, P2WSH_SCRIPT])
const coinbaseHex = coinbaseTx.toHex()

function assertUntaggedAndNoZeroLookup(decoder, err) {
    assert.ok(err instanceof Error)
    assert.notStrictEqual(err.rpcLookupFailure, true, 'a coinbase walk-back is content, not an RPC fault')
    assert.ok(!decoder.connector.getRawTransaction.calledWith(ZERO_TXID), 'the all-zero txid must never be fetched')
    return true
}

describe('XChainDecoder source walk-back that reaches a coinbase', () => {
    afterEach(() => {
        sinon.restore()
    })

    it('a P2SH carrier output paid by a coinbase throws untagged without fetching the zero txid', async () => {
        const decoder = createDecoder()
        await assert.rejects(
            () => decoder.getSourceFromOutput(coinbaseTx.getId(), 0, null, 200),
            (err) => assertUntaggedAndNoZeroLookup(decoder, err)
        )
    })

    it('a P2WSH carrier output paid by a coinbase throws untagged without fetching the zero txid', async () => {
        const decoder = createDecoder()
        await assert.rejects(
            () => decoder.getSourceFromOutput(coinbaseTx.getId(), 1, null, 200),
            (err) => assertUntaggedAndNoZeroLookup(decoder, err)
        )
    })

    it('an envelope whose commit is a coinbase throws untagged without fetching the zero txid', async () => {
        const decoder = createDecoder()
        await assert.rejects(
            () => decoder.getEnvelopeSourceFromCommit(coinbaseTx),
            (err) => assertUntaggedAndNoZeroLookup(decoder, err)
        )
    })

    it('a real funding lookup failure is still tagged for the block retry', async () => {
        const decoder = createDecoder()
        const spender = new bitcoin.Transaction()
        spender.version = 2
        spender.addInput(Buffer.alloc(32, 0x11), 0)
        spender.addOutput(P2SH_SCRIPT, 0)
        decoder.connector.getRawTransaction = sinon.stub()
        decoder.connector.getRawTransaction.onFirstCall().resolves(spender.toHex())
        decoder.connector.getRawTransaction.onSecondCall().resolves(null)
        await assert.rejects(
            () => decoder.getSourceFromOutput(spender.getId(), 0, null, 200),
            (err) => err.rpcLookupFailure === true
        )
    })
})
