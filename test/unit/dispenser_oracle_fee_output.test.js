// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// PRICE v1 oracle-usage-fee output capture.
//
// A Mode B dispenser pays its oracle operator up front as a real native-coin output and
// the indexer REJECTS the create/refill when it cannot see that output in
// `transaction_outputs` (xchain-indexer utility.validateOracleFee). The decoder used to
// persist only the protocol FEE_DESTINATION output and COINPAY outputs, so the oracle
// output was dropped and EVERY fee-bearing Mode B create was rejected identically whether
// or not the payer paid. A live e2e found this; no unit test could have, because every
// indexer unit test supplies TX_OUTPUTS directly.
//
// These tests drive the REAL block loop (decoder.start), the same harness
// dispenserLifecycleMirror.test.js uses, and assert on what reaches
// db.insertTransactionOutput.
//
// SENSITIVITY: the two capture assertions fail against pre-fix code (no output is
// persisted for either the create or the refill, since neither address is the
// feeDestination).

const assert = require('assert')
const { DispenserModel, buildDecoder, T0, SOURCE, ORACLE, ORACLE_A, ORACLE_B, FEE_DEST,
        OTHER, createWith, REFILL, isOracleFeeCaptureActive, isOracleFeeSetCaptureActive,
        oracleAddressFromCreate, isCompactedOracleAddress, ORACLE_FEE_OUTPUT_ACTIVATION,
        ORACLE_FEE_SET_CAPTURE_ACTIVATION } =
    require('./dispenser_oracle_fee_output.test/helpers/support.js')

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    this.timeout(0)

    it('captures the oracle-fee output of a v0 Mode B create', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([{
            id: 'create01', action: createWith(ORACLE), source: SOURCE,
            outputs: [
                { destinationAddress: ORACLE,   vout: 0, amount: '0.00001000' },
                { destinationAddress: OTHER,    vout: 1, amount: '1.00000000' },  // change: never captured
            ],
        }], model)

        await decoder.start()

        assert.strictEqual(decoder.captured.length, 1,
            'exactly the oracle-fee output is persisted (the change output is not)')
        assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE)
        assert.strictEqual(decoder.captured[0].amount, '0.00001000')
    })

    it('captures BOTH the protocol fee output and the oracle-fee output on one create', async () => {
        // The realistic shape on LTC/DOGE (native fee mandatory) and on any BTC create
        // that pays its protocol fee in coin. Both rows must land: the indexer validates
        // the native fee AND the oracle fee from the same TX_OUTPUTS set.
        const model = new DispenserModel()
        const decoder = buildDecoder([{
            id: 'create01', action: createWith(ORACLE), source: SOURCE,
            outputs: [
                { destinationAddress: FEE_DEST, vout: 0, amount: '0.00002000' },
                { destinationAddress: ORACLE,   vout: 1, amount: '0.00001000' },
                { destinationAddress: OTHER,    vout: 2, amount: '1.00000000' },
            ],
        }], model)

        await decoder.start()

        const addresses = decoder.captured.map(o => o.destinationAddress).sort()
        assert.deepStrictEqual(addresses, [FEE_DEST, ORACLE].sort())
    })
})

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    this.timeout(0)

    it('captures a v2 refill oracle-fee output using the stored dispenser oracle address', async () => {
        // The v2 payload names no address (it targets DISPENSER_ACTION_INDEX, an indexer
        // id the decoder does not maintain), so the address comes from the open row the
        // create registered, resolved by SOURCE.
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: createWith(ORACLE), source: SOURCE, outputs: [] },
            { id: 'refill01', action: REFILL, source: SOURCE,
              outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00000600' }] },
        ], model)

        await decoder.start()

        assert.strictEqual(model.rows.length, 1, 'the create registered an open dispenser')
        assert.strictEqual(model.rows[0].oracleAddress, ORACLE,
            'the create stored its ORACLE_ADDRESS for the refill to resolve')
        assert.strictEqual(decoder.captured.length, 1)
        assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE)
        assert.strictEqual(decoder.captured[0].amount, '0.00000600')
    })
})
