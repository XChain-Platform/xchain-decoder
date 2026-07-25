// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// PRICE v1 oracle-usage-fee output capture (, unblocking ).
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
const XChainDecoder = require('../../src/XChainDecoder')
const { isOracleFeeCaptureActive, oracleAddressFromCreate, isCompactedOracleAddress } =
    require('../../src/oracleFeeOutput')
const { ORACLE_FEE_OUTPUT_ACTIVATION } = require('../../src/protocol/constants.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0        = 1700000000
const SOURCE    = 'bcrt1qdispenseroperator'
const ORACLE    = 'bcrt1qoracleoperator'
const FEE_DEST  = 'bcrt1qprotocolfeedest'
const OTHER     = 'bcrt1qsomeoneelse'

// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const createWith = (oracleToken) =>
    `DISPENSER|0|BTC|TICK|1||10|BTC||0||USD||${oracleToken}|${T0 + 1000000}`
// DISPENSER|2|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
const REFILL = 'DISPENSER|2|7|100|||'

class DispenserModel {
    constructor() { this.rows = [] }
    async insertDispenser({ txIndex, address, expiration, oracleAddress }) {
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null, expiredBlockIndex: null })
        return true
    }
    async cancelOpenDispenserBySource() { return true }
    async editOpenDispenserExpirationBySource() { return true }
    async deleteOpenDispensers() { return true }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this.rows
            .filter(r => r.address === sourceAddress && r.expiredBlockIndex === null)
            .sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
}

function fakeTx(id) { return { getId: () => id, outs: [] } }

function parseResultFor(dataStr, source, paymentOutputs) {
    const buf = Buffer.from(dataStr)
    return {
        data:               buf,
        source,
        destination:        null,
        amount:             0,
        dispenseOutputs:    [],
        paymentOutputs:     paymentOutputs || [],
        compiledDataLength: buf.length,
        rawData:            null,
    }
}

// txSpecs: [{ id, action, source, outputs: [{destinationAddress, vout, amount}] }]
function buildDecoder(txSpecs, model, opts) {
    opts = opts || {}
    const decoder = new XChainDecoder(
        opts.network || 'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
        false, opts.feeDestination === undefined ? FEE_DEST : opts.feeDestination
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = parseResultFor(s.action, s.source, s.outputs)
    decoder.parseTransaction = async (tx) => byId[tx.getId()]

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    }

    const captured = []
    decoder.db = {
        createDatabase:  async () => true,
        verifyDatabase:  async () => true,
        verifyTables:    async () => true,
        runMigrations:   async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex:  async () => 0,
        beginTransaction:  async () => {},
        endTransaction:    async () => {},
        commitTransaction: async () => { decoder.stopFlag = true; return true },
        insertBlock:       async () => true,
        insertEvent:       async () => true,
        insertTransaction: async () => true,
        insertTransactionOutput: async (o) => { captured.push(o); return true },
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        insertDispenser:                     (d) => model.insertDispenser(d),
        cancelOpenDispenserBySource:         (s, e) => model.cancelOpenDispenserBySource(s, e),
        editOpenDispenserExpirationBySource: (s, e) => model.editOpenDispenserExpirationBySource(s, e),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource: (s) => (opts.oracleLookup || ((x) => model.getOpenDispenserOracleAddressBySource(x)))(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE), timestamp: opts.blockTime || T0, transactions })
    }

    decoder.captured = captured
    return decoder
}

describe('DISPENSER PRICE v1 oracle-fee output capture ', function () {
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
        assert.strictEqual(model.rows[0].oracleAddress, null,
            'and no junk ^<id> token is stored on the dispenser row')
    })

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

    describe('activation gate', function () {
        it('is genesis-on for testnet and regtest and armed to the fan-out flag-day on mainnet', function () {
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.regtest, 0)
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.testnet, 0)
            // Must equal the indexer's FIX_OUTPUT_FANOUT timestamp: capturing a second
            // output below that flag-day halts the block as a fan-out fault.
            assert.strictEqual(ORACLE_FEE_OUTPUT_ACTIVATION.mainnet, 1790812800)
        })

        it('captures nothing on mainnet below the flag-day', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder([{
                id: 'create01', action: createWith(ORACLE), source: SOURCE,
                outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00001000' }],
            }], model, { network: 'bitcoin-mainnet', blockTime: 1790812799, feeDestination: null })

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 0,
                'below the flag-day the fee output stays invisible, so the create fails closed')
        })

        it('captures at and above the flag-day on mainnet', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder([{
                id: 'create01', action: createWith(ORACLE), source: SOURCE,
                outputs: [{ destinationAddress: ORACLE, vout: 0, amount: '0.00001000' }],
            }], model, { network: 'bitcoin-mainnet', blockTime: 1790812800, feeDestination: null })

            await decoder.start()

            assert.strictEqual(decoder.captured.length, 1)
            assert.strictEqual(decoder.captured[0].destinationAddress, ORACLE)
        })

        it('fails closed on an unrecognized network rather than capturing from genesis', function () {
            assert.strictEqual(isOracleFeeCaptureActive('mainnet', 1790812800), true)
            assert.strictEqual(isOracleFeeCaptureActive('mainnet', 1790812799), false)
            assert.strictEqual(isOracleFeeCaptureActive('regtest', 0), true)
            assert.strictEqual(isOracleFeeCaptureActive('signet', 4000000000), false)
            assert.strictEqual(isOracleFeeCaptureActive(undefined, 4000000000), false)
            assert.strictEqual(isOracleFeeCaptureActive('regtest', NaN), false)
        })
    })

    describe('field extraction', function () {
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
