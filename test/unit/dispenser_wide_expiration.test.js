'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const {
    DISPENSER_WIDE_EXPIRATION_ACTIVATION,
    MAX_SAFE_DISPENSER_EXPIRATION,
    U64_MAX,
    isDispenserWideExpirationActive,
    normalizeDispenserExpiration,
} = require('../../src/XChainDecoder/dispenser_wide_expiration.js')
const {
    collectDispenserCreates,
    dispenserEditExtension,
} = require('../../src/XChainDecoder/dispenser_registration.js')
const constants = require('../../src/protocol/constants.js')

const MAX_SAFE = String(Number.MAX_SAFE_INTEGER)
const FIRST_WIDE = '9007199254740992'
const SECOND_WIDE = '9007199254740993'
const U64_MAX_TOKEN = String(U64_MAX)
const U64_OVERFLOW = '18446744073709551616'

function createCommand(expiration){
    return `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${expiration}`
}

function editCommand(expiration){
    return `DISPENSER|2|123||${expiration}`
}

function context(network){
    return {
        consensusNetwork: network,
        parseErrors: 0,
        getDefaultExpiration: timestamp => timestamp + 86400,
        dispenserOpensForThisChain: () => true,
        hasRequiredDispenserCreateFields: () => true,
    }
}

function collect(expiration, network, blockTime){
    const decoder = context(network)
    const registrations = collectDispenserCreates.call(
        decoder,
        [createCommand(expiration)],
        'DISPENSER|',
        { source: 'source-address' },
        { timestamp: blockTime },
        'tx-hash',
        12,
    )
    return { decoder, registrations }
}

describe('DISPENSER wide expiration', function () {
    it('pins the activation map and public constants export', function () {
        assert.deepStrictEqual(DISPENSER_WIDE_EXPIRATION_ACTIVATION, {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        })
        assert.strictEqual(
            constants.DISPENSER_WIDE_EXPIRATION_ACTIVATION,
            DISPENSER_WIDE_EXPIRATION_ACTIVATION,
        )
    })

    it('uses inclusive activation semantics and fails closed', function () {
        const gate = DISPENSER_WIDE_EXPIRATION_ACTIVATION.mainnet
        assert.strictEqual(isDispenserWideExpirationActive('mainnet', gate - 1), false)
        assert.strictEqual(isDispenserWideExpirationActive('mainnet', gate), true)
        assert.strictEqual(isDispenserWideExpirationActive('unknown', gate), false)
        assert.strictEqual(isDispenserWideExpirationActive('regtest', 'not-a-time'), false)
    })

    it('keeps every safe unsigned integer exact on both sides of the gate', function () {
        const gate = DISPENSER_WIDE_EXPIRATION_ACTIVATION.mainnet
        for (const token of ['0', '4294967295', MAX_SAFE]){
            const expected = Number(token)
            assert.strictEqual(normalizeDispenserExpiration(token, 'mainnet', gate - 1), expected)
            assert.strictEqual(normalizeDispenserExpiration(token, 'mainnet', gate), expected)
        }
    })

    it('clamps every decimal token in the u64 gap without Number rounding', function () {
        for (const token of [FIRST_WIDE, SECOND_WIDE, U64_MAX_TOKEN]){
            assert.strictEqual(
                normalizeDispenserExpiration(token, 'regtest', 0),
                MAX_SAFE_DISPENSER_EXPIRATION,
                token,
            )
        }
        assert.strictEqual(normalizeDispenserExpiration('+' + FIRST_WIDE, 'regtest', 0), MAX_SAFE_DISPENSER_EXPIRATION)
        assert.strictEqual(normalizeDispenserExpiration('  ' + FIRST_WIDE + '  ', 'regtest', 0), MAX_SAFE_DISPENSER_EXPIRATION)
        assert.strictEqual(normalizeDispenserExpiration(FIRST_WIDE + '.0', 'regtest', 0), MAX_SAFE_DISPENSER_EXPIRATION)
        assert.strictEqual(normalizeDispenserExpiration('9.007199254740992e15', 'regtest', 0), MAX_SAFE_DISPENSER_EXPIRATION)
    })

})

describe('DISPENSER wide expiration registration', function () {
    it('retains the historical rejection below the gate', function () {
        const gate = DISPENSER_WIDE_EXPIRATION_ACTIVATION.mainnet
        assert.strictEqual(normalizeDispenserExpiration(FIRST_WIDE, 'mainnet', gate - 1), null)
        const { decoder, registrations } = collect(FIRST_WIDE, 'mainnet', gate - 1)
        assert.deepStrictEqual(registrations, [])
        assert.strictEqual(decoder.parseErrors, 1)
    })

    it('rejects values the indexer u64 column cannot represent', function () {
        for (const token of [U64_OVERFLOW, U64_OVERFLOW + '.0', '-1', '1.5', '1e300', '', 'not-a-number']){
            assert.strictEqual(normalizeDispenserExpiration(token, 'regtest', 0), null, token)
        }
    })

    it('registers a wide create at the clamped advisory expiration', function () {
        const { decoder, registrations } = collect(U64_MAX_TOKEN, 'regtest', 0)
        assert.strictEqual(decoder.parseErrors, 0)
        assert.deepStrictEqual(registrations, [{
            address: 'source-address',
            sourceAddress: 'source-address',
            oracleAddress: null,
            expiration: MAX_SAFE_DISPENSER_EXPIRATION,
        }])
    })

    it('extends for a wide edit using the same clamp', function () {
        const decoder = context('regtest')
        const extension = dispenserEditExtension.call(
            decoder,
            editCommand(SECOND_WIDE),
            'DISPENSER|',
            { source: 'source-address' },
            { timestamp: 1 },
        )
        assert.deepStrictEqual(extension, {
            editSource: 'source-address',
            newExpiration: MAX_SAFE_DISPENSER_EXPIRATION,
        })
    })

    it('does not extend for a wide edit below the gate or an overflowing edit', function () {
        const gate = DISPENSER_WIDE_EXPIRATION_ACTIVATION.mainnet
        const decoder = context('mainnet')
        assert.strictEqual(dispenserEditExtension.call(
            decoder, editCommand(FIRST_WIDE), 'DISPENSER|',
            { source: 'source-address' }, { timestamp: gate - 1 },
        ), null)
        decoder.consensusNetwork = 'regtest'
        assert.strictEqual(dispenserEditExtension.call(
            decoder, editCommand(U64_OVERFLOW), 'DISPENSER|',
            { source: 'source-address' }, { timestamp: 1 },
        ), null)
    })
})
