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
    describe("activation gate", function () {
        it('is genesis-on for testnet and regtest and armed to the fan-out flag-day on mainnet', function () {
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.regtest, 0)
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.testnet, 0)
            // Must equal the indexer's FIX_OUTPUT_FANOUT timestamp: capturing a second
            // output below that flag-day halts the block as a fan-out fault.
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.mainnet, 1786060800)
        })

        it('captures nothing on mainnet below the flag-day', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder([{
                id: 'create01', action: createWith(ORACLE), source: SOURCE,
                outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00001000' }],
            }], model, { network: 'bitcoin-mainnet', blockTime: 1786060799, feeDestination: null })

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 0,
                'below the flag-day the fee output stays invisible, so the create fails closed')
        })

        it('captures at and above the flag-day on mainnet', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder([{
                id: 'create01', action: createWith(ORACLE), source: SOURCE,
                outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00001000' }],
            }], model, { network: 'bitcoin-mainnet', blockTime: 1786060800, feeDestination: null })

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 1)
            assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE)
        })

        it('never arms set capture before the base capture gate on any network', function () {
            // Set capture only WIDENS a capture the base gate switched on, so a value below
            // it would be meaningless, and one above it must still be a real instant. null
            // means DISARMED: that network keeps the legacy single-pick until its
            // maintainers ratify an instant.
            for (const network of Object.keys(ORACLE_FEE_SET_CAPTURE_ACTIVATION)) {
                const setGate  = ORACLE_FEE_SET_CAPTURE_ACTIVATION[network]
                const baseGate = ORACLE_FEE_OUTPUT_ACTIVATION[network]
                assert.ok(setGate === null || typeof setGate === 'number',
                    network + ' must be a block time or null (DISARMED)')
                if (typeof setGate === 'number')
                    assert.ok(setGate >= baseGate,
                        network + ' set capture (' + setGate + ') must not precede oracle-fee ' +
                        'capture (' + baseGate + ')')
            }
            assert.strictEqual(ORACLE_FEE_SET_CAPTURE_ACTIVATION.regtest, 0,
                'regtest holds no agreed history, so it stays genesis-on and exercises the set path')
        })
    })
})

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    describe("activation gate", function () {
        it('reads a DISARMED (null) network entry as never active, at any block time', function () {
            for (const network of Object.keys(ORACLE_FEE_SET_CAPTURE_ACTIVATION)) {
                const setGate = ORACLE_FEE_SET_CAPTURE_ACTIVATION[network]
                if (setGate === null) {
                    assert.strictEqual(isOracleFeeSetCaptureActive(network, 4000000000), false,
                        network + ' is disarmed, so no block time may switch set capture on')
                    continue
                }
                assert.strictEqual(isOracleFeeSetCaptureActive(network, setGate), true)
                assert.strictEqual(isOracleFeeSetCaptureActive(network, setGate - 1), false)
            }
        })

        it('fails set capture closed on an unrecognized network or an unusable block time', function () {
            assert.strictEqual(isOracleFeeSetCaptureActive('signet', 4000000000), false)
            assert.strictEqual(isOracleFeeSetCaptureActive(undefined, 4000000000), false)
            assert.strictEqual(isOracleFeeSetCaptureActive('regtest', NaN), false)
        })

        it('fails closed on an unrecognized network rather than capturing from genesis', function () {
            assert.strictEqual(isOracleFeeCaptureActive('mainnet', 1786060800), true)
            assert.strictEqual(isOracleFeeCaptureActive('mainnet', 1786060799), false)
            assert.strictEqual(isOracleFeeCaptureActive('regtest', 0), true)
            assert.strictEqual(isOracleFeeCaptureActive('signet', 4000000000), false)
            assert.strictEqual(isOracleFeeCaptureActive(undefined, 4000000000), false)
            assert.strictEqual(isOracleFeeCaptureActive('regtest', NaN), false)
        })
    })
})
