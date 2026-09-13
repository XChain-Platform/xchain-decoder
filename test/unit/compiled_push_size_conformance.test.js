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
 * The compiled on-chain push size is THE quantity that decides whether an
 * ACTION tx is accepted or silently dropped (MAX_ACTION_DATA_LENGTH gate).
 * The decoder is the protocol arbiter; the encoder mirrors the formula. This
 * suite converts the "decoder measures exactly what the encoder compiled"
 * comment from an assumption into an enforced invariant:
 *  1. decoder compiledPushSize == bitcoin.script.compile length, across the
 *     75/255 OP_PUSHDATA prefix transitions and the 8192 drop boundary;
 *  2. dual-push (data + rawData) summation matches the real compiled script;
 *  3. decoder helper == encoder helper (skip-if-absent sibling checkout,
 *     matching the ActionManifestConformance convention).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const XChainDecoder = require('../../src/XChainDecoder.js');

const pushSize = XChainDecoder.compiledPushSize;

// 0x61 filler avoids bitcoinjs minimal-push encoding (single bytes 0x00-0x10
// and 0x81 compile to bare opcodes, not data pushes; real payloads are ASCII).
const buf = (n) => Buffer.alloc(n, 0x61);

// Every OP_PUSHDATA prefix transition plus the drop boundary and dual-push sizes.
const BOUNDARY_SIZES = [1, 2, 74, 75, 76, 77, 254, 255, 256, 257, 1000, 4093, 4094, 8188, 8189, 8190];

describe('compiled-push-size arbiter conformance', function () {

    it('matches bitcoin.script.compile byte-for-byte across the prefix boundaries', function () {
        for (const n of BOUNDARY_SIZES) {
            const compiled = bitcoin.script.compile([buf(n)]).length;
            assert.strictEqual(pushSize(n), compiled,
                `compiledPushSize(${n}) must equal bitcoin.script.compile length (${compiled})`);
        }
    });

    it('dual-push summation matches the real compiled two-push script', function () {
        // Mirrors prepareData: bitcoin.script.compile([dataBuf, rawDataBuf]).
        const combos = [
            [75, 75], [75, 76], [76, 255], [255, 256], [4093, 4093], [4094, 4094], [14, 8170],
        ];
        for (const [a, b] of combos) {
            const compiled = bitcoin.script.compile([buf(a), buf(b)]).length;
            assert.strictEqual(pushSize(a) + pushSize(b), compiled,
                `pushSize(${a}) + pushSize(${b}) must equal compiled dual-push length (${compiled})`);
        }
    });

    it('the 8192 accept/drop boundary is where the encoder and the compiled script agree', function () {
        const MAX = XChainDecoder.MAX_ACTION_DATA_LENGTH;
        assert.strictEqual(MAX, 8192);
        // 8189 raw bytes -> 8192 compiled (accepted, == MAX); 8190 -> 8193 (dropped, > MAX).
        assert.strictEqual(pushSize(8189), MAX);
        assert.strictEqual(bitcoin.script.compile([buf(8189)]).length, MAX);
        assert.ok(pushSize(8190) > MAX);
        assert.strictEqual(bitcoin.script.compile([buf(8190)]).length, MAX + 1);
    });

    // CONFORMANCE: the encoder's emit-side helper must be the same function.
    // Skips when the sibling xchain-encoder is not checked out.
    describe('parity with the encoder compiledPushSize', function () {
        const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-encoder');
        const VALIDATOR = path.join(ENCODER, 'src', 'validator.js');
        before(function () { if (!fs.existsSync(VALIDATOR)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-encoder sibling not found at ' + VALIDATOR + ' but XCHAIN_REQUIRE_SIBLINGS=1'); this.skip(); } });

        it('agrees with the decoder helper for every length up to the ceiling', function () {
            const encoderPushSize = require(VALIDATOR).compiledPushSize;
            assert.strictEqual(typeof encoderPushSize, 'function',
                'xchain-encoder validator must export compiledPushSize');
            for (let n = 0; n <= 8300; n++) {
                if (encoderPushSize(n) !== pushSize(n)) {
                    assert.fail(`encoder/decoder compiledPushSize diverge at ${n}: ` +
                        `${encoderPushSize(n)} vs ${pushSize(n)}`);
                }
            }
        });

        it('MAX constants stay equal across the two services', function () {
            const v = require(VALIDATOR);
            assert.strictEqual(v.MAX_COMPILED_ACTION_DATA_LENGTH, XChainDecoder.MAX_ACTION_DATA_LENGTH);
        });

        // The envelope band, which the sweep above cannot reach.
        //
        // The lane's two sides measure the same bytes with different machinery
        // ON PURPOSE. compiledPushSize has no OP_PUSHDATA4 branch, so above
        // 0xffff it under-counts a real compiled push by 2; the encoder corrects
        // for that in envelopePushSize before comparing against the envelope
        // ceiling, and the decoder instead refuses to re-measure an envelope
        // payload at all (the `!envelopeCarrier` guard in parseTransaction).
        // Both sides carried that reasoning as a COMMENT and neither asserted
        // it, while the only cross-service sweep stopped at n=8300 - three
        // orders of magnitude below where the divergence opens and 381,700
        // bytes below the ENVELOPE_MAX_PAYLOAD ceiling it decides.
        describe('envelope push band (0xffff .. ENVELOPE_MAX_PAYLOAD)', function () {

            // Straddles every branch the correction touches: the last
            // OP_PUSHDATA2 length, the first OP_PUSHDATA4 length, the one after
            // it, a mid-band value, and the ceiling itself.
            const BAND = [8192, 65534, 65535, 65536, 65537, 200000, 390000];

            it('envelopePushSize equals the real compiled push length across the band', function () {
                const envelopePushSize = require(VALIDATOR).envelopePushSize;
                assert.strictEqual(typeof envelopePushSize, 'function',
                    'xchain-encoder validator must export envelopePushSize');
                for (const n of BAND) {
                    const compiled = bitcoin.script.compile([buf(n)]).length;
                    assert.strictEqual(envelopePushSize(n), compiled,
                        `envelopePushSize(${n}) must equal bitcoin.script.compile length (${compiled})`);
                }
            });

            it('the decoder helper under-counts by exactly 2 above 0xffff, and not below', function () {
                const envelopePushSize = require(VALIDATOR).envelopePushSize;
                for (const n of BAND) {
                    const expected = n > 0xffff ? 2 : 0;
                    assert.strictEqual(envelopePushSize(n) - pushSize(n), expected,
                        `at ${n} the encoder envelope correction must be exactly ${expected} bytes ` +
                        `(got ${envelopePushSize(n) - pushSize(n)}); this is the gap that makes the ` +
                        'decoder refuse to re-measure an envelope payload');
                }
            });

            it('re-measuring at the ceiling would under-count, which is why the decoder does not', function () {
                const C = require('../../src/protocol/constants.js');
                assert.strictEqual(C.ENVELOPE_MAX_PAYLOAD, 390000);
                // The negative control for the guard above: state the failure the
                // `!envelopeCarrier` branch exists to avoid, as arithmetic rather
                // than as a comment. If compiledPushSize ever grew a PUSHDATA4
                // band, this assertion is what says so.
                const real = bitcoin.script.compile([buf(C.ENVELOPE_MAX_PAYLOAD)]).length;
                assert.strictEqual(real - pushSize(C.ENVELOPE_MAX_PAYLOAD), 2,
                    'compiledPushSize must still under-count a ceiling-sized push by 2; the decoder ' +
                    'skips the re-measure on that exact basis');
            });
        });
    });

    // The OP_PUSHDATA2 overhead used to be a bare `+ 3` literal here, invisible to any
    // name-keyed cross-service drift check. The decoder now binds the canonical named
    // constant; these cases pin that the binding did not change the arithmetic (a named
    // constant that shifts a value would be a consensus bug, not a cleanup).
    describe('OP_RETURN_PUSH_OVERHEAD is name-keyed and value-identical', function () {

        it('equals the vendored canonical protocol constant', function () {
            const C = require('../../src/protocol/constants.js');
            assert.strictEqual(XChainDecoder.OP_RETURN_PUSH_OVERHEAD, C.OP_RETURN_PUSH_OVERHEAD);
            assert.strictEqual(XChainDecoder.OP_RETURN_PUSH_OVERHEAD, 3);
        });

        it('is exactly what compiledPushSize adds above the OP_PUSHDATA1 ceiling', function () {
            for (const n of [256, 257, 1000, 8189, 8190]) {
                assert.strictEqual(pushSize(n) - n, XChainDecoder.OP_RETURN_PUSH_OVERHEAD,
                    `compiledPushSize(${n}) must add exactly OP_RETURN_PUSH_OVERHEAD`);
            }
        });
    });
});
