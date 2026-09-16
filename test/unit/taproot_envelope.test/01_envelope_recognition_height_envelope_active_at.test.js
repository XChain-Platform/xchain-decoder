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
    XChainDecoder,
    CONSTANTS,
    POST_FLAG,
    createDecoder
} = require('./helpers/taproot_envelope.js')

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // Activation gating
    describe('envelopeRecognitionHeight() / envelopeActiveAt()', function () {
        it('BTC regtest is genesis-active (height 0)', function () {
            const decoder = createDecoder()
            assert.strictEqual(decoder.envelopeRecognitionHeight(), 0)
            assert.strictEqual(decoder.envelopeActiveAt(0), true)
            assert.strictEqual(decoder.envelopeActiveAt(POST_FLAG), true)
        })

        it('an omitted blockHeight resolves to INACTIVE (shipped behavior), even on regtest', function () {
            const decoder = createDecoder()
            assert.strictEqual(decoder.envelopeActiveAt(undefined), false)
            assert.strictEqual(decoder.envelopeActiveAt(null), false)
        })

        it('DOGE has no envelope on any network, at any height (null = never)', function () {
            const decoder = createDecoder()
            decoder.coinTick = 'DOGE'
            for (const net of ['mainnet', 'testnet', 'regtest']){
                decoder.consensusNetwork = net
                assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
                assert.strictEqual(decoder.envelopeActiveAt(1000000000), false)
            }
        })

        // This was the disarmed-sentinel case; it is kept as a boundary test on the
        // real heights, because the off-by-one at a flag height is a fleet fork.
        // The heights come from CONSTANTS rather than literals ON PURPOSE: this
        // test asserts the BOUNDARY PROPERTY, which holds at whatever height is
        // armed, and the heights have already moved once (961000/3160000 pulled in
        // to 960850/3153500 on 2026-08-02). The literal values are pinned once, in
        // the parity test below, which is where a surprise change should trip.
        it('BTC/LTC mainnet activate at their armed cohort heights, exclusive below', function () {
            const decoder = createDecoder()
            decoder.consensusNetwork = 'mainnet'
            for (const tick of ['BTC', 'LTC']){
                const height = CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION[tick].mainnet
                decoder.coinTick = tick
                assert.strictEqual(decoder.envelopeRecognitionHeight(), height)
                assert.strictEqual(decoder.envelopeActiveAt(height - 1), false)
                assert.strictEqual(decoder.envelopeActiveAt(height), true)
                assert.strictEqual(decoder.envelopeActiveAt(height + 1), true)
            }
        })

        it('an unknown coin or network can only disable recognition, never enable it', function () {
            const decoder = createDecoder()
            decoder.coinTick = 'FOO'
            assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
            decoder.coinTick = 'BTC'
            decoder.consensusNetwork = 'no-such-net'
            assert.strictEqual(decoder.envelopeRecognitionHeight(), null)
            assert.strictEqual(decoder.envelopeActiveAt(1000000000), false)
        })
    })
})
