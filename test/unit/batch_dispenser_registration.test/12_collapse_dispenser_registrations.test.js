// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    DELEGATE_A,
    DELEGATE_B,
    EXP_EARLY,
    EXP_LATE,
    ORACLE_A,
    ORACLE_B,
    SOURCE,
    assert,
    collapseDispenserRegistrations,
} = require('./support.js')

// The collapse itself, driven directly. Its inputs are already-validated creates, so these
// pin the merge rule rather than the parsing.
describe('collapseDispenserRegistrations', function () {

    const candidate = (address, expiration, oracleAddress) =>
        ({ address, sourceAddress: SOURCE, oracleAddress: oracleAddress || null, expiration })

    it('passes a single create through unchanged (the legacy path is a no-op)', function () {
        assert.deepStrictEqual(collapseDispenserRegistrations([candidate(SOURCE, EXP_LATE, ORACLE_A)]),
            [{ address: SOURCE, sourceAddress: SOURCE, oracleAddress: ORACLE_A, expiration: EXP_LATE }])
    })

    it('keeps distinct operating addresses apart, in first-appearance order', function () {
        const out = collapseDispenserRegistrations([
            candidate(DELEGATE_B, EXP_EARLY), candidate(DELEGATE_A, EXP_LATE)])
        assert.deepStrictEqual(out.map(r => r.address), [DELEGATE_B, DELEGATE_A])
    })

    it('keeps the LATEST expiration for one address, in either order', function () {
        for (const pair of [[EXP_EARLY, EXP_LATE], [EXP_LATE, EXP_EARLY]]) {
            const out = collapseDispenserRegistrations([
                candidate(SOURCE, pair[0]), candidate(SOURCE, pair[1])])
            assert.strictEqual(out.length, 1)
            assert.strictEqual(out[0].expiration, EXP_LATE)
        }
    })

    it('keeps the first NON-EMPTY oracle for one address', function () {
        const out = collapseDispenserRegistrations([
            candidate(SOURCE, EXP_EARLY, null),
            candidate(SOURCE, EXP_LATE, ORACLE_B),
            candidate(SOURCE, EXP_EARLY, ORACLE_A)])
        assert.strictEqual(out.length, 1)
        assert.strictEqual(out[0].oracleAddress, ORACLE_B)
        assert.strictEqual(out[0].expiration, EXP_LATE)
    })

    it('drops candidates with no operating address and tolerates a non-list', function () {
        assert.deepStrictEqual(collapseDispenserRegistrations([candidate(null, EXP_LATE)]), [])
        assert.deepStrictEqual(collapseDispenserRegistrations([]), [])
        assert.deepStrictEqual(collapseDispenserRegistrations(undefined), [])
    })
})
