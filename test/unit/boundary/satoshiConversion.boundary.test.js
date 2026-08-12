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
const Database = require('../../../src/db')

describe('Boundary: bigIntSatoshiToDecimalsString (DB-6 through DB-8)', () => {
    let db

    beforeEach(() => {
        db = new Database('localhost', 3306, 'test_db', 'root', '')
    })

    it('[REGRESSION P1] R-DB-004 DB-6: 0 → "0.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(0)
        assert.strictEqual(result, '0.00000000')
    })

    it('0n (BigInt zero) → "0.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(0n)
        assert.strictEqual(result, '0.00000000')
    })

    it('DB-7: -100 → "-0.00000100"', () => {
        const result = db.bigIntSatoshiToDecimalsString(-100)
        assert.strictEqual(result, '-0.00000100')
    })

    it('-1 → "-0.00000001"', () => {
        const result = db.bigIntSatoshiToDecimalsString(-1)
        assert.strictEqual(result, '-0.00000001')
    })

    it('-100000000 → "-1.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(-100000000)
        assert.strictEqual(result, '-1.00000000')
    })

    it('-100000000n (BigInt) → "-1.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(-100000000n)
        assert.strictEqual(result, '-1.00000000')
    })

    it('-50000000 → "-0.50000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(-50000000)
        assert.strictEqual(result, '-0.50000000')
    })

    it('[REGRESSION P1] R-DB-004 DB-8: 100000000000000000n → "1000000000.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(100000000000000000n)
        assert.strictEqual(result, '1000000000.00000000')
    })

    it('[REGRESSION P1] R-DB-004: 100000000 (1 BTC) → "1.00000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(100000000)
        assert.strictEqual(result, '1.00000000')
    })

    it('1 satoshi → "0.00000001"', () => {
        const result = db.bigIntSatoshiToDecimalsString(1)
        assert.strictEqual(result, '0.00000001')
    })

    it('50000000 (0.5 BTC) → "0.50000000"', () => {
        const result = db.bigIntSatoshiToDecimalsString(50000000)
        assert.strictEqual(result, '0.50000000')
    })

    it('12345678 → "0.12345678"', () => {
        const result = db.bigIntSatoshiToDecimalsString(12345678)
        assert.strictEqual(result, '0.12345678')
    })

    it('123456789 → "1.23456789"', () => {
        const result = db.bigIntSatoshiToDecimalsString(123456789)
        assert.strictEqual(result, '1.23456789')
    })

    it('99999999 → "0.99999999" (exactly 8 digits, boundary)', () => {
        const result = db.bigIntSatoshiToDecimalsString(99999999)
        assert.strictEqual(result, '0.99999999')
    })

    it('100000000 → "1.00000000" (9 digits, crosses boundary)', () => {
        const result = db.bigIntSatoshiToDecimalsString(100000000)
        assert.strictEqual(result, '1.00000000')
    })

    it('max safe integer → valid decimal string', () => {
        const result = db.bigIntSatoshiToDecimalsString(Number.MAX_SAFE_INTEGER)
        // 9007199254740991 → "90071992.54740991"
        assert.strictEqual(result, '90071992.54740991')
        assert.ok(result.length <= 250) // fits VARCHAR(250)
    })

    it('very large BigInt → valid decimal string', () => {
        const result = db.bigIntSatoshiToDecimalsString(2100000000000000n * 100000000n)
        // 210000000000000000000000n = 2,100,000,000,000,000 BTC equivalent
        assert.ok(result.includes('.'))
        assert.ok(result.length <= 250)
    })
})
