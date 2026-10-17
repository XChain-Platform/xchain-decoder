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
const { collapseDispenserRegistrations } = require('../../../src/protocol/batch_sub_command_capture.js')

// Frozen reference for the raw-address collapse every pre-gate block re-decodes with.
// Never edit it: a different merge rule belongs behind a new activation gate, and this
// copy makes a change to the shared helper fail here before it can move replay.
function legacyRawAddressCollapse(candidates){
    const collapsed = new Map()
    if (!Array.isArray(candidates)) return []
    for (const candidate of candidates){
        if (!candidate || !candidate.address) continue
        const existing = collapsed.get(candidate.address)
        if (existing === undefined){
            collapsed.set(candidate.address, {
                address:       candidate.address,
                sourceAddress: candidate.sourceAddress,
                oracleAddress: candidate.oracleAddress || null,
                expiration:    candidate.expiration,
            })
            continue
        }
        if (candidate.expiration > existing.expiration)
            existing.expiration = candidate.expiration
        if (!existing.oracleAddress && candidate.oracleAddress)
            existing.oracleAddress = candidate.oracleAddress
    }
    return [...collapsed.values()]
}

// Deterministic linear congruential generator, so a failure names a reproducible case.
function seededRandom(seed){
    let state = seed >>> 0
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 4294967296
    }
}

function pick(random, pool){
    return pool[Math.floor(random() * pool.length)]
}

function assertMatchesFrozenReference(input){
    const snapshot = JSON.stringify(input)
    const expected = legacyRawAddressCollapse(input)
    for (const actual of [collapseDispenserRegistrations(input), collapseDispenserRegistrations(input, 'mainnet', 1)]){
        assert.deepStrictEqual(actual, expected)
        assert.strictEqual(JSON.stringify(input), snapshot)
        if (Array.isArray(input))
            for (const row of actual) assert.ok(!input.includes(row))
    }
}

describe('collapseDispenserRegistrations below the address-id gate', function () {

    it('matches the frozen raw-address reference on non-list and sparse inputs', function () {
        for (const input of [undefined, null, 'mabc', { address: 'mabc' }, [], [null, undefined],
            [{ address: '' }, { sourceAddress: 's' }, { address: 'mq', sourceAddress: 's', oracleAddress: null, expiration: 1 }]])
            assertMatchesFrozenReference(input)
    })

    it('matches the frozen raw-address reference on order, ties, oracles and spellings', function () {
        assertMatchesFrozenReference([
            { address: 'mb', sourceAddress: 's1', oracleAddress: '', expiration: 5 },
            { address: 'ma', sourceAddress: 's2', oracleAddress: 0, expiration: 7 },
            { address: 'mb', sourceAddress: 's3', oracleAddress: null, expiration: 5 },
            { address: 'ma', sourceAddress: 's4', oracleAddress: undefined, expiration: '9' },
            { address: 'mb', sourceAddress: 's5', oracleAddress: 'oracle-b', expiration: undefined },
            { address: 'ma', sourceAddress: 's6', oracleAddress: 'oracle-a', expiration: null },
            { address: 'mA', sourceAddress: 's7', oracleAddress: 'oracle-c', expiration: 3 },
            { address: 'ma  ', sourceAddress: 's8', oracleAddress: null, expiration: 11 },
        ])
        assert.strictEqual(collapseDispenserRegistrations([
            { address: 'mA', expiration: 1 }, { address: 'ma', expiration: 2 }, { address: 'ma ', expiration: 3 },
        ], 'mainnet', 1).length, 3)
    })

    it('matches the frozen raw-address reference across seeded random batches', function () {
        const random = seededRandom(20261012)
        const addresses = ['ma', 'mA', 'mb', 'ma ', '', null]
        const oracles = ['', null, undefined, 0, 'oracle-1', 'oracle-2']
        const expirations = [undefined, null, 0, 1, 2, 2, 10, '3', '10']
        for (let round = 0; round < 400; round++){
            const input = []
            const size = Math.floor(random() * 7)
            for (let i = 0; i < size; i++){
                if (random() < 0.08) { input.push(null); continue }
                input.push({
                    address: pick(random, addresses),
                    sourceAddress: 'source-' + i,
                    oracleAddress: pick(random, oracles),
                    expiration: pick(random, expirations),
                })
            }
            assertMatchesFrozenReference(input)
        }
    })
})
