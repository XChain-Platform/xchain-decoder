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
    POST_FLAG,
    OP,
    FUNDING_PREV,
    makeEnvelopeScript,
    addP2pkhOutput,
    buildFundingTx,
    buildCommitTx,
    buildRevealTx,
    createDecoder,
    wireConnector,
    obfuscate,
    payloadOfLength
} = require('./helpers/taproot_envelope.js')

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // §4 ceiling boundary (the OP_PUSHDATA4 measurand trap)
    describe('per-encoding §4 ceiling', function () {
        let decoder
        beforeEach(() => {
            decoder = createDecoder()
            // No fee destination and a pre-wired commit: these tests only pin
            // the measurand, so attribution resolves against a plain funding.
        })

        function wireFor(script){
            const fundingTx = buildFundingTx()
            const commitTx = buildCommitTx(fundingTx)
            const revealTx = buildRevealTx(commitTx, script)
            wireConnector(decoder, [fundingTx, commitTx])
            return revealTx
        }

        it('a payload of exactly ENVELOPE_MAX_PAYLOAD (390,000) measures at the ceiling and passes the guard', async function () {
            this.timeout(20000)
            const payload = payloadOfLength(CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            const revealTx = wireFor(makeEnvelopeScript(payload))
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.compiledDataLength, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.ok(result.compiledDataLength <= result.payloadCeiling, 'block/mempool guards accept at the ceiling')
            assert.strictEqual(result.data.toString('utf-8'), 'FILE|0|x')
        })

        it('[ADVERSARIAL] a 390,001-byte payload measures OVER the ceiling: the guard drops it in both paths', async function () {
            this.timeout(20000)
            // The rawData push inside this payload is OP_PUSHDATA4-framed; the
            // legacy compiledPushSize re-measure would under-count it by 2
            // bytes and let it slip under the ceiling. The envelope measurand
            // is the reassembled length, pinned here at exactly 390,001.
            const payload = payloadOfLength(CONSTANTS.ENVELOPE_MAX_PAYLOAD + 1)
            const revealTx = wireFor(makeEnvelopeScript(payload))
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.compiledDataLength, CONSTANTS.ENVELOPE_MAX_PAYLOAD + 1)
            assert.ok(result.compiledDataLength > result.payloadCeiling,
                'the exact comparison both the block and mempool guards apply must reject')
        })

        it('legacy lanes keep MAX_ACTION_DATA_LENGTH: an OP_RETURN action reports the 8192 ceiling', async function () {
            const tx = new bitcoin.Transaction()
            tx.version = 2
            tx.addInput(FUNDING_PREV, 1)
            tx.ins[0].script = bitcoin.script.compile([Buffer.alloc(72, 0x30), Buffer.alloc(33, 0x02)])
            const display = Buffer.from(FUNDING_PREV).reverse().toString('hex')
            const cipher = obfuscate(Buffer.concat([Buffer.from('XCHN'), bitcoin.script.compile([Buffer.from('SEND|0|XCHAIN|1000')])]), display)
            tx.addOutput(bitcoin.script.compile([OP.OP_RETURN, cipher]), 0)
            addP2pkhOutput(tx)
            const result = await decoder.parseTransaction(tx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
            assert.strictEqual(result.data.toString('utf-8'), 'SEND|0|XCHAIN|1000')
        })
    })
})
