// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.


const assert = require('assert')
const { DispenserModel, buildDecoder, T0, SOURCE, ORACLE, ORACLE_A, ORACLE_B, FEE_DEST,
        OTHER, createWith, REFILL, isOracleFeeCaptureActive, isOracleFeeSetCaptureActive,
        oracleAddressFromCreate, isCompactedOracleAddress, ORACLE_FEE_OUTPUT_ACTIVATION,
        ORACLE_FEE_SET_CAPTURE_ACTIVATION } =
    require('./helpers/support.js')

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    describe("field extraction", function () {
        it('reads ORACLE_ADDRESS from position 13 of the v0 format', function () {
            const fields = createWith(ORACLE).split('|')
            assert.strictEqual(fields[13], ORACLE)
            assert.strictEqual(oracleAddressFromCreate(fields), ORACLE)
        })

        it('returns null for an absent, empty or compacted ORACLE_ADDRESS', function () {
            assert.strictEqual(oracleAddressFromCreate(createWith('').split('|')), null)
            assert.strictEqual(oracleAddressFromCreate(createWith('^57').split('|')), null)
            assert.strictEqual(oracleAddressFromCreate('DISPENSER|0|BTC'.split('|')), null)
            assert.strictEqual(oracleAddressFromCreate(null), null)
        })

        it('distinguishes "no oracle named" from "oracle named but compacted"', function () {
            assert.strictEqual(isCompactedOracleAddress(createWith('^57').split('|')), true)
            assert.strictEqual(isCompactedOracleAddress(createWith(ORACLE).split('|')), false)
            assert.strictEqual(isCompactedOracleAddress(createWith('').split('|')), false)
        })
    })
})
