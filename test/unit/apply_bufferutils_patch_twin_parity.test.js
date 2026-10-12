// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// src/chain/apply_bufferutils_patch.js and src/chain/bufferutils.js are byte-identical
// twins of the xchain-utxo-tracker files at the same paths. Both services decode the
// same blocks, so a one-sided edit (the verifuint bounds, the unsigned 64-bit read, the
// writer's Number/BigInt acceptance) splits UTXO-set and action-record output values at
// the same height. Change both copies together; the tracker carries the mirror guard.
//
// Skips when the sibling checkout is absent or untrustworthy (sibling_checkout.js);
// set XCHAIN_REQUIRE_SIBLINGS=1 in CI so a missing sibling hard-fails instead.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout')

const REPO_ROOT = path.join(__dirname, '..', '..')
const TRACKER_DIR = process.env.XCHAIN_UTXO_TRACKER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-utxo-tracker')
const TWIN_FILES = ['src/chain/apply_bufferutils_patch.js', 'src/chain/bufferutils.js']

// Names the first differing line so a drift report points at the edit.
function firstDifferingLine(a, b) {
    const la = a.toString('utf8').split('\n')
    const lb = b.toString('utf8').split('\n')
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) return 'line ' + (i + 1) + ':\n  decoder: ' + la[i] + '\n  tracker: ' + lb[i]
    }
    return 'no line differs (whitespace or trailing bytes)'
}

describe('bufferutils patch twin parity with xchain-utxo-tracker @regression', function () {
    before(function () {
        const verdict = siblingCheckout(__dirname, path.join(TRACKER_DIR, TWIN_FILES[0]))
        skipOrFail(this, verdict, 'the bufferutils patch twin guard')
    })

    for (const rel of TWIN_FILES) {
        it(rel + ' is byte-identical in both repos', function () {
            const local = fs.readFileSync(path.join(REPO_ROOT, rel))
            const twin = fs.readFileSync(path.join(TRACKER_DIR, rel))
            assert.ok(local.equals(twin), rel + ' has drifted from xchain-utxo-tracker at ' + firstDifferingLine(local, twin))
        })
    }
})
