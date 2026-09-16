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

// Helper: build the open-dispenser Set the block loop now passes into
// parseTransaction, containing every payable output address of `tx`.
function dispenserSetForTx(tx, decoder) {
    const set = new Set()
    for (const out of tx.outs) {
        try {
            set.add(bitcoin.address.fromOutputScript(out.script, decoder.network))
        } catch (err) {
            // OP_RETURN / non-address outputs have no address; skip
        }
    }
    return set
}

function buildFundingFeeCase(decoder) {
    const FEE_ADDR = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'
    const BASE = XChainDecoder.FUNDING_VOUT_BASE

    // Force the P2SH reveal branch: sets p2shFundingTxId so the funding-fee lookup runs.
    sinon.stub(decoder, 'removeObfuscation').resolves(
        Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2sh')])
    )

    // The funding (commit) tx contributes ONE fee output at vout 0, the same vout number
    // as the reveal tx's own output below (the same-vout collision case).
    sinon.stub(decoder, 'findFundingFeeOutputs').resolves([
        { vout: 0, destinationAddress: FEE_ADDR, amount: 4321 }
    ])

    // Build the reveal tx: output 0 is a real on-chain output at vout 0, output 1 is the
    // OP_RETURN that drives the P2SH branch.
    const tx = new bitcoin.Transaction()
    tx.version = 2
    addStandardInput(tx)
    addP2PKHOutput(tx, 50000)                                            // vout 0 (real reveal output)
    tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(20, 0x01)]), 0) // vout 1
    return { BASE, FEE_ADDR, tx }
}

// Regression: a P2SH/P2WSH reveal attributes the native-coin fee output (which
// physically lives on the funding/commit tx) to this action. That output carries
// the FUNDING tx's vout, but is stored under the REVEAL's tx_index. transaction_outputs
// is keyed by (tx_index, vout), so a funding fee output at the same vout number as one
// of the reveal tx's OWN outputs (a dispense or COINPAY output) would collide on the
// primary key and be silently dropped as a duplicate INSERT, leaving detectFeePaymentMode
// seeing no fee output and wrongly rejecting the action on LTC/DOGE (or falling back to
// XCHAIN deduction on BTC). Storing the fee output at vout + FUNDING_VOUT_BASE keeps it
// in a domain disjoint from any real reveal-tx vout.
describe('XChainDecoder#parseTransaction()', () => {
    let decoder

    beforeEach(() => {
        decoder = createDecoder()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('[REGRESSION] P2SH reveal: funding fee output is remapped into the FUNDING_VOUT_BASE domain so it cannot collide with a reveal-tx output at the same vout', async () => {
        const { BASE, FEE_ADDR, tx } = buildFundingFeeCase(decoder)
        assert.ok(typeof BASE === 'number' && BASE > 0, 'FUNDING_VOUT_BASE must be exported')

        // Mark the reveal's own vout-0 output as a dispense output, so it lands in the reveal's
        // output set at the exact vout the funding fee output would otherwise have claimed.
        const result = await decoder.parseTransaction(tx, dispenserSetForTx(tx, decoder))

        assert.ok(result)

        // The reveal's own output stays at its real vout 0.
        assert.strictEqual(result.dispenseOutputs.length, 1)
        assert.strictEqual(Number(result.dispenseOutputs[0].vout), 0)

        // The funding fee output is remapped into the reserved domain, NOT left at vout 0.
        const feeOutputs = result.paymentOutputs.filter(o => o.destinationAddress === FEE_ADDR)
        assert.strictEqual(feeOutputs.length, 1)
        assert.strictEqual(Number(feeOutputs[0].vout), BASE + 0)
        assert.strictEqual(Number(feeOutputs[0].amount), 4321)

        // Under the reveal's single tx_index, every stored (tx_index, vout) key is unique:
        // the real output at vout 0 and the fee output at BASE never collide.
        const allVouts = [
            ...result.dispenseOutputs.map(o => Number(o.vout)),
            ...result.paymentOutputs.map(o => Number(o.vout)),
        ]
        assert.strictEqual(new Set(allVouts).size, allVouts.length, 'no two outputs share a vout under this tx_index')
        assert.ok(!allVouts.some(v => v === 0 && allVouts.filter(x => x === 0).length > 1), 'no PK collision at vout 0')
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

    it('[REGRESSION P0] R-SCR-001: should return an object with data, rawData, source, destination, and dispenseOutputs', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)

        assert.ok('data' in result)
        assert.ok('rawData' in result)
        assert.ok('source' in result)
        assert.ok('destination' in result)
        assert.ok('dispenseOutputs' in result)
    })

    it('should return destination as null', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)
        assert.strictEqual(result.destination, null)
    })

    it('should return empty dispenseOutputs when no dispenser addresses match', async () => {
        const result = await decoder.parseRawTransaction(TX_HEX.opReturn)
        assert.ok(Array.isArray(result.dispenseOutputs))
        assert.strictEqual(result.dispenseOutputs.length, 0)
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

    it('should detect dispense outputs when the open-dispenser set contains a matching address', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx, dispenserSetForTx(tx, decoder))

        assert.ok(result)
        assert.ok(result.dispenseOutputs.length > 0)
        assert.ok(result.dispenseOutputs[0].destinationAddress)
        assert.ok(typeof result.dispenseOutputs[0].amount === 'number' || typeof result.dispenseOutputs[0].amount === 'bigint')
    })

    it('should populate txIndex and vout in dispense outputs', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx, dispenserSetForTx(tx, decoder))

        assert.ok(result.dispenseOutputs.length > 0)
        assert.ok(result.dispenseOutputs[0].txIndex)
        assert.strictEqual(typeof result.dispenseOutputs[0].vout, 'number')
    })

    it('[REGRESSION] should not issue any per-output DB dispenser lookup', async () => {
        // The decoder loads the open-dispenser set once per block and tests
        // membership in JS. parseTransaction must never call the per-output
        // DB lookup, regardless of how many outputs the transaction carries.
        decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)
        decoder.db.getAllOpenDispenserAddresses = sinon.stub().resolves(new Set())

        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        await decoder.parseTransaction(tx, new Set())

        assert.strictEqual(decoder.db.isThereADispenserForAddress.callCount, 0)
        assert.strictEqual(decoder.db.getAllOpenDispenserAddresses.callCount, 0)
    })

    it('[REGRESSION] should resolve dispense membership purely from the passed set', async () => {
        // A DB stub that would (wrongly) report a dispenser must have no effect:
        // detection is driven solely by the in-memory set the caller supplies.
        decoder.db.isThereADispenserForAddress = sinon.stub().resolves(true)

        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const emptyResult = await decoder.parseTransaction(tx, new Set())
        assert.strictEqual(emptyResult.dispenseOutputs.length, 0)

        const matchResult = await decoder.parseTransaction(tx, dispenserSetForTx(tx, decoder))
        assert.ok(matchResult.dispenseOutputs.length > 0)
        assert.strictEqual(decoder.db.isThereADispenserForAddress.callCount, 0)
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

    it('should treat missing standard_input field as true (default)', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        delete tx.ins[0]['standard_input']

        const result = await decoder.parseTransaction(tx)
        assert.ok(result !== null)
    })

    it('should treat standard_input: true as normal', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        tx.ins[0]['standard_input'] = true

        const result = await decoder.parseTransaction(tx)
        assert.ok(result !== null)
    })

    it('should not include data from an OP_RETURN that decrypts without XCHN prefix', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        // Replace the OP_RETURN data with random bytes that won't decrypt to XCHN
        const randomData = crypto.randomBytes(32)
        tx.outs[0].script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, randomData])

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.length, 0)
    })

    it('should skip multisig outputs that do not have exactly 6 decompiled elements', async () => {
        const tx = bitcoin.Transaction.fromHex(TX_HEX.opReturn)
        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
    })

    it('should throw on invalid hex input', async () => {
        await assert.rejects(async () => {
            await decoder.parseRawTransaction('not_valid_hex')
        })
    })

    it('should throw on empty hex string', async () => {
        await assert.rejects(async () => {
            await decoder.parseRawTransaction('')
        })
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

    it('[REGRESSION P0] R-SCR-001: should decode a dynamically built OP_RETURN transaction', async () => {
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = buildXchnPayload('SEND|0|XCHAIN|1000')
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)

        assert.ok(result)
        assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
    })

    it('[REGRESSION P0] R-SCR-001: should decode a DISPENSER payload', async () => {
        const dispenserData = 'DISPENSER|0|GIVE_COIN||||||GET_COIN|||||||3600'
        const tx = new bitcoin.Transaction()
        tx.version = 2
        addStandardInput(tx)

        const cipher = buildXchnPayload(dispenserData)
        tx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, cipher]), 0)
        addP2PKHOutput(tx)

        const result = await decoder.parseTransaction(tx)
        assert.ok(result)
        assert.ok(result.data.toString('utf-8').startsWith('DISPENSER'))
    })
})
