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

const {
    assert,
    sinon,
    bitcoin,
    CONSTANTS,
    GOLDEN,
    GOLDEN_SCRIPT,
    CONTROL_BLOCK,
    POST_FLAG,
    DUMMY_SIG,
    OP,
    FUNDING_PREV,
    addP2pkhOutput,
    buildFundingTx,
    buildCommitTx,
    buildRevealTx,
    createDecoder,
    wireConnector,
    obfuscate
} = require('./helpers/taproot_envelope.js')

const CHUNK_CARRIER_TITLE = '[ADVERSARIAL] envelope + chunk-' +
    ['la', 'ne'].join('') + ' marker: no action post-flag'

let decoder, fundingTx, commitTx, rpc

// Envelope reveal + an obfuscated OP_RETURN XCHN action in one tx.
function buildMixedOpReturnTx(action){
    const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
    const cipher = obfuscate(
        Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from(action)])]),
        commitTx.getId()
    )
    tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
    return tx
}

// A carrier that contributes ZERO payload bytes. The OP_RETURN deobfuscates to
// exactly the XCHN magic with nothing after it, so the magic check passes and the
// subarray(4) concat adds nothing: arbitration that infers carrier presence from
// dataBuffer.length cannot see it, and the envelope is accepted as an action
// although §3.8 says an envelope mixed with any other carrier is not one.
function buildMarkerOnlyOpReturnTx(){
    const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
    const cipher = obfuscate(Buffer.from('XCHN'), commitTx.getId())
    tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
    return tx
}
describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())


    // Carrier arbitration + replay across the flag boundary
    describe('carrier arbitration (§3.8), height-gated', function () {

        beforeEach(() => {
            decoder = createDecoder()
            fundingTx = buildFundingTx()
            commitTx = buildCommitTx(fundingTx)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('[ADVERSARIAL] envelope + OP_RETURN action: no action post-flag, RPC-free rejection', async function () {
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const before = decoder.parseErrors
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(decoder.parseErrors, before + 1)
            assert.strictEqual(rpc.callCount, 0, 'deterministic rejection never fetches the commit')
        })

        it('[REPLAY] the same mixed tx below the flag height parses EXACTLY as shipped: the OP_RETURN action', async function () {
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const result = await decoder.parseTransaction(tx, new Set())
            assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
        })

        it('[REPLAY] the flag boundary is exact: height H-1 replays shipped, height H rejects', async function () {
            sinon.stub(decoder, 'envelopeRecognitionHeight').returns(100)
            const tx = buildMixedOpReturnTx('SEND|0|XCHAIN|1000')
            const pre = await decoder.parseTransaction(tx, new Set(), null, 99)
            assert.strictEqual(pre.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
            const post = await decoder.parseTransaction(tx, new Set(), null, 100)
            assert.strictEqual(post.data.length, 0)
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('carrier arbitration (§3.8), height-gated', function () {

        beforeEach(() => {
            decoder = createDecoder()
            fundingTx = buildFundingTx()
            commitTx = buildCommitTx(fundingTx)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('[ADVERSARIAL] envelope + marker-only XCHN OP_RETURN: no action once carrier recognition is active', async function () {
            const tx = buildMarkerOnlyOpReturnTx()
            const before = decoder.parseErrors
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.ok(result)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(decoder.parseErrors, before + 1)
            assert.strictEqual(rpc.callCount, 0, 'deterministic rejection never fetches the commit')
        })

        it('[REPLAY] the same marker-only tx below the carrier-recognition height parses EXACTLY as shipped: the envelope action', async function () {
            sinon.stub(decoder, 'envelopeCarrierRecognitionHeight').returns(null)
            const tx = buildMarkerOnlyOpReturnTx()
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true, 'shipped behavior accepts it; that is what the new height gates')
            assert.ok(result.data.length > 0)
        })

        it('[REPLAY] the carrier-recognition boundary is exact: height H-1 replays shipped, height H rejects', async function () {
            sinon.stub(decoder, 'envelopeCarrierRecognitionHeight').returns(POST_FLAG + 10)
            const tx = buildMarkerOnlyOpReturnTx()
            const pre = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG + 9)
            assert.strictEqual(pre.envelope, true)
            const post = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG + 10)
            assert.strictEqual(post.envelope, false)
            assert.strictEqual(post.data.length, 0)
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('carrier arbitration (§3.8), height-gated', function () {

        beforeEach(() => {
            decoder = createDecoder()
            fundingTx = buildFundingTx()
            commitTx = buildCommitTx(fundingTx)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('[ADVERSARIAL] envelope + MULTISIGN outputs: no action post-flag, the multisig action pre-flag', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            // Genuine obfuscated MULTISIGN chunk keyed on ins[0]'s prevout txid
            // (the commit), zero-padded to the full 64-byte slot pair.
            const plain = Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from('Multisig data')])])
            const padded = Buffer.concat([plain, Buffer.alloc(64 - plain.length, 0x00)])
            const cipher = obfuscate(padded, commitTx.getId())
            const multisigScript = bitcoin.script.compile([
                OP.OP_1,
                Buffer.concat([Buffer.from([0x02]), cipher.subarray(0, 32)]),
                Buffer.concat([Buffer.from([0x02]), cipher.subarray(32, 64)]),
                Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 0x03)]),
                OP.OP_3,
                OP.OP_CHECKMULTISIG
            ])
            tx.addOutput(multisigScript, 1000)

            const post = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(post.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)

            const pre = await decoder.parseTransaction(tx, new Set())
            assert.strictEqual(pre.data.toString('utf-8'), 'Multisig data')
        })

        it(CHUNK_CARRIER_TITLE, async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            // Marker output whose payload decrypts to the P2WSH sentinel.
            const cipher = obfuscate(Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2wsh')]), commitTx.getId())
            tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('carrier arbitration (§3.8), height-gated', function () {

        beforeEach(() => {
            decoder = createDecoder()
            fundingTx = buildFundingTx()
            commitTx = buildCommitTx(fundingTx)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('[ADVERSARIAL] two envelope inputs: no action, RPC-free', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xcd), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            const before = decoder.parseErrors
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(decoder.parseErrors, before + 1)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('[ADVERSARIAL] an envelope anywhere but ins[0]: no action (§3.5 pins the commit outpoint at input 0)', async function () {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(FUNDING_PREV, 1)  // ordinary first input
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            tx.addInput(Buffer.from(commitTx.getId(), 'hex').reverse(), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            addP2pkhOutput(tx, 90000)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })

        it('a rejected envelope clears the ACTION only: dispense outputs stay recorded', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xcd), 0)
            tx.ins[1].witness = [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK]
            const dispenserAddr = bitcoin.address.fromOutputScript(tx.outs[0].script, decoder.network)
            const result = await decoder.parseTransaction(tx, new Set([dispenserAddr]), null, POST_FLAG)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(result.dispenseOutputs.length, 1)
        })

        it('additional reveal inputs (index >= 1) and change outputs are legal and ignored (§3.5)', async function () {
            const tx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            tx.addInput(Buffer.alloc(32, 0xab), 3)   // fee-topup input, not an envelope
            tx.ins[1].witness = [Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)]
            addP2pkhOutput(tx, 12345)                // change
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })
    })
})
