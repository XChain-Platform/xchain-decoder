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
const sinon  = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const ecc    = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')

bitcoin.initEccLib(ecc)

// ─── helpers ────────────────────────────────────────────────────────────────
function createDecoder(feeDestination) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', 3306, 'db', 'u', 'p',
        '127.0.0.1', 18443, 'rpc', 'rpc', false, feeDestination || null
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAddressId:   sinon.stub().resolves(null),
        hasPubkey:      sinon.stub().resolves(false),
        insertPubkey:   sinon.stub().resolves(true),
    }
    decoder.connector = {
        getRawTransaction: sinon.stub().rejects(new Error('mocked'))
    }
    // A failed prevout lookup now throws (tagged rpcLookupFailure) instead of
    // resolving a null source; stub source resolution to the deterministic
    // null the parse-focused tests rely on. findFundingFeeOutputs tests call
    // that method directly, so this stub does not shadow them.
    decoder.getSourceFromOutput = sinon.stub().resolves(null)
    return decoder
}

// Build a tx whose first input's hash is PREV_HASH (same convention used in parseTransaction.test.js)
const PREV_HASH = Buffer.from('aabbccdd11223344eeff5566778899001122334455667788aabbccddeeff0011', 'hex')

// ─── findFundingFeeOutputs ───────────────────────────────────────────────────
describe('XChainDecoder#findFundingFeeOutputs()', () => {
    const FEE_ADDR = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'  // regtest-style, not real

    afterEach(() => { sinon.restore() })

    it('should return [] when feeDestination is null (disabled)', async () => {
        const decoder = createDecoder(null)
        const result = await decoder.findFundingFeeOutputs('anytxid')
        assert.deepStrictEqual(result, [])
    })

    it('should return [] when fundingTxId is null', async () => {
        const decoder = createDecoder(FEE_ADDR)
        const result = await decoder.findFundingFeeOutputs(null)
        assert.deepStrictEqual(result, [])
    })

    it('should throw a tagged rpcLookupFailure when getRawTransaction throws (fee presence must not depend on RPC health)', async () => {
        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().rejects(new Error('not found'))
        await assert.rejects(
            () => decoder.findFundingFeeOutputs('sometxid'),
            (err) => err.rpcLookupFailure === true
        )
        assert.strictEqual(decoder.rpcErrors, 1)
    })

    it('should throw a tagged rpcLookupFailure when getRawTransaction returns null (a confirmed funding tx always exists)', async () => {
        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().resolves(null)
        await assert.rejects(
            () => decoder.findFundingFeeOutputs('sometxid'),
            (err) => err.rpcLookupFailure === true
        )
    })

    it('should return [] when no output matches feeDestination', async () => {
        // Build a simple tx with a P2PKH output to a non-fee address
        const tx = new bitcoin.Transaction()
        tx.version = 2
        tx.addInput(PREV_HASH, 0)
        // P2PKH output with all-0xaa hash (decodes to some address, but not FEE_ADDR)
        tx.addOutput(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex'), 50000)

        const decoder = createDecoder(FEE_ADDR)
        decoder.connector.getRawTransaction = sinon.stub().resolves(tx.toHex())

        const result = await decoder.findFundingFeeOutputs('sometxid')
        assert.deepStrictEqual(result, [])
    })
})
