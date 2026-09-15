// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const VENDORED = path.join(__dirname, '..', '..', 'fixtures', 'roundtrip-conformance.json')

// IDENTITY: the vendored copy must match the canonical encoder fixture (skip
// when the sibling xchain-encoder is not checked out, matching the
// ActionManifestConformance convention; hard-fail under XCHAIN_REQUIRE_SIBLINGS).
describe('roundtrip conformance fixture: byte-identity to encoder original', function () {
  const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', 'xchain-encoder')
  const CANON = path.join(ENCODER, 'test', 'fixtures', 'roundtrip-conformance.json')

  before(function () {
    if (!fs.existsSync(CANON)) {
      if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical roundtrip-conformance.json not found at ' + CANON)
      }
      this.skip()
    }
  })

  it('vendored test/fixtures/roundtrip-conformance.json is byte-identical to the encoder original', function () {
    assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
      'vendored roundtrip-conformance.json drifted from the encoder original; ' +
      're-run the encoder fixture generator and re-vendor the copy here.')
  })
})
