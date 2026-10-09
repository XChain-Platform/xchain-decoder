// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const constants = require('../../src/protocol/constants.js')
const activation = require('../../src/protocol/constants/activation.js')
const { isExactIntegerExpirationActive, isExactIntegerToken } =
    require('../../src/XChainDecoder/dispenser_registration.js')
const { DispenserModel, buildDecoder, T0, ADDR, CREATE } =
    require('./dispenser_lifecycle_mirror.test/helpers/support.js')

const NAME = 'EXACT_INTEGER_EXPIRATION_ACTIVATION'

function restoreActivationAround() {
    const saved = {}

    beforeEach(function () {
        for (const network of Object.keys(activation[NAME]))
            saved[network] = activation[NAME][network]
    })

    afterEach(function () {
        for (const network of Object.keys(saved))
            activation[NAME][network] = saved[network]
    })
}

describe('DISPENSER exact integer EXPIRATION activation', function () {
    restoreActivationAround()

    it('is public and UNARMED on every network', function () {
        assert.deepStrictEqual(activation[NAME], {
            mainnet: null,
            testnet: null,
            regtest: null,
        })
        assert.strictEqual(constants[NAME], activation[NAME])
        for (const network of Object.keys(activation[NAME]))
            assert.strictEqual(isExactIntegerExpirationActive(network, 4000000000), false)
        assert.strictEqual(isExactIntegerExpirationActive('unknown', 4000000000), false)
        assert.strictEqual(isExactIntegerExpirationActive('regtest', NaN), false)
    })

    it('uses inclusive block-time activation semantics', function () {
        activation[NAME].regtest = T0
        assert.strictEqual(isExactIntegerExpirationActive('regtest', T0 - 1), false)
        assert.strictEqual(isExactIntegerExpirationActive('regtest', T0), true)
        assert.strictEqual(isExactIntegerExpirationActive('regtest', T0 + 1), true)
    })

    it('tests integer value in exact decimal space', function () {
        for (const value of ['0', '-0', '+12', '12.0', '.0', '1e3', '1000e-3'])
            assert.strictEqual(isExactIntegerToken(value), true, value)
        for (const value of ['1.5', '.5', '1e-3', '1000.0000000000000001', 'text', ''])
            assert.strictEqual(isExactIntegerToken(value), false, value)
    })

})

describe('DISPENSER exact integer EXPIRATION decoding', function () {
    restoreActivationAround()

    it('preserves precision-rounded create and edit behavior below the gate', async function () {
        const model = new DispenserModel()
        const createToken = `${T0 + 1000000}.0000000001`
        const editToken = `${T0 + 2000000}.0000000001`
        const create = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${createToken}`
        const edit = `DISPENSER|2|7||${editToken}||`
        const decoder = buildDecoder([
            { id: 'create01', action: create, source: ADDR },
            { id: 'edit01', action: edit, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.extend.length, 1)
        assert.strictEqual(decoder.parseErrors, 0)
    })

    it('rejects a precision-rounded fractional create above the gate', async function () {
        activation[NAME].regtest = 0
        const model = new DispenserModel()
        const token = `${T0 + 1000000}.0000000001`
        const create = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${token}`
        const decoder = buildDecoder([
            { id: 'create01', action: create, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 0)
        assert.strictEqual(decoder.parseErrors, 1)
    })

    it('does not mirror a precision-rounded fractional edit above the gate', async function () {
        activation[NAME].regtest = 0
        const model = new DispenserModel()
        const token = `${T0 + 2000000}.0000000001`
        const edit = `DISPENSER|2|7||${token}||`
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE, source: ADDR },
            { id: 'edit01', action: edit, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.extend.length, 0)
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000)
    })

})

describe('DISPENSER exact integer EXPIRATION valid spellings', function () {
    restoreActivationAround()

    it('keeps exactly integral decimal and exponent spellings valid above the gate', async function () {
        activation[NAME].regtest = 0
        const model = new DispenserModel()
        const create = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${T0 + 1000000}.0`
        const edit = `DISPENSER|2|7||${T0 + 2000000}e0||`
        const decoder = buildDecoder([
            { id: 'create01', action: create, source: ADDR },
            { id: 'edit01', action: edit, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.extend.length, 1)
        assert.strictEqual(decoder.parseErrors, 0)
        assert.strictEqual(model.rows[0].expiration, T0 + 2000000)
    })

    it('keeps an omitted create EXPIRATION on the default path above the gate', async function () {
        activation[NAME].regtest = 0
        const model = new DispenserModel()
        const create = 'DISPENSER|0|BTC|TICK|1||10|BTC||1'
        const decoder = buildDecoder([
            { id: 'create01', action: create, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(decoder.parseErrors, 0)
    })
})
