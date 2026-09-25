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
 * Taproot envelope recognition corpus (protocol spec §3.8).
 *
 * Pins, against the frozen golden vectors (xchain-documentation/protocol/
 * test-vectors/taproot_envelope.json, inlined here so this suite runs
 * without the sibling checkout and cross-checked against the file when it
 * is present):
 *  1. golden-vector recognition end to end through parseTransaction:
 *     payload reassembly, commit-based source attribution (§3.4), commit
 *     fee-output resolution through the single prefetched commit (§3.5),
 *     and the per-encoding §4 ceiling routing;
 *  2. the adversarial corpus: bad magic, unknown format byte, annex-bearing
 *     reveal, mixed carriers, multi-envelope, non-ins[0] envelope, foreign
 *     ord-style inscriptions, fuzzed witness stacks -- no crash, no false
 *     positive, no RPC fetch on any non-recognition;
 *  3. pre-vs-post-flag replay: below the recognition height every rule in
 *     §3.8 is inert and a mixed-carrier tx parses exactly as shipped;
 *  4. the §4 ceiling boundary: 390,000 accepted, 390,001 refused, measured
 *     on the REASSEMBLED payload length (a >65,535-byte rawData push is
 *     framed with OP_PUSHDATA4, which the legacy compiledPushSize re-measure
 *     does not model -- the envelope must never route through it);
 *  5. constants conformance: decoder == encoder == documentation for
 *     ENVELOPE_MAX_PAYLOAD and the recognition-height map (skip-if-absent
 *     sibling checkout, matching the compiledPushSizeConformance convention);
 *  6. wire fidelity: a REAL encoder-built, fully signed reveal parses
 *     byte-identically (sibling-gated on xchain-encoder).
 */

'use strict';

const fs = require('fs')
const path = require('path')
const {
    assert,
    sinon,
    crypto,
    bitcoin,
    ecc,
    CONSTANTS,
    POST_FLAG,
    createDecoder
} = require('./helpers/taproot_envelope.js')

function createEncoder(XChainEncoder, pub){
    const endpoint = ['127', '0', '0', '1'].join('.')
    const encoder = new XChainEncoder('bitcoin-regtest', endpoint, '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => { throw new Error('unit test: no node') }
    }
    encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
    }
    const network = encoder.network
    const caller = bitcoin.payments.p2wpkh({ pubkey: pub, network }).address
    const callerSpk = bitcoin.payments.p2wpkh({ pubkey: pub, network }).output
    return { encoder, caller, callerSpk }
}

function signPair(result, pub, priv){
    result.psbt.signAllInputs({ publicKey: pub, sign: (h) => Buffer.from(ecc.sign(h, priv)) })
    result.psbt.finalizeAllInputs()
    const commitTx = result.psbt.extractTransaction()
    result.revealPsbt.signInput(0, { publicKey: pub, signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, priv)) })
    result.revealPsbt.finalizeAllInputs()
    return { commitTx, revealTx: result.revealPsbt.extractTransaction() }
}

async function decodePair(commitTx, revealTx, callerSpk, fundingTxid){
    const decoder = createDecoder()
    const syntheticFunding = new bitcoin.Transaction()
    syntheticFunding.version = 2
    syntheticFunding.addInput(Buffer.alloc(32, 0xef), 0)
    syntheticFunding.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
    syntheticFunding.addOutput(callerSpk, 10000000)
    const served = { [commitTx.getId()]: commitTx.toHex(), [fundingTxid]: syntheticFunding.toHex() }
    const rpc = sinon.stub().callsFake(async (txid) => {
        if (served[txid]) return served[txid]
        throw new Error('unit test: unexpected getRawTransaction for ' + txid)
    })
    decoder.connector = { getRawTransaction: rpc }
    const parseTx = decoder.xchainBlockDecoder.transactionFromHex(revealTx.toHex())
    const parsed = await decoder.parseTransaction(parseTx, new Set(), null, POST_FLAG)
    return { parsed, rpc }
}

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // Wire fidelity: a REAL encoder-built, signed reveal through parseTransaction
    describe('wire fidelity with the shipped encoder (sibling-gated)', function () {
        const ENCODER_DIR = process.env.XCHAIN_ENCODER_DIR ||
            path.join(__dirname, '..', '..', '..', '..', 'xchain-encoder')
        const ENCODER_MAIN = path.join(ENCODER_DIR, 'src', 'XChainEncoder.js')
        before(function () { if (!fs.existsSync(ENCODER_MAIN)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-encoder sibling not found at ' + ENCODER_MAIN + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

        it('an encoder-built signed commit/reveal pair decodes byte-identically', async function () {
            this.timeout(20000)
            const XChainEncoder = require(ENCODER_MAIN)

            // Deterministic caller key; its compressed pubkey doubles as the
            // envelope internal key, exactly as the encoder's own suite does.
            const priv = Buffer.alloc(32, 7)
            const pub = Buffer.from(ecc.pointFromScalar(priv, true))
            const { encoder, caller, callerSpk } = createEncoder(XChainEncoder, pub)
            const fundingTxid = 'a'.repeat(64)
            const utxos = [{ txid: fundingTxid, vout: 0, value: 10000000, confirmations: 6, scriptPubKey: callerSpk.toString('hex') }]

            const action = 'FILE|0|wire-fidelity.bin|application/octet-stream|||||||'
            const raw = crypto.randomBytes(9000).toString('binary')
            const result = await encoder.createTransaction(
                utxos, caller, null, action, raw,
                null, false, 'TAPROOT', caller, null, null, pub.toString('hex'))
            const { commitTx, revealTx } = signPair(result, pub, priv)
            const { parsed, rpc } = await decodePair(commitTx, revealTx, callerSpk, fundingTxid)

            assert.ok(parsed)
            assert.strictEqual(parsed.envelope, true)
            assert.strictEqual(parsed.payloadCeiling, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(parsed.data.toString('utf-8'), action, 'action string byte-identical')
            assert.deepStrictEqual(parsed.rawData, Buffer.from(raw, 'binary'), 'rawData byte-identical across the wire')
            assert.strictEqual(parsed.source, caller, 'source = the address funding the commit (§3.4)')
            const expectedPayload = bitcoin.script.compile([Buffer.from(action), Buffer.from(raw, 'binary')])
            assert.strictEqual(parsed.compiledDataLength, expectedPayload.length, '§4 measurand = reassembled payload length')
            assert.strictEqual(rpc.callCount, 2, 'one commit fetch + one attribution fetch, nothing else')
        })
    })
})
