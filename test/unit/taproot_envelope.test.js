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
    crypto,
    bitcoin,
    GOLDEN,
    GOLDEN_SCRIPT,
    GOLDEN_PAYLOAD,
    CONTROL_BLOCK,
    XONLY,
    DUMMY_SIG,
    OP,
    pushData,
    makeEnvelopeScript,
    createDecoder
} = require('./taproot_envelope.test/helpers/taproot_envelope.js')

describe('Taproot envelope recognition', function () {

    afterEach(() => sinon.restore())

    // detectEnvelopeWitness: pure pattern matching, never throws
    describe('detectEnvelopeWitness()', function () {
        let decoder
        beforeEach(() => { decoder = createDecoder() })

        it('recognizes the golden witness and reassembles the exact payload bytes', function () {
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK])
            assert.ok(hit, 'golden envelope recognized')
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD, 'byte-identical reassembly')
            assert.deepStrictEqual(hit.script, GOLDEN_SCRIPT)
        })

        it('recognizes a multi-push envelope and concatenates pushes in order', function () {
            const payload = bitcoin.script.compile([Buffer.from('FILE|0|chunks'), crypto.randomBytes(1200)])
            const script = makeEnvelopeScript(payload)
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, payload)
        })

        it('recognition is framing-agnostic: a fat-framed (PUSHDATA1) payload push reassembles identically', function () {
            // A foreign encoder may frame a small chunk non-minimally; the
            // reassembled payload counts data bytes only.
            const fat = Buffer.concat([Buffer.from([0x4c, GOLDEN_PAYLOAD.length]), GOLDEN_PAYLOAD])
            const script = makeEnvelopeScript(null, { pushes: [fat] })
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD)
        })

        it('accepts the odd-parity control block first byte (0xc1)', function () {
            const control = Buffer.concat([Buffer.from([0xc1]), CONTROL_BLOCK.subarray(1)])
            assert.ok(decoder.detectEnvelopeWitness([DUMMY_SIG, GOLDEN_SCRIPT, control]))
        })

        it('[ADVERSARIAL] bad magic is not recognized', function () {
            const script = Buffer.from(GOLDEN.badMagicScriptHex, 'hex')
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] unknown format byte (0x01) is invisible by design', function () {
            const script = Buffer.from(GOLDEN.unknownFormatScriptHex, 'hex')
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] an annex-bearing reveal is never recognized (BIP341 end-indexed parsing)', function () {
            const witness = GOLDEN.annexWitnessHex.map(h => Buffer.from(h, 'hex'))
            assert.strictEqual(decoder.detectEnvelopeWitness(witness), null)
        })

        it('[ADVERSARIAL] structural violations are all rejected without throwing', function () {
            const cases = [
                // key-path spend (single signature)
                [DUMMY_SIG],
                // empty / missing witness
                [], null, undefined,
                // control block with a non-tapscript leaf version
                [DUMMY_SIG, GOLDEN_SCRIPT, Buffer.concat([Buffer.from([0xc2]), CONTROL_BLOCK.subarray(1)])],
                // control block length not 33 + 32k
                [DUMMY_SIG, GOLDEN_SCRIPT, CONTROL_BLOCK.subarray(0, 32)],
                [DUMMY_SIG, GOLDEN_SCRIPT, Buffer.concat([CONTROL_BLOCK, Buffer.alloc(31, 0x00)])],
                // zero payload pushes
                [DUMMY_SIG, makeEnvelopeScript(null, { pushes: [] }), CONTROL_BLOCK],
                // internal key push not 32 bytes
                [DUMMY_SIG, makeEnvelopeScript(GOLDEN_PAYLOAD, { xonly: Buffer.alloc(33, 0x02) }), CONTROL_BLOCK],
                // trailing junk after OP_CHECKSIG
                [DUMMY_SIG, Buffer.concat([GOLDEN_SCRIPT, Buffer.from([OP.OP_1])]), CONTROL_BLOCK],
                // OP_ENDIF missing (truncated before the tail)
                [DUMMY_SIG, GOLDEN_SCRIPT.subarray(0, GOLDEN_SCRIPT.length - 35), CONTROL_BLOCK],
                // non-buffer script item
                [DUMMY_SIG, 42, CONTROL_BLOCK]
            ]
            for (const witness of cases){
                assert.strictEqual(decoder.detectEnvelopeWitness(witness), null)
            }
        })

        it('recognition reads only the top two stack items: the signature slot is opaque to it', function () {
            // The first witness item is script input (the schnorr signature);
            // recognition never inspects it, so even a degenerate value there
            // cannot mask an otherwise well-formed envelope.
            const hit = decoder.detectEnvelopeWitness([42, GOLDEN_SCRIPT, CONTROL_BLOCK])
            assert.ok(hit)
            assert.deepStrictEqual(hit.payload, GOLDEN_PAYLOAD)
        })

        it('[ADVERSARIAL] a payload push that canonicalizes to a bare opcode breaks the walk (encoder rebalance exists for this)', function () {
            // Hand-assembled: payload pushes are <519 bytes> then OP_7 where a
            // naive encoder would have compiled a 1-byte 0x07 final chunk.
            const script = Buffer.concat([
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('XCHN')),
                pushData(Buffer.from([0x00])),
                pushData(Buffer.alloc(519, 0x61)),
                Buffer.from([OP.OP_7]),
                Buffer.from([OP.OP_ENDIF]),
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] the rebalanced form of the same payload IS recognized and reassembles identically', function () {
            const payload = Buffer.concat([Buffer.alloc(520, 0x61), Buffer.from([0x07])])
            const script = makeEnvelopeScript(payload)   // chunk520 rebalances (519, 2)
            const hit = decoder.detectEnvelopeWitness([DUMMY_SIG, script, CONTROL_BLOCK])
            assert.ok(hit, 'rebalanced envelope recognized')
            assert.deepStrictEqual(hit.payload, payload)
        })

        it('[ADVERSARIAL] foreign ord-style inscriptions are not recognized', function () {
            // Real ord grammar: <pubkey> OP_CHECKSIG OP_FALSE OP_IF "ord" ... OP_ENDIF
            const ord = Buffer.concat([
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG]),
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('ord')),
                pushData(Buffer.from([0x01])),
                pushData(Buffer.from('text/plain;charset=utf-8')),
                Buffer.from([OP.OP_0]),
                pushData(Buffer.from('Hello, world!')),
                Buffer.from([OP.OP_ENDIF])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, ord, CONTROL_BLOCK]), null)
            // OP_FALSE OP_IF head but wrong interior grammar
            const notQuite = Buffer.concat([
                Buffer.from([OP.OP_0, OP.OP_IF]),
                pushData(Buffer.from('XCHN')),
                Buffer.from([OP.OP_ENDIF]),     // no format byte, no payload
                pushData(XONLY),
                Buffer.from([OP.OP_CHECKSIG])
            ])
            assert.strictEqual(decoder.detectEnvelopeWitness([DUMMY_SIG, notQuite, CONTROL_BLOCK]), null)
        })

        it('[ADVERSARIAL] fuzzed witness stacks never throw and never false-positive', function () {
            for (let i = 0; i < 300; i++){
                const items = []
                const count = i % 6
                for (let j = 0; j < count; j++){
                    const len = crypto.randomBytes(1)[0] + (j === count - 1 ? 33 : 0)
                    items.push(crypto.randomBytes(len))
                }
                let result
                assert.doesNotThrow(() => { result = decoder.detectEnvelopeWitness(items) })
                if (result !== null){
                    // The only way a random stack is "recognized" is by actually
                    // containing the full grammar, which randomness cannot hit.
                    assert.fail('fuzzed witness stack recognized as an envelope')
                }
            }
        })
    })

})
