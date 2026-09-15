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
const Database = require('../../../src/db.js')

function makeDb(name = 'test_db') {
    return new Database('127.0.0.1', 3306, name, 'user', 'pass')
}

// ============================================================================
// bigIntSatoshiToDecimalsString
// ============================================================================
describe('Database#bigIntSatoshiToDecimalsString()', () => {
    let db

    before(() => {
        db = makeDb()
    })

    it('should convert 0 satoshis to "0.00000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(0), '0.00000000')
    })

    it('should convert 1 satoshi to "0.00000001"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(1), '0.00000001')
    })

    it('should convert 100000000 satoshis (1 BTC) to "1.00000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(100000000), '1.00000000')
    })

    it('should convert 150000000 satoshis (1.5 BTC) to "1.50000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(150000000), '1.50000000')
    })

    it('should convert 99 satoshis to "0.00000099"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(99), '0.00000099')
    })

    it('should convert 10000000 satoshis (0.1 BTC) to "0.10000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(10000000), '0.10000000')
    })

    it('should handle BigInt input for 1 BTC', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(100000000n), '1.00000000')
    })

    it('should handle BigInt input for 0 satoshis', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(0n), '0.00000000')
    })

    it('should handle large value: 2100000000000000 satoshis (21M BTC)', () => {
        const result = db.bigIntSatoshiToDecimalsString(2100000000000000)
        assert.strictEqual(result, '21000000.00000000')
    })

    it('should handle negative values with a leading dash', () => {
        const result = db.bigIntSatoshiToDecimalsString(-100000000)
        assert.strictEqual(result, '-1.00000000')
    })

    it('should handle -1 satoshi', () => {
        const result = db.bigIntSatoshiToDecimalsString(-1)
        assert.strictEqual(result, '-0.00000001')
    })

    it('should handle 12345678 satoshis (0.12345678 BTC)', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(12345678), '0.12345678')
    })
})
