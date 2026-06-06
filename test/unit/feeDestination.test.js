// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

// Unit test for the constructor's fee-destination normalization (the gate the storage path uses
// to decide whether to persist a fee-destination output to transaction_outputs). No DB / node
// connection is exercised — only the constructor's handling of the feeDestination argument.
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const REAL_ADDR   = 'mfeeDestinationRegtestAddr1111111111'

function build(feeDestination){
    return new XChainDecoder('bitcoin-regtest', 'h', 3306, 'db', 'u', 'p', 'n', 1, 'nu', 'np', false, feeDestination)
}

describe('XChainDecoder fee destination @unit', () => {
    it('keeps a real fee destination address', () => {
        assert.strictEqual(build(REAL_ADDR).feeDestination, REAL_ADDR)
    })

    it('treats the unset placeholder as null (capture disabled)', () => {
        assert.strictEqual(build(PLACEHOLDER).feeDestination, null)
    })

    it('treats a missing fee destination as null', () => {
        assert.strictEqual(build(undefined).feeDestination, null)
        assert.strictEqual(build(null).feeDestination, null)
        assert.strictEqual(build('').feeDestination, null)
    })
})
