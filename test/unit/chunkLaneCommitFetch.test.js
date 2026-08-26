/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Regression coverage for the P2SH/P2WSH chunk-carrier reveal lane: the commit
 * transaction must be fetched exactly ONCE per parseTransaction call.
 *
 * getSourceFromOutput fetches and parses the commit (ins[0]'s prevout) for source
 * attribution, and findFundingFeeOutputs then needs the same commit to attribute the
 * native-coin fee output. The Taproot-envelope lane already hands the parsed commit
 * over as prefetchedFundingTx; the chunk lanes used to re-fetch it through an uncached
 * connector carrying its own 10-attempt retry budget.
 */

'use strict'

const assert  = require('assert')
const sinon   = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const XChainDecoder = require('../../src/XChainDecoder')

const FEE_ADDR    = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'
const SOURCE_ADDR = 'mkHS9ne12qx9pS9VojpwU5xtRd4T7X7ZUt'
const FEE_AMOUNT  = 4321

function createDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', null, null, null, null, null,
        '127.0.0.1', 18443, 'rpc', 'rpc', false
    )
    decoder.db = {
        isThereADispenserForAddress: sinon.stub().resolves(false),
        getAddressId: sinon.stub().resolves(null),
        hasPubkey: sinon.stub().resolves(true),
        insertPubkey: sinon.stub().resolves()
    }
    decoder.feeDestination = FEE_ADDR
    return decoder
}

// Serve exactly the given transactions by txid; any other lookup rejects loudly.
function wireConnector(decoder, txs){
    const byId = {}
    for (const t of txs) byId[t.getId()] = t.toHex()
    const stub = sinon.stub().callsFake(async (txid) => {
        if (byId[txid]) return byId[txid]
        throw new Error('unit test: unexpected getRawTransaction for ' + txid)
    })
    decoder.connector = { getRawTransaction: stub }
    return stub
}

function addSignatureLikeInput(tx, hash, index){
    tx.addInput(hash, index)
    tx.ins[tx.ins.length - 1].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
}

describe('P2SH/P2WSH chunk-carrier reveal: one commit fetch per parse', function () {
    let decoder, rpc, funderTx, commitTx, revealTx

    beforeEach(() => {
        decoder = createDecoder()

        // The commit's own funder. Its vout 0 carries the address the reveal's source
        // resolves to, via getSourceFromOutput's P2SH walk-back.
        funderTx = new bitcoin.Transaction()
        funderTx.version = 2
        addSignatureLikeInput(funderTx, Buffer.alloc(32, 0x11), 0)
        funderTx.addOutput(bitcoin.address.toOutputScript(SOURCE_ADDR, decoder.network), 100000)

        // The commit: vout 0 is the P2SH script output the reveal spends, vout 1 is the
        // native-coin fee output findFundingFeeOutputs must attribute to the action.
        commitTx = new bitcoin.Transaction()
        commitTx.version = 2
        addSignatureLikeInput(commitTx, funderTx.getHash(), 0)
        commitTx.addOutput(Buffer.from('a914' + 'bb'.repeat(20) + '87', 'hex'), 90000)
        commitTx.addOutput(bitcoin.address.toOutputScript(FEE_ADDR, decoder.network), FEE_AMOUNT)

        // The reveal: spends the commit's P2SH output, pays one ordinary output and
        // carries the OP_RETURN that flags the chunk encoding.
        revealTx = new bitcoin.Transaction()
        revealTx.version = 2
        addSignatureLikeInput(revealTx, commitTx.getHash(), 0)
        revealTx.addOutput(bitcoin.address.toOutputScript(SOURCE_ADDR, decoder.network), 50000)
        revealTx.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.alloc(20, 0x01)]), 0)

        // Drive the P2SH chunk branch (sets p2shFundingTxId = firstInputTxId) without
        // reproducing the obfuscation, exactly as parseTransaction.test.js does.
        sinon.stub(decoder, 'removeObfuscation').resolves(
            Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2sh')])
        )

        rpc = wireConnector(decoder, [funderTx, commitTx])
    })

    afterEach(() => sinon.restore())

    function dispenserSetFor(tx){
        const set = new Set()
        for (const out of tx.outs){
            try { set.add(bitcoin.address.fromOutputScript(out.script, decoder.network)) } catch (err) { /* OP_RETURN */ }
        }
        return set
    }

    it('fetches the commit exactly once and still attributes its fee output', async function () {
        const result = await decoder.parseTransaction(revealTx, dispenserSetFor(revealTx))
        assert.ok(result, 'the reveal must parse')

        // Source resolution walked back through the commit to its funder.
        assert.strictEqual(result.source, SOURCE_ADDR)

        // The decisive assertion: the commit txid is requested once, not twice.
        const commitId = commitTx.getId()
        const askedForCommit = rpc.args.filter(a => a[0] === commitId).length
        assert.strictEqual(askedForCommit, 1,
            `the commit must be fetched once per parse, saw ${askedForCommit}`)

        // Two round trips total: the commit, and the commit's funder for attribution.
        assert.strictEqual(rpc.callCount, 2)
        assert.deepStrictEqual(
            rpc.args.map(a => a[0]).sort(),
            [commitId, funderTx.getId()].sort()
        )

        // The fee output is still found, and still remapped into the reserved domain.
        const fees = result.paymentOutputs.filter(o => o.destinationAddress === FEE_ADDR)
        assert.strictEqual(fees.length, 1)
        assert.strictEqual(Number(fees[0].vout), XChainDecoder.FUNDING_VOUT_BASE + 1)
        assert.strictEqual(Number(fees[0].amount), FEE_AMOUNT)
    })

    it('still fetches the commit itself when source resolution never ran', async function () {
        // getSourceFromOutput is skipped when the source is already known, so the
        // prefetch is absent and findFundingFeeOutputs must fall back to its own fetch.
        // This is the guard the txid-equality check and null fallback exist for.
        const outputs = await decoder.findFundingFeeOutputs(commitTx.getId())
        assert.strictEqual(rpc.callCount, 1)
        assert.strictEqual(outputs.length, 1)
        assert.strictEqual(Number(outputs[0].vout), 1)
        assert.strictEqual(Number(outputs[0].amount), FEE_AMOUNT)
    })
})
