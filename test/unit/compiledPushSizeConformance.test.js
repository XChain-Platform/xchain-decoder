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
        before(function () { if (!fs.existsSync(VALIDATOR)) this.skip(); });

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
    });
});
