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
    bitcoin,
    XChainDecoder,
    CONSTANTS,
    GOLDEN
} = require('./helpers/taproot_envelope.js')

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())


    // Constants conformance (decoder == encoder == documentation)
    describe('constants conformance', function () {
        it('the decoder exports the vendored constants unchanged', function () {
            assert.strictEqual(XChainDecoder.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            assert.strictEqual(CONSTANTS.ENVELOPE_MAX_PAYLOAD, 390000)
            assert.deepStrictEqual(XChainDecoder.ENVELOPE_RECOGNITION_ACTIVATION, CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION)
        })

        // Pins the ARMED map exactly (operator §7 cohort call, 2026-08-01). Every value
        // here is consensus-visible: a decoder that flips at a different height than its
        // peers forks the fleet on the first envelope, so this assertion is deliberately
        // literal rather than derived. DOGE stays null forever (no segwit, no Taproot).
        it('the recognition map is exactly the §7 shape: BTC/LTC armed mainnet cohorts, genesis-active test networks, DOGE never', function () {
            assert.deepStrictEqual(CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION, {
                BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
                LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
                DOGE: { mainnet: null, testnet: null, regtest: null },
            })
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('constants conformance', function () {
        describe('parity with the canonical xchain-documentation copy', function () {
            const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
                path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation')
            const DOCS_CONSTANTS = path.join(DOCS, 'protocol', 'constants.js')
            before(function () { if (!fs.existsSync(DOCS_CONSTANTS)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-documentation sibling not found at ' + DOCS_CONSTANTS + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

            it('ENVELOPE_MAX_PAYLOAD and both activation maps are byte-equal to the canonical copy', function () {
                const docs = require(DOCS_CONSTANTS)
                assert.strictEqual(docs.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
                assert.deepStrictEqual(docs.ENVELOPE_RECOGNITION_ACTIVATION, CONSTANTS.ENVELOPE_RECOGNITION_ACTIVATION)
                assert.deepStrictEqual(docs.ENVELOPE_CARRIER_RECOGNITION_ACTIVATION, CONSTANTS.ENVELOPE_CARRIER_RECOGNITION_ACTIVATION)
            })

            it('the inlined golden bytes match the frozen vector file', function () {
                const vectors = require(path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json'))
                assert.strictEqual(vectors.envelope_grammar.envelope_script_hex, GOLDEN.envelopeScriptHex)
                assert.strictEqual(vectors.envelope_grammar.compiled_payload_hex, GOLDEN.compiledPayloadHex)
                assert.strictEqual(vectors.envelope_grammar.control_block_hex, GOLDEN.controlBlockHex)
                assert.strictEqual(vectors.envelope_grammar.commit_scriptPubKey_hex, GOLDEN.commitScriptPubKeyHex)
                assert.strictEqual(vectors.envelope_grammar.action_string, GOLDEN.action)
                assert.strictEqual(vectors.envelope_grammar.raw_data_utf8, GOLDEN.rawDataUtf8)
                assert.strictEqual(vectors._meta.ceiling.value, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
                for (const adv of vectors.adversarial){
                    if (adv.name === 'bad_magic') assert.strictEqual(adv.envelope_script_hex, GOLDEN.badMagicScriptHex)
                    if (adv.name === 'unknown_format_byte') assert.strictEqual(adv.envelope_script_hex, GOLDEN.unknownFormatScriptHex)
                    if (adv.name === 'annex_bearing_reveal') assert.deepStrictEqual(adv.witness_stack_hex, GOLDEN.annexWitnessHex)
                }
            })

            it('the golden tapleaf hash reproduces from the frozen script bytes', function () {
                const vectors = require(path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json'))
                const script = Buffer.from(vectors.envelope_grammar.envelope_script_hex, 'hex')
                const lenPrefix = script.length < 253
                    ? Buffer.from([script.length])
                    : (() => { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(script.length, 1); return b })()
                const leaf = bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([Buffer.from([0xc0]), lenPrefix, script]))
                assert.strictEqual(leaf.toString('hex'), vectors.envelope_grammar.tapleaf_hash)
            })
        })
    })
})

describe('Taproot envelope recognition', function () {
    afterEach(() => sinon.restore())

    describe('constants conformance', function () {
        describe('parity with the encoder validator', function () {
            const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
                path.join(__dirname, '..', '..', '..', '..', 'xchain-encoder')
            const VALIDATOR = path.join(ENCODER, 'src', 'common', 'validator.js')
            before(function () { if (!fs.existsSync(VALIDATOR)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-encoder sibling not found at ' + VALIDATOR + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } })

            it('ENVELOPE_MAX_PAYLOAD stays equal across the two services', function () {
                const v = require(VALIDATOR)
                assert.strictEqual(v.ENVELOPE_MAX_PAYLOAD, CONSTANTS.ENVELOPE_MAX_PAYLOAD)
            })
        })
    })
})
