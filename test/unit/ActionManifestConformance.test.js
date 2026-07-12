// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard. "What actions exist" is
// re-encoded as an independent literal in ~6 repos; forgetting the decoder
// VALID_ACTION_NAMES entry silently DROPS every on-chain instance of a new
// action at decode (a continue + console.error, no test failure). The
// authoritative set lives in xchain-documentation/protocol/action-manifest.json
// and is vendored here byte-identically. This guard asserts the local decoder
// set equals the manifest's wireDecoded slice, so a forgotten wiring fails loud.

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

// Strip // line comments and /* */ blocks so commented-out entries do not count.
function decomment(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}
function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localDecoderSet() {
    const src = decomment(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder.js'), 'utf8'));
    const m = src.match(/VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'could not locate VALID_ACTION_NAMES Set literal in src/XChainDecoder.js');
    return [...new Set([...m[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1]))].sort();
}

describe('ACTION manifest conformance: decoder wireDecoded set @regression', function () {
    it('VALID_ACTION_NAMES exactly equals the manifest wireDecoded slice', function () {
        const expected = manifestSlice('wireDecoded');
        const actual   = localDecoderSet();
        const missing = expected.filter(a => !actual.includes(a)); // manifest says decode, decoder forgot
        const extra   = actual.filter(a => !expected.includes(a));  // decoder decodes, manifest unaware
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'decoder VALID_ACTION_NAMES drifted from action-manifest.json wireDecoded set. ' +
            'MISSING (in manifest, not decoded -> on-chain instances silently dropped): ' + JSON.stringify(missing) +
            '. EXTRA (decoded, not in manifest -> add an entry): ' + JSON.stringify(extra) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, or wire the decoder.');
    });

    // IDENTITY: the vendored copy must match the canonical source (skip when the
    // sibling xchain-documentation is not checked out, matching the existing
    // ConsensusPrimitiveConformance convention).
    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical action-manifest.json not found at ' + CANON); this.skip(); } });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});
