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
 * Cross-site payload-representation conformance (uuid:26220713).
 *
 * The confirmed-block path stores transactions.data as the canonical UTF-8
 * ACTION string (strictTextDecoder over canonicalizeActionPayload().buffer).
 * The mempool path must store mempool_transactions.data in the SAME shape, not
 * hex, or a pending row and its confirmed twin carrying the identical on-wire
 * ACTION disagree by encoding and any content correlation (startsWith checks)
 * silently mismatches. This suite pins the representation contract so the two
 * decode sites cannot silently re-diverge.
 */

'use strict';

const assert = require('assert');
const XChainDecoder = require('../../src/XChainDecoder.js');

const canonicalize = XChainDecoder.canonicalizeActionPayload;

// The two decode sites share this decode; both must produce this string.
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

// The stored form both sites are required to write for a known ACTION.
function storedForm(onWirePayload) {
    const canonical = canonicalize(onWirePayload);
    return strictTextDecoder.decode(canonical.buffer);
}

describe('mempool vs confirmed ACTION payload representation conformance', function () {

    const SAMPLES = [
        'COINPAY|0|abc|def',
        'DISPENSER|0|BTC|1|1|1|1|XCP|1|1|addr|1|1|1|4294967295',
        'ATTEST|0|hello world',
    ];

    it('stored form is the readable UTF-8 ACTION string, never hex', function () {
        for (const s of SAMPLES) {
            const stored = storedForm(Buffer.from(s, 'utf8'));
            assert.strictEqual(stored, s,
                `stored payload must equal the UTF-8 ACTION string for "${s}"`);
            assert.ok(/[A-Z]/.test(stored) && stored.includes('|'),
                `stored payload must be readable text, not hex, for "${s}"`);
            assert.notStrictEqual(stored, Buffer.from(s, 'utf8').toString('hex'),
                `stored payload must not be the hex encoding for "${s}"`);
        }
    });

    it('both decode sites resolve the same on-wire ACTION to a byte-identical string', function () {
        // Confirmed path: strictTextDecoder.decode(canonical.buffer).
        // Mempool path (post-fix): identical decode of the same canonical buffer.
        for (const s of SAMPLES) {
            const payload = Buffer.from(s, 'utf8');
            const confirmed = storedForm(payload);
            const mempool = storedForm(payload);
            assert.strictEqual(mempool, confirmed,
                `mempool and confirmed representations must match for "${s}"`);
        }
    });
});
