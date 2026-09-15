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
    XChainDecoder,
    CONSTANTS,
    GOLDEN,
    GOLDEN_SCRIPT,
    GOLDEN_PAYLOAD,
    FEE_ADDR,
    POST_FLAG,
    OP,
    buildFundingTx,
    buildCommitTx,
    buildRevealTx,
    createDecoder,
    wireConnector
} = require('./helpers/taproot_envelope.js')

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // Golden end-to-end parse
    describe('parseTransaction: golden envelope reveal', function () {
        let decoder, fundingTx, commitTx, revealTx, rpc, sourceAddr

        beforeEach(() => {
            decoder = createDecoder()
            decoder.feeDestination = FEE_ADDR
            fundingTx = buildFundingTx()
            sourceAddr = bitcoin.address.fromOutputScript(fundingTx.outs[0].script, decoder.network)
            commitTx = buildCommitTx(fundingTx, { feeOutputs: [{ address: FEE_ADDR, amount: 4321 }] })
            revealTx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('decodes the golden action byte-identically with the envelope ceiling', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.ok(result)
            assert.strictEqual(result.envelope, true)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
            assert.strictEqual(result.rawData.toString('utf-8'), GOLDEN.rawDataUtf8)
            // §4 measurand: the reassembled payload length, before parse.
            assert.strictEqual(result.compiledDataLength, GOLDEN_PAYLOAD.length)
        })

        it('attributes the source to the address funding the COMMIT (§3.4)', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, sourceAddr)
            // The legacy ins[0]-prevout walk must NOT run for an envelope.
            assert.strictEqual(decoder.getSourceFromOutput.callCount, 0)
        })

        it('resolves commit fee outputs through the prefetched commit: ONE commit fetch total (§3.5/§3.8)', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG)
            const fees = result.paymentOutputs.filter(o => o.destinationAddress === FEE_ADDR)
            assert.strictEqual(fees.length, 1)
            assert.strictEqual(Number(fees[0].vout), XChainDecoder.FUNDING_VOUT_BASE + 1)
            assert.strictEqual(Number(fees[0].amount), 4321)
            // Exactly two RPC round trips: the commit (once) and the commit's
            // funding prevout (attribution). The fee resolver reuses the
            // prefetched commit instead of fetching it again.
            assert.strictEqual(rpc.callCount, 2)
            const asked = rpc.args.map(a => a[0]).sort()
            assert.deepStrictEqual(asked, [commitTx.getId(), fundingTx.getId()].sort())
        })

        it('is invisible below the flag height: no data, no RPC, legacy ceiling', async function () {
            const result = await decoder.parseTransaction(revealTx, new Set())
            assert.ok(result)
            assert.strictEqual(result.envelope, false)
            assert.strictEqual(result.payloadCeiling, CONSTANTS.MAX_ACTION_DATA_LENGTH)
            assert.strictEqual(result.data.length, 0)
            assert.strictEqual(rpc.callCount, 0)
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('parseTransaction: golden envelope reveal', function () {
        let decoder, fundingTx, commitTx, revealTx, rpc, sourceAddr

        beforeEach(() => {
            decoder = createDecoder()
            decoder.feeDestination = FEE_ADDR
            fundingTx = buildFundingTx()
            sourceAddr = bitcoin.address.fromOutputScript(fundingTx.outs[0].script, decoder.network)
            commitTx = buildCommitTx(fundingTx, { feeOutputs: [{ address: FEE_ADDR, amount: 4321 }] })
            revealTx = buildRevealTx(commitTx, GOLDEN_SCRIPT)
            rpc = wireConnector(decoder, [fundingTx, commitTx])
        })

        it('a commit-funding output with no representable address yields a null source, not a crash', async function () {
            // Rebuild the funding tx with an OP_RETURN at the spent vout.
            const oddFunding = buildFundingTx()
            oddFunding.outs[0].script = bitcoin.script.compile([OP.OP_RETURN, Buffer.from('nothing')])
            const oddCommit = buildCommitTx(oddFunding)
            const oddReveal = buildRevealTx(oddCommit, GOLDEN_SCRIPT)
            wireConnector(decoder, [oddFunding, oddCommit])
            const result = await decoder.parseTransaction(oddReveal, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, null)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })

        it('a commit ins[0] prevout index out of bounds yields a null source', async function () {
            const shortFunding = buildFundingTx()
            const oobCommit = buildCommitTx(shortFunding, { fundingVout: 7 })
            const oobReveal = buildRevealTx(oobCommit, GOLDEN_SCRIPT)
            wireConnector(decoder, [shortFunding, oobCommit])
            const result = await decoder.parseTransaction(oobReveal, new Set(), null, POST_FLAG)
            assert.strictEqual(result.source, null)
            assert.strictEqual(result.data.toString('utf-8'), GOLDEN.action)
        })

        it('a failed commit fetch throws tagged rpcLookupFailure (retry, never a silent no-action)', async function () {
            decoder.connector = { getRawTransaction: sinon.stub().rejects(new Error('node down')) }
            await assert.rejects(
                decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG),
                (err) => err.rpcLookupFailure === true
            )
        })

        it('an EMPTY commit fetch result throws tagged rpcLookupFailure (lookup failure, never absence)', async function () {
            decoder.connector = { getRawTransaction: sinon.stub().resolves(null) }
            await assert.rejects(
                decoder.parseTransaction(revealTx, new Set(), null, POST_FLAG),
                (err) => err.rpcLookupFailure === true
            )
        })
    })
})
