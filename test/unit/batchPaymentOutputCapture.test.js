// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Payment-output capture through a BATCH (BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION).
//
// Capture used to read the TOP-LEVEL action string only: `decodedData.startsWith("COINPAY|")`
// for settlement outputs, and resolveOracleFeeAddresses' `startsWith("DISPENSER|")` for
// oracle-fee outputs. Both are false for `BATCH|0|COINPAY|0|x;COINPAY|0|y`, so a BATCH
// carrying either action persisted NOTHING and the indexer saw an empty COIN_DESTINATION
// ("COINPAY (skip): destination mismatch tx= payee=<seller>", witnessed on regtest): the
// payer's coin was spent on chain and no obligation settled.
//
// These tests drive the REAL block loop (decoder.start), the same harness
// dispenserOracleFeeOutput.test.js uses, and assert on what reaches
// db.insertTransactionOutput.
//
// SENSITIVITY: every above-gate BATCH assertion fails against pre-fix code (nothing is
// persisted for a batched COINPAY or a batched Mode B DISPENSER), and every below-gate
// assertion fails if the change is landed ungated.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const { ORACLE_FEE_OUTPUT_ACTIVATION } = require('../../src/protocol/constants.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0        = 1700000000
const SOURCE    = 'bcrt1qbatchpayer'
const SELLER_A  = 'bcrt1qselleraaa'
const SELLER_B  = 'bcrt1qsellerbbb'
const ORACLE_A  = 'bcrt1qoracleoperatoraaa'
const ORACLE_B  = 'bcrt1qoracleoperatorbbb'
const FEE_DEST  = 'bcrt1qprotocolfeedest'
const CHANGE    = 'bcrt1qchangeaddress'

// COINPAY|VERSION|ORDER_ACTION_INDEX
const COINPAY_A = 'COINPAY|0|101'
const COINPAY_B = 'COINPAY|0|102'
// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const createWith = (oracleToken) =>
    `DISPENSER|0|BTC|TICK|1||10|BTC||0||USD||${oracleToken}|${T0 + 1000000}`
// DISPENSER|2|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
const REFILL = 'DISPENSER|2|7|100|||'

// Mainnet, at a block time BELOW every capture gate in the file: the legacy top-level-only
// view is what a re-decode of pre-flag-day history must reproduce.
const BELOW_GATE = { network: 'bitcoin-mainnet', blockTime: T0 }
// Mainnet, at a block time above the ORACLE_FEE_OUTPUT_ACTIVATION flag-day but still below
// the (DISARMED) sub-command gate: isolates "the oracle gate is on, the batch view is not".
const ORACLE_ON_BATCH_OFF = { network: 'bitcoin-mainnet', blockTime: ORACLE_FEE_OUTPUT_ACTIVATION.mainnet }
// regtest is genesis-on for the sub-command gate.
const ABOVE_GATE = { network: 'bitcoin-regtest', blockTime: T0 }

class DispenserModel {
    constructor() { this.rows = []; this.lookups = 0 }
    async insertDispenser({ txIndex, address, expiration, oracleAddress }) {
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null, expiredBlockIndex: null })
        return true
    }
    async extendOpenDispenserExpirationBySource() { return true }
    async deleteOpenDispensers() { return true }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
    _openFor(sourceAddress) {
        return this.rows.filter(r => r.address === sourceAddress && r.expiredBlockIndex === null)
    }
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        this.lookups++
        const open = this._openFor(sourceAddress).sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        this.lookups++
        return [...new Set(this._openFor(sourceAddress).map(r => r.oracleAddress).filter(a => !!a))]
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
        opts.network || ABOVE_GATE.network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
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
        extendOpenDispenserExpirationBySource: (s, e) => model.extendOpenDispenserExpirationBySource(s, e),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource:   (s) => (opts.oracleLookup || ((x) => model.getOpenDispenserOracleAddressBySource(x)))(s),
        getOpenDispenserOracleAddressesBySource: (s) => (opts.oracleLookup || ((x) => model.getOpenDispenserOracleAddressesBySource(x)))(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE),
                               timestamp: opts.blockTime === undefined ? T0 : opts.blockTime,
                               transactions })
    }

    decoder.captured = captured
    return decoder
}

// One transaction, run through the block loop; returns the captured output rows.
async function captureFor(action, outputs, venue, extra) {
    const model = new DispenserModel()
    const decoder = buildDecoder(
        [{ id: 'tx01', action, source: SOURCE, outputs }],
        model,
        Object.assign({}, venue, extra || {})
    )
    await decoder.start()
    decoder.model = model
    return decoder
}

const addressesOf = (rows) => rows.map(o => o.destinationAddress).sort()

// Two settlement outputs plus a change output, the shape a two-obligation COINPAY pays.
const TWO_SETTLEMENTS = [
    { destinationAddress: SELLER_A, vout: 0, amount: '1.00000000' },
    { destinationAddress: SELLER_B, vout: 1, amount: '2.00000000' },
    { destinationAddress: CHANGE,   vout: 2, amount: '5.00000000' },
]

describe('BATCH payment-output capture', function () {
    this.timeout(0)

    describe('top-level COINPAY is untouched on both sides of the gate', function () {

        it('captures every native-coin output above the gate, exactly as before', async () => {
            const decoder = await captureFor(COINPAY_A, TWO_SETTLEMENTS, ABOVE_GATE,
                { feeDestination: null })
            // A top-level COINPAY captures EVERY output, change included: settlement is
            // decided per-output by the indexer, not here.
            assert.deepStrictEqual(addressesOf(decoder.captured),
                [SELLER_A, SELLER_B, CHANGE].sort())
        })

        it('captures every native-coin output below the gate too (byte-identical)', async () => {
            const decoder = await captureFor(COINPAY_A, TWO_SETTLEMENTS, BELOW_GATE,
                { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured),
                [SELLER_A, SELLER_B, CHANGE].sort())
        })

        it('carries vout and amount through unchanged', async () => {
            const decoder = await captureFor(COINPAY_A, TWO_SETTLEMENTS, ABOVE_GATE,
                { feeDestination: null })
            const byAddress = {}
            for (const row of decoder.captured) byAddress[row.destinationAddress] = row
            assert.strictEqual(byAddress[SELLER_A].vout, 0)
            assert.strictEqual(byAddress[SELLER_A].amount, '1.00000000')
            assert.strictEqual(byAddress[SELLER_B].vout, 1)
            assert.strictEqual(byAddress[SELLER_B].amount, '2.00000000')
        })
    })

    describe('batched COINPAY', function () {

        it('captures NOTHING below the gate (the live defect, preserved for replay)', async () => {
            const decoder = await captureFor('BATCH|0|' + COINPAY_A, TWO_SETTLEMENTS,
                BELOW_GATE, { feeDestination: null })
            assert.deepStrictEqual(decoder.captured, [],
                'pre-flag-day history must re-decode to the empty output set the fleet wrote')
        })

        it('captures its settlement outputs above the gate', async () => {
            const decoder = await captureFor('BATCH|0|' + COINPAY_A, TWO_SETTLEMENTS,
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured),
                [SELLER_A, SELLER_B, CHANGE].sort(),
                'a batched COINPAY captures exactly what a top-level COINPAY captures')
        })

        it('captures the same set for several COINPAY sub-commands', async () => {
            const decoder = await captureFor(
                'BATCH|0|' + COINPAY_A + ';' + COINPAY_B, TWO_SETTLEMENTS,
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured),
                [SELLER_A, SELLER_B, CHANGE].sort())
        })

        it('captures when the COINPAY is not the FIRST sub-command', async () => {
            // The prefix strip only touches element 0, so a COINPAY anywhere in the list has
            // to select capture.
            const decoder = await captureFor(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER_A + ';' + COINPAY_A, TWO_SETTLEMENTS,
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured),
                [SELLER_A, SELLER_B, CHANGE].sort())
        })

        it('captures nothing extra for a batch with no COINPAY at all', async () => {
            const decoder = await captureFor(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER_A + ';ORDER|0|BTC|TICK|1|TICK2|2|100',
                TWO_SETTLEMENTS, ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(decoder.captured, [])
        })

        it('captures only the fee output for a non-settlement batch that pays the protocol fee', async () => {
            // The feeDestination arm of the capture condition is untouched by this change:
            // above the gate it still selects exactly the one fee output.
            const outputs = [
                { destinationAddress: FEE_DEST, vout: 0, amount: '0.00002000' },
                { destinationAddress: CHANGE,   vout: 1, amount: '5.00000000' },
            ]
            const above = await captureFor('BATCH|0|SEND|0|BTC|TICK|1|' + SELLER_A, outputs, ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(above.captured), [FEE_DEST])
            const below = await captureFor('BATCH|0|SEND|0|BTC|TICK|1|' + SELLER_A, outputs, BELOW_GATE)
            assert.deepStrictEqual(addressesOf(below.captured), [FEE_DEST],
                'the fee-output arm behaves identically on both sides of the gate')
        })

        it('captures nothing for a batch whose FORMAT prefix the indexer would not strip', async () => {
            // 'BATCH||...' leaves element 0's action as BATCH, which actionLimits rejects
            // whole-batch, so no COINPAY sub-command ever executes and capturing for one
            // would persist outputs no node acts on.
            const decoder = await captureFor('BATCH||' + COINPAY_A, TWO_SETTLEMENTS,
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(decoder.captured, [])
        })
    })

    describe('batched DISPENSER oracle-fee outputs', function () {

        const oracleOutputs = [
            { destinationAddress: ORACLE_A, vout: 0, amount: '0.00001000' },
            { destinationAddress: CHANGE,   vout: 1, amount: '1.00000000' },
        ]

        it('captures NOTHING below the gate, even with the oracle gate itself on', async () => {
            const decoder = await captureFor('BATCH|0|' + createWith(ORACLE_A), oracleOutputs,
                ORACLE_ON_BATCH_OFF, { feeDestination: null })
            assert.deepStrictEqual(decoder.captured, [],
                'the oracle gate being armed must not leak the batch view in below its own gate')
        })

        it('captures the oracle-fee output of a batched v0 Mode B create above the gate', async () => {
            const decoder = await captureFor('BATCH|0|' + createWith(ORACLE_A), oracleOutputs,
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured), [ORACLE_A],
                'exactly the oracle-fee output is persisted (the change output is not)')
            assert.strictEqual(decoder.captured[0].amount, '0.00001000')
        })

        it('captures the UNION of every DISPENSER sub-command oracle', async () => {
            // Each DISPENSER sub-command is dispatched independently and pays its own oracle,
            // so one batch can owe two operators and both outputs must be capturable.
            const decoder = await captureFor(
                'BATCH|0|' + createWith(ORACLE_A) + ';' + createWith(ORACLE_B),
                [
                    { destinationAddress: ORACLE_A, vout: 0, amount: '0.00001000' },
                    { destinationAddress: ORACLE_B, vout: 1, amount: '0.00002000' },
                    { destinationAddress: CHANGE,   vout: 2, amount: '1.00000000' },
                ],
                ABOVE_GATE, { feeDestination: null })
            assert.deepStrictEqual(addressesOf(decoder.captured), [ORACLE_A, ORACLE_B].sort())
        })

        it('resolves a batched v2 refill against the open dispenser registered by SOURCE', async () => {
            const model = new DispenserModel()
            const decoder = buildDecoder([
                { id: 'create01', action: createWith(ORACLE_A), source: SOURCE, outputs: [] },
                { id: 'refill01', action: 'BATCH|0|' + REFILL, source: SOURCE,
                  outputs: [{ destinationAddress: ORACLE_A, vout: 0, amount: '0.00000600' }] },
            ], model, Object.assign({ feeDestination: null }, ABOVE_GATE))

            await decoder.start()

            assert.strictEqual(model.rows.length, 1, 'the top-level create registered an open dispenser')
            assert.deepStrictEqual(addressesOf(decoder.captured), [ORACLE_A])
            assert.strictEqual(decoder.captured[0].amount, '0.00000600')
        })

        it('issues ONE oracle lookup for a batch of many v2 refills', async () => {
            // A v2 payload resolves purely from SOURCE, so all of them resolve identically.
            // Without the cache a 250-command batch would fire 250 identical queries inside
            // the block loop.
            const model = new DispenserModel()
            const decoder = buildDecoder([
                { id: 'create01', action: createWith(ORACLE_A), source: SOURCE, outputs: [] },
                { id: 'refill01', action: 'BATCH|0|' + [REFILL, REFILL, REFILL, REFILL].join(';'),
                  source: SOURCE,
                  outputs: [{ destinationAddress: ORACLE_A, vout: 0, amount: '0.00000600' }] },
            ], model, Object.assign({ feeDestination: null }, ABOVE_GATE))

            await decoder.start()

            assert.strictEqual(model.lookups, 1,
                'four v2 sub-commands share one resolution')
            assert.deepStrictEqual(addressesOf(decoder.captured), [ORACLE_A])
        })

        it('retries the block when a batched refill lookup faults, rather than capturing less', async () => {
            // A deterministic DB fault must never quietly persist a smaller output set than a
            // healthy node would; the loop rolls the block back instead.
            const model = new DispenserModel()
            let attempts = 0
            const decoder = buildDecoder([
                { id: 'create01', action: createWith(ORACLE_A), source: SOURCE, outputs: [] },
                { id: 'refill01', action: 'BATCH|0|' + REFILL, source: SOURCE,
                  outputs: [{ destinationAddress: ORACLE_A, vout: 0, amount: '0.00000600' }] },
            ], model, Object.assign({
                feeDestination: null,
                // regtest is genesis-on for set capture, so the accessor returns a LIST.
                oracleLookup: async () => { attempts++; return attempts === 1 ? false : [ORACLE_A] },
            }, ABOVE_GATE))

            await decoder.start()

            assert.ok(attempts >= 2, 'the faulted block was retried')
            assert.deepStrictEqual(addressesOf(decoder.captured), [ORACLE_A],
                'the retry captures what a healthy node captures')
        })
    })
})
