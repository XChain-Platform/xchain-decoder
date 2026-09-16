// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')

// ─── MAX_ACTION_DATA_LENGTH export ──────────────────────────────────────────
describe('XChainDecoder.MAX_ACTION_DATA_LENGTH', () => {
    it('should be exported as a numeric constant', () => {
        assert.strictEqual(typeof XChainDecoder.MAX_ACTION_DATA_LENGTH, 'number')
    })

    it('should equal 8192 (protocol canonical value)', () => {
        assert.strictEqual(XChainDecoder.MAX_ACTION_DATA_LENGTH, 8192)
    })
})
