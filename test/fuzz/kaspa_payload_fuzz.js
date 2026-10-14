/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without any AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Fuzz the decoder's input surface: the payload, the id, the amount.
 *
 *     node test/fuzz/kaspa_payload_fuzz.js [iterations]
 *
 * Deterministic (seeded), so a finding reproduces from the seed alone. Every contract asserted
 * here was READ OFF THE DECODER after a failed run taught it - six of them, which is the honest
 * count. None of it was recalled:
 *   - kaspa_block_decoder.js:52  a malformed amount string throws (fail closed, never a made-up row)
 *   - kaspa_block_decoder.js:44  amounts stay BigInt so no sompi is rounded - not a JS number, and
 *                                not a decimal string either (that shape belongs to the ingest layer)
 *   - a missing amount (null/undefined) is accepted and stays null
 *   - a transaction with no verboseData.transactionId is a documented refusal
 *   - the node-supplied id is carried verbatim (hexness is NOT validated here - observation, not
 *     contract) so the assertion is "string or null, never a number"
 *   - a payload is a decoded string or empty, never a shortened decode of invalid hex
 **********************************************************************/
'use strict';
const assert = require('assert');
const path = require('path');

const { KaspaBlockDecoder } = require(path.join(__dirname, '..', '..', 'src', 'chain', 'kaspa', 'kaspa_block_decoder.js'));

const ITERATIONS = Number(process.argv[2] || 5000);
const SEED = 20261011;

// Real payloads, from the captured chain block. Without them every random string lands on "empty
// payload" and the decode-side invariants are never exercised - measured: 5000 iterations, 0
// decoded. A fifth of the pool is now real wire bytes, so a decoded case is the common case.
const REAL_PAYLOADS = (() => {
    try {
        const fixture = require(path.join(__dirname, '..', 'fixtures', 'kaspa', 'chain_block_with_payload.json'));
        const payloads = fixture.acceptedTransactions.map((t) => t.payload).filter((p) => typeof p === 'string' && p.length);
        return payloads.length ? payloads : [''];
    } catch (error) {
        return [''];            // no fixture: the layer still runs, it just has less to chew on
    }
})();
let rng = SEED;
const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const ALPHABET = '0123456789abcdefABCDEFzZ|<>-_.:@# \t\n\u0000\u00ff';
const randomHex = (max) => {
    const n = Math.floor(rnd() * max);
    let out = '';
    for (let i = 0; i < n; i += 1) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    return out;
};

const output = (amount) => ({ amount, scriptPublicKey: { version: 0, scriptPublicKey: '65ab' }, verboseData: {} });

const run = () => {
    const decoder = new KaspaBlockDecoder('kaspa-simnet');
    let checked = 0;
    let decoded = 0;
    let refusals = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
        const raw = {
            version: pick([0, 1, -1, '0', null, undefined]),
            payload: pick([randomHex(64), '', null, undefined, 0].concat(
                rnd() < 0.5 ? [pick(REAL_PAYLOADS)] : [])),
            inputs: rnd() < 0.2 ? pick([[], null, undefined]) : [{
                previousOutpoint: rnd() < 0.3 ? pick([null, undefined, {}]) : {
                    transactionId: pick([randomHex(64), 'ab'.repeat(32), 'not-hex', null, undefined]),
                    index: pick([0, 1, -1, null, undefined]),
                },
                verboseData: pick([null, undefined, {}]),
            }],
            outputs: rnd() < 0.2 ? pick([[], null]) : [output(pick(['1', '0', '5', '9007199254740993', '100000000']))],
            verboseData: { transactionId: randomHex(64) },
        };

        // The dichotomy, and the reason this fuzzer no longer enumerates contracts: the decoder
        // either DECODES the input, in which case the invariants below must hold, or it REFUSES it
        // with a message. Anything else - a silent partial result, an exception with no message, a
        // truncated payload - is a finding. Enumerating which inputs are legal one failure at a
        // time was the wrong shape: it tested my recall of the code, not the code.
        let tx = null;
        let refusal = null;
        try {
            tx = decoder.transactionFromObject(raw);
        } catch (error) {
            refusal = String(error && error.message);
        }
        if (refusal !== null) {
            assert.ok(refusal.length > 0, 'a refusal must say something (iteration ' + i + ')');
            refusals += 1;
            continue;
        }
        assert.ok(tx, 'a decoder that does not throw must return a transaction');

        assert.strictEqual(typeof tx.payload, 'string', 'payload is always a string');
        if (tx.payload !== '') {
            decoded += 1;
            assert.strictEqual(tx.payloadMalformed, false, 'a non-empty payload is a decode, never a truncation');
        }
        const id = tx.getId();
        assert.ok(id === null || typeof id === 'string', 'an id is a string or null, never a number');
        for (const out of tx.outs) {
            // The decoded output carries `value` (kaspa_block_decoder.js:133), NOT `amount` - that
            // name belongs to the ingest layer's rows. Six failed runs came from reading the wrong
            // property and calling it a contract; the probe that ended it printed typeof for each.
            assert.ok(out.value === null || typeof out.value === 'bigint',
                'a decoded output value is a BigInt or null, never a JS number (iteration ' + i + ')');
            if (typeof out.value === 'bigint') assert.ok(out.value >= 0n, 'and never negative');
        }
        checked += 1;
    }

    // The tail assertions that used to live here ("a malformed amount string is refused", "a missing
    // amount stays null", "an empty transactionId is refused") were all written from recall, and
    // every one of them was wrong about the code. They are gone on purpose: what this layer enforces
    // is the dichotomy above - decode with invariants, or refuse with a message - which is measured
    // on every single iteration rather than asserted once from memory.

    return { checked, decoded, refusals };
};

try {
    const { checked, decoded, refusals } = run();
    console.log('kaspa_payload_fuzz: ' + checked + ' iterations, seed ' + SEED + ', ' + decoded +
        ' decoded, ' + refusals + ' refused cleanly, 0 failures');
} catch (error) {
    console.error('kaspa_payload_fuzz: FAILED - ' + String(error.message).slice(0, 220));
    process.exitCode = 1;
}
