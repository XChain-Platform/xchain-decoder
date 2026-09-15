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
    this.timeout(0)

    it('captures nothing extra on a non-Mode-B (FIAT_AMOUNT-only) create', async () => {
        // Mode A reads validator snapshots and has no payee, so no oracle fee exists and
        // no additional output may be captured: only the protocol fee output.
        const model = new DispenserModel()
        const decoder = buildDecoder([{
            id: 'create01', action: `DISPENSER|0|BTC|TICK|1||10|BTC||0||USD|0.05||${T0 + 1000}`,
            source: SOURCE,
            outputs: [
                { destinationAddress: FEE_DEST, vout: 0, amount: '0.00002000' },
                { destinationAddress: ORACLE,   vout: 1, amount: '0.00001000' },
            ],
        }], model)

        await decoder.start()

        assert.strictEqual(decoder.captured.length, 1)
        assert.strictEqual(decoder.captured[0].destinationAddress, FEE_DEST)
    })

    it('captures nothing for a compacted ^<id> ORACLE_ADDRESS, and says so', async () => {
        // The id lives in the INDEXER's address space; the decoder cannot resolve it, so
        // capturing against the raw token would key on a string no output can pay. The
        // create is left to be rejected (fail-closed) and the reason is logged.
        const model = new DispenserModel()
        const decoder = buildDecoder([{
            id: 'create01', action: createWith('^57'), source: SOURCE,
            outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00001000' }],
        }], model)

        const errors = []
        const realError = console.error
        console.error = (...a) => errors.push(a.join(' '))
        try { await decoder.start() } finally { console.error = realError }

        assert.strictEqual(decoder.captured.length, 0)
        assert.ok(errors.some(e => e.includes('compacted ORACLE_ADDRESS')),
            'the unresolvable reference is surfaced, not silently dropped')
        // The message must quote the token from the SAME slot the capture decision read,
        // or the field-position-drift investigation this line exists to serve is handed a
        // neighbouring field. '^57' sits at ORACLE_ADDRESS_INDEX; its neighbours in this
        // fixture are '' (FIAT_AMOUNT) and the expiration, so a slot slip shows up here.
        assert.ok(errors.some(e => e.includes("reference '^57'")),
            'the log quotes the ORACLE_ADDRESS slot itself, not a neighbouring field')
        assert.strictEqual(model.rows[0].oracleAddress, null,
            'and no junk ^<id> token is stored on the dispenser row')
    })
})

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    this.timeout(0)

    it('rolls the block back when the v2 oracle-address lookup faults', async () => {
        // Capturing nothing on a DB fault would make this node disagree with a healthy one
        // about what the transaction paid, so the block must be retried rather than
        // committed with a partial output set. The fault stops the loop here (a real
        // decoder retries the same block indefinitely, which is the intended behavior and
        // would not terminate under test).
        const model = new DispenserModel()
        let calls = 0
        const decoder = buildDecoder([
            { id: 'refill01', action: REFILL, source: SOURCE,
              outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00000600' }] },
        ], model, { oracleLookup: async () => { calls++; decoder.stopFlag = true; return false } })
        let commits = 0
        decoder.db.commitTransaction = async () => { commits++; decoder.stopFlag = true; return true }

        await decoder.start()

        assert.strictEqual(calls, 1, 'the lookup ran')
        assert.strictEqual(decoder.captured.length, 0, 'nothing was written on the faulting pass')
        assert.strictEqual(commits, 0, 'the block was not committed with a partial output set')
    })
})

// One SOURCE, several open Mode B dispensers, different oracles. The v2 payload names
// its target by DISPENSER_ACTION_INDEX (an indexer id the decoder does not maintain),
// so the legacy lookup RANKED the source's open rows and took one. A refill of any
// other row then resolved the wrong oracle, and because capture is an address equality
// test it captured NOTHING - the indexer, which resolves the exact target, rejected a
// valid refill for a missing oracle fee after the payer's coin was already spent.
// Above ORACLE_FEE_SET_CAPTURE_ACTIVATION capture tests membership over the whole set,
// so every row's refill captures; below it the legacy pick stands, byte-for-byte.

// create01 (ORACLE_A) then create02 (ORACLE_B), both from SOURCE, then a refill
// paying `payTo`. create02 outranks create01 (higher tx_index), so a refill of
// create01 is exactly the case the single-pick gets wrong.
const twoOpenThenRefill = (payTo) => ([
    { id: 'create01', action: createWith(ORACLE_A), source: SOURCE, outputs: [] },
    { id: 'create02', action: createWith(ORACLE_B), source: SOURCE, outputs: [] },
    { id: 'refill01', action: REFILL, source: SOURCE,
      outputs: [{ destinationAddress: payTo, vout: 0, amount: '0.00000600' }] },
])

// regtest is genesis-on for both gates. mainnet arms set capture at the base gate's own
// instant since the 2026-09-09 ruling, so no mainnet block time sits between the two
// gates any more: the pre-fix single-pick behavior is reached by disarming the set gate
// in place instead. It stays live code for any network that arms mid-chain, and a
// re-decode of pre-flag-day history must still reproduce it.
const ABOVE = { network: 'bitcoin-regtest', blockTime: T0 }
const BELOW = { network: 'bitcoin-mainnet', blockTime: ORACLE_FEE_OUTPUT_ACTIVATION.mainnet,
                feeDestination: null }

// Run `fn` with mainnet set capture disarmed, restoring the ruling's armed value even
// if the body throws, so a failure here cannot leak a null into a later test.
async function withSetCaptureDisarmed(fn){
    const saved = ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet
    ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet = null
    try { await fn() }
    finally { ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet = saved }
    assert.strictEqual(ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet,
        ORACLE_FEE_OUTPUT_ACTIVATION.mainnet,
        'the map must be back to the armed instant after the probe')
}

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    describe("set-membership capture over a source's open Mode B dispensers", function () {
        it('captures the oracle of a NON-top-ranked open dispenser on ARMED mainnet', async () => {
            // The state the 2026-09-09 ruling put mainnet in, driven at the armed instant: the
            // refill of the older row captures its own oracle, not the top-ranked one's.
            const model = new DispenserModel()
            const decoder = buildDecoder(twoOpenThenRefill(ORACLE_A), model,
                { network: 'bitcoin-mainnet', blockTime: ORACLE_FEE_SET_CAPTURE_ACTIVATION.mainnet,
                  feeDestination: null })

            await decoder.start()

            assert.strictEqual(model.rows.length, 2, 'both creates registered open dispensers')
            assert.strictEqual(decoder.captured.length, 1)
            assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE_A)
        })

        it('captures the oracle of a NON-top-ranked open dispenser above the gate', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder(twoOpenThenRefill(ORACLE_A), model, ABOVE)

            await decoder.start()

            assert.strictEqual(model.rows.length, 2, 'both creates registered open dispensers')
            assert.strictEqual(decoder.captured.length, 1,
                'the refill of the older dispenser captured its oracle-fee output')
            assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE_A)
            assert.strictEqual(decoder.captured[0].amount, '0.00000600')
        })

        it('captures the top-ranked dispenser oracle above the gate too', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder(twoOpenThenRefill(ORACLE_B), model, ABOVE)

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 1)
            assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE_B)
        })
    })
})

describe("DISPENSER PRICE v1 oracle-fee output capture", function () {
    describe("set-membership capture over a source's open Mode B dispensers", function () {
        it('captures nothing for an address outside the set, above the gate', async () => {
            // The widening is bounded by the source's own open dispensers: an unrelated
            // payee (change, a counterparty) is still not a transaction_output.
            const model = new DispenserModel()
            const decoder = buildDecoder(twoOpenThenRefill(OTHER), model, ABOVE)

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 0)
        })

        it('keeps the legacy single-pick below the gate: the older row captures nothing', async () => {
            // The defect itself, pinned. Changing this is a consensus change: a re-decode
            // of pre-flag-day history must reproduce the output set the fleet wrote live.
            const model = new DispenserModel()
            await withSetCaptureDisarmed(async () => {
                const decoder = buildDecoder(twoOpenThenRefill(ORACLE_A), model, BELOW)

                await decoder.start()

                assert.strictEqual(model.rows.length, 2, 'both creates registered open dispensers')
                assert.strictEqual(decoder.captured.length, 0,
                    'below the gate the wrong oracle is resolved and no output is persisted')
            })
        })

        it('keeps the legacy single-pick below the gate: the top-ranked row still captures', async () => {
            const model = new DispenserModel()
            await withSetCaptureDisarmed(async () => {
                const decoder = buildDecoder(twoOpenThenRefill(ORACLE_B), model, BELOW)

                await decoder.start()

                assert.strictEqual(decoder.captured.length, 1)
                assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE_B)
            })
        })
    })
})
