// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Open-dispenser REGISTRATION through a BATCH (BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION).
//
// The registry gated on `decodedData.startsWith("DISPENSER")`, which is false for
// `BATCH|0|DISPENSER|0|...`. A dispenser created inside a batch therefore never entered
// getAllOpenDispenserAddresses, so payments to it were never classified as dispense outputs
// and no DISPENSE ever fired - while the INDEXER, which dispatches the sub-command, DID
// register it. Money-bearing (the buyer's coin is spent and nothing comes back) and a live
// decoder/indexer divergence. Third instance of the defect class row 21 fixed twice.
//
// These tests drive the REAL block loop (decoder.start), the same harness
// batchPaymentOutputCapture.test.js uses, and assert on what reaches db.insertDispenser,
// db.extendOpenDispenserExpirationBySource and db.insertTransactionOutput.
//
// Two things this harness models that the row-21 one did not, because registration depends
// on both:
//   * the dispensers PRIMARY KEY (tx_index, address_id). A batch can carry several creates
//     under ONE tx_index, and every create that omits GET_ADDRESS operates on the same
//     SOURCE, so the key really does collide and the second INSERT really does come back
//     DUPLICATED_TRANSACTION.
//   * parseTransaction's dispense/payment split, which is the whole point of the registry:
//     an output paying an OPEN dispenser address becomes a dispense output
//     (XChainDecoder.js ~1344). Without it "registered" proves nothing.
//
// SENSITIVITY: every above-gate BATCH assertion fails against pre-fix code (a batch
// registers nothing at all), and every below-gate assertion fails if the change lands
// ungated.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const { BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
        collapseDispenserRegistrations } = require('../../src/batchSubCommandCapture.js')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0         = 1700000000
const SOURCE     = 'bcrt1qdispenseroperator'
const DELEGATE_A = 'bcrt1qdelegatedaaa'
const DELEGATE_B = 'bcrt1qdelegatedbbb'
const ORACLE_A   = 'bcrt1qoracleoperatoraaa'
const ORACLE_B   = 'bcrt1qoracleoperatorbbb'
const BUYER      = 'bcrt1qbuyeraddress'
const SELLER     = 'bcrt1qselleraddress'
const FEE_DEST   = 'bcrt1qprotocolfeedest'
const CHANGE     = 'bcrt1qchangeaddress'

const EXP_EARLY = T0 + 100000
const EXP_LATE  = T0 + 900000

// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//   GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
// Split indices are offset by one from the indexer's field list because the decoder splits
// the ACTION token too; see hasRequiredDispenserCreateFields.
function create(opts) {
    const o = opts || {}
    return ['DISPENSER', '0',
            o.giveCoin === undefined ? 'BTC' : o.giveCoin, 'TICK', '1', '', '10',
            o.getCoin === undefined ? 'BTC' : o.getCoin, '', '0',
            o.getAddress || '', 'USD', '',
            o.oracle || '',
            o.expiration === undefined ? String(EXP_LATE) : String(o.expiration)].join('|')
}
// The 10-token shape the wallet emits when the seller keeps the default expiry: every
// optional field from GET_ADDRESS on is omitted rather than padded.
const CREATE_NO_TAIL = 'DISPENSER|0|BTC|TICK|1||10|BTC||0'
// DISPENSER|1|DISPENSER_ACTION_INDEX|MEMO
const CANCEL = 'DISPENSER|1|7|'
// DISPENSER|2|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
const refill = (expiration) => `DISPENSER|2|7|100|${expiration}|||`

// Mainnet at a block time below the (DISARMED) sub-command gate: the legacy top-level-only
// view a re-decode of pre-flag-day history must reproduce.
const BELOW_GATE = { network: 'bitcoin-mainnet', blockTime: T0 }
// regtest is genesis-on for the gate.
const ABOVE_GATE = { network: 'bitcoin-regtest', blockTime: T0 }

class DispenserModel {
    constructor() { this.rows = []; this.insertCalls = 0; this.extendCalls = [] }

    // PRIMARY KEY(tx_index, address_id) (src/sql/dispensers.sql). A colliding INSERT raises
    // errno 1062, which db.insertDispenser reports as DUPLICATED_TRANSACTION (=1), a TRUTHY
    // value the block loop reads as "stored" - so a collapse failure here is silent in
    // production and must not be silent in this harness.
    async insertDispenser({ txIndex, address, expiration, oracleAddress, sourceAddress }) {
        this.insertCalls++
        if (this.rows.some(r => r.txIndex === txIndex && r.address === address))
            return 1
        this.rows.push({ txIndex, address, expiration: Number(expiration),
                         oracleAddress: oracleAddress || null,
                         sourceAddress: (sourceAddress && sourceAddress !== address) ? sourceAddress : null,
                         expiredBlockIndex: null })
        return true
    }

    // GREATEST(expiration, ?) over every open row of the source, matched on the operating
    // address OR the stored create SOURCE; extend-only, no target selection.
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        this.extendCalls.push({ sourceAddress, newExpiration: Number(newExpiration) })
        for (const row of this.rows) {
            if (row.address !== sourceAddress && row.sourceAddress !== sourceAddress) continue
            if (row.expiredBlockIndex !== null && row.expiredBlockIndex !== blockIndex) continue
            row.expiration = Math.max(row.expiration, Number(newExpiration))
            if (row.expiredBlockIndex === blockIndex) row.expiredBlockIndex = null
        }
        return true
    }

    async deleteOpenDispensers() { return true }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
    _openFor(sourceAddress) {
        return this.rows.filter(r => (r.address === sourceAddress || r.sourceAddress === sourceAddress) &&
                                     r.expiredBlockIndex === null)
    }
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this._openFor(sourceAddress).sort((a, b) => b.txIndex - a.txIndex)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    async getOpenDispenserOracleAddressesBySource(sourceAddress) {
        return [...new Set(this._openFor(sourceAddress).map(r => r.oracleAddress).filter(a => !!a))]
    }
}

function fakeTx(id) { return { getId: () => id, outs: [] } }

// txSpecs: [{ id, action, source, outputs: [{destinationAddress, vout, amount}] }]
function buildDecoder(txSpecs, model, opts) {
    opts = opts || {}
    const decoder = new XChainDecoder(
        opts.network || ABOVE_GATE.network, 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p',
        false, opts.feeDestination === undefined ? null : opts.feeDestination
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = s

    // Mirrors the real parseTransaction's output split (XChainDecoder.js ~1344): an output
    // paying an address in the OPEN-DISPENSER set is a dispense output, every other
    // resolvable output a payment output. That set is exactly what registration feeds, so
    // the split has to be modelled for any of these assertions to mean anything.
    decoder.parseTransaction = async (tx, openDispenserAddresses) => {
        const spec = byId[tx.getId()]
        const buf = Buffer.from(spec.action || '')
        const dispenseOutputs = []
        const paymentOutputs  = []
        for (const output of (spec.outputs || [])) {
            const row = Object.assign({}, output)
            if (openDispenserAddresses && openDispenserAddresses.has(output.destinationAddress))
                dispenseOutputs.push(row)
            else
                paymentOutputs.push(row)
        }
        return {
            data:               buf,
            source:             spec.source,
            destination:        null,
            amount:             0,
            dispenseOutputs:    dispenseOutputs,
            paymentOutputs:     paymentOutputs,
            compiledDataLength: buf.length,
            rawData:            null,
        }
    }

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
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource:   (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE),
                               timestamp: opts.blockTime === undefined ? T0 : opts.blockTime,
                               transactions })
    }

    decoder.captured = captured
    decoder.model = model
    return decoder
}

// One transaction, run through the block loop.
async function runOne(action, venue, extra) {
    return runAll([{ id: 'tx01', action, source: SOURCE, outputs: [] }], venue, extra)
}

async function runAll(txSpecs, venue, extra) {
    const model = new DispenserModel()
    const decoder = buildDecoder(txSpecs, model, Object.assign({}, venue, extra || {}))
    await decoder.start()
    return decoder
}

const rowFor = (model, address) => model.rows.find(r => r.address === address)
const addressesOf = (rows) => rows.map(r => r.address).sort()

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('a top-level DISPENSER is untouched on both sides of the gate', function () {

        it('registers a top-level create above the gate', async () => {
            const decoder = await runOne(create({ oracle: ORACLE_A }), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.deepStrictEqual(decoder.model.rows[0], {
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null })
        })

        it('registers a top-level create below the gate, byte-identically', async () => {
            const decoder = await runOne(create({ oracle: ORACLE_A }), BELOW_GATE)
            assert.deepStrictEqual(decoder.model.rows, [{
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
        })

        it('defaults an omitted EXPIRATION from the block time on both sides', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(CREATE_NO_TAIL, venue)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].expiration,
                    decoder.getDefaultExpiration(T0))
            }
        })

        it('registers a delegated create on GET_ADDRESS and records the create SOURCE', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(create({ getAddress: DELEGATE_A }), venue)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].address, DELEGATE_A)
                assert.strictEqual(decoder.model.rows[0].sourceAddress, SOURCE)
            }
        })

        it('still extends on a top-level v2 edit, and registers no create row', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                    { id: 'edit01',   action: refill(EXP_LATE),                  source: SOURCE, outputs: [] },
                ], venue)
                assert.strictEqual(decoder.model.rows.length, 1, 'an edit creates no row')
                assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
                assert.strictEqual(decoder.model.extendCalls.length, 1)
            }
        })

        it('skips a top-level create whose coins name another chain, on both sides', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runOne(create({ giveCoin: 'DOGE', getCoin: 'DOGE' }), venue)
                assert.deepStrictEqual(decoder.model.rows, [])
            }
        })
    })

    describe('a dispenser created inside a BATCH', function () {

        it('registers NOTHING below the gate (the live defect, preserved for replay)', async () => {
            const decoder = await runOne('BATCH|0|' + create({ oracle: ORACLE_A }), BELOW_GATE)
            assert.deepStrictEqual(decoder.model.rows, [],
                'pre-flag-day history must re-decode to the empty registry the fleet wrote')
            assert.strictEqual(decoder.model.insertCalls, 0)
        })

        it('registers above the gate, exactly as a top-level create does', async () => {
            const decoder = await runOne('BATCH|0|' + create({ oracle: ORACLE_A }), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [{
                txIndex: 1, address: SOURCE, expiration: EXP_LATE,
                oracleAddress: ORACLE_A, sourceAddress: null, expiredBlockIndex: null }])
        })

        it('registers when the DISPENSER is not the FIRST sub-command', async () => {
            // The prefix strip only touches element 0, so a create anywhere in the list counts.
            const decoder = await runOne(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER + ';' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [SOURCE])
        })

        it('registers nothing for a batch carrying no DISPENSER at all', async () => {
            const decoder = await runOne(
                'BATCH|0|SEND|0|BTC|TICK|1|' + SELLER + ';ORDER|0|BTC|TICK|1|TICK2|2|100', ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
            assert.strictEqual(decoder.model.insertCalls, 0)
        })

        it('registers nothing when the FORMAT prefix is not one the indexer strips', async () => {
            // 'BATCH||...' leaves element 0's action as BATCH, which actionLimits['BATCH']=0
            // whole-batch rejects, so no sub-command executes and registering one would open a
            // dispenser no node has.
            const decoder = await runOne('BATCH||' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
        })

        it('registers nothing for an unregistered BATCH FORMAT', async () => {
            const decoder = await runOne('BATCH|1|' + create({}), ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.rows, [])
        })
    })

    describe('several DISPENSER sub-commands in one BATCH', function () {

        it('registers every one of them on distinct operating addresses', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A }),
                create({ getAddress: DELEGATE_B }),
                create({}),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows),
                [DELEGATE_A, DELEGATE_B, SOURCE].sort())
            for (const row of decoder.model.rows)
                assert.strictEqual(row.txIndex, 1, 'all three share the transaction index')
        })

        it('gives each sub-command its OWN expiration, not the transaction one', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, expiration: EXP_EARLY }),
                create({ getAddress: DELEGATE_B, expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).expiration, EXP_EARLY)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).expiration, EXP_LATE)
        })

        it('gives each sub-command its OWN oracle address', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, oracle: ORACLE_A }),
                create({ getAddress: DELEGATE_B, oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).oracleAddress, ORACLE_A)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).oracleAddress, ORACLE_B)
        })

        it('defaults expiration PER SUB-COMMAND while a sibling keeps its explicit one', async () => {
            // The default is derived from the shared BLOCK TIME, exactly as the indexer's
            // util.getDefaultExpiration is for a batched sub-command, but the CHOICE to
            // default is per command.
            const decoder = await runOne('BATCH|0|' + [
                CREATE_NO_TAIL + '|' + DELEGATE_A,
                create({ getAddress: DELEGATE_B, expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(rowFor(decoder.model, DELEGATE_A).expiration,
                decoder.getDefaultExpiration(T0))
            assert.strictEqual(rowFor(decoder.model, DELEGATE_B).expiration, EXP_EARLY)
        })

        it('skips only the sub-command with an out-of-range EXPIRATION', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, expiration: '1700000000.5' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips only the sub-command with a compacted ^ GET_ADDRESS', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: '^4711' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips only the sub-command whose coins name another chain', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ getAddress: DELEGATE_A, giveCoin: 'DOGE', getCoin: 'DOGE' }),
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })

        it('skips a sub-command whose optional tail is too short to be a create', async () => {
            const decoder = await runOne('BATCH|0|' + [
                'DISPENSER|0|BTC|TICK|1',
                create({ getAddress: DELEGATE_B }),
            ].join(';'), ABOVE_GATE)
            assert.deepStrictEqual(addressesOf(decoder.model.rows), [DELEGATE_B])
        })
    })

    describe('two creates on the SAME operating address (the PRIMARY KEY collision)', function () {

        it('collapses to ONE row carrying the LATER expiration', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                create({ expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE,
                'keeping the EARLIER one closes the decoder while the indexer holds the ' +
                'second dispenser open, and payments to it stop being captured')
            assert.strictEqual(decoder.model.insertCalls, 1,
                'no colliding INSERT is even attempted')
        })

        it('takes the later expiration whichever ORDER the two arrive in', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_LATE }),
                create({ expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })

        it('collapses three same-address creates to one row', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                create({ expiration: EXP_EARLY + 1 }),
                create({ expiration: EXP_LATE }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
            assert.strictEqual(decoder.model.insertCalls, 1)
        })

        it('keeps the FIRST oracle named, the documented residual', async () => {
            // dispensers.oracle_address_id is one column, so only one of two Mode B
            // dispensers on one address can be recorded. A later v2 refill of the OTHER one
            // captures no oracle-fee output. Pinned so the residual cannot change silently:
            // closing it needs a per-sub-command discriminator in the dispensers PRIMARY KEY.
            const decoder = await runOne('BATCH|0|' + [
                create({ oracle: ORACLE_A }),
                create({ oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].oracleAddress, ORACLE_A)
        })

        it('takes the first NON-EMPTY oracle when the first create names none', async () => {
            const decoder = await runOne('BATCH|0|' + [
                create({}),
                create({ oracle: ORACLE_B }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].oracleAddress, ORACLE_B,
                'an oracle address recorded is an oracle-fee output capturable')
        })
    })

    describe('the money-bearing end: payments to a batch-created dispenser', function () {

        const paymentTx = { id: 'pay01', action: '', source: BUYER,
                            outputs: [{ destinationAddress: SOURCE, vout: 0, amount: 500000 },
                                      { destinationAddress: CHANGE, vout: 1, amount: 100000 }] }

        it('are captured as dispense outputs later in the SAME block, above the gate', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
                paymentTx,
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [SOURCE],
                'the payment to the batch-created dispenser is stored for the indexer')
        })

        it('are NOT captured below the gate (the defect: coin spent, nothing dispensed)', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
                paymentTx,
            ], BELOW_GATE)
            assert.deepStrictEqual(decoder.captured, [])
        })

        it('are captured in a LATER block too, from the persisted registry', async () => {
            const decoder = await runAll([
                { id: 'batch01', action: 'BATCH|0|' + create({}), source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            // Second block: the open set is re-read from the rows the batch wrote.
            const openSet = await decoder.model.getAllOpenDispenserAddresses()
            assert.ok(openSet.has(SOURCE),
                'the batch-created dispenser is in getAllOpenDispenserAddresses')
        })

        it('a top-level create captures the same way, on both sides of the gate', async () => {
            for (const venue of [ABOVE_GATE, BELOW_GATE]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({}), source: SOURCE, outputs: [] },
                    paymentTx,
                ], venue)
                assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [SOURCE])
            }
        })
    })

    describe('batched v2 refill / v1 cancel', function () {

        it('a batched v2 edit extends open dispensers (it did nothing before)', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(EXP_LATE),     source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.strictEqual(decoder.model.extendCalls.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })

        it('a batched v2 edit does NOTHING below the gate', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(EXP_LATE),     source: SOURCE, outputs: [] },
            ], BELOW_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls, [])
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_EARLY)
        })

        it('resolves against a dispenser created in the SAME batch', async () => {
            // Creates are inserted BEFORE the format-1/2 mirrors run, so an edit anywhere in
            // the batch reaches a create anywhere in it. The reverse order would let an edit
            // AFTER its create miss the row and close early - the money-bearing direction.
            const decoder = await runOne('BATCH|0|' + [
                create({ expiration: EXP_EARLY }),
                refill(EXP_LATE),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows.length, 1)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE,
                'the batched refill found the dispenser its own batch created')
        })

        it('reaches a create placed AFTER it in the same batch too (hold-open-longer)', async () => {
            const decoder = await runOne('BATCH|0|' + [
                refill(EXP_LATE),
                create({ expiration: EXP_EARLY }),
            ].join(';'), ABOVE_GATE)
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })

        it('runs one extend per v2 sub-command and none for other actions', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_EARLY }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + [refill(EXP_EARLY + 10), 'SEND|0|BTC|TICK|1|' + SELLER,
                                                        refill(EXP_LATE)].join(';'),
                  source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls.map(c => c.newExpiration),
                [EXP_EARLY + 10, EXP_LATE])
        })

        it('a batched format-1 cancel closes nothing, exactly as at top level', async () => {
            for (const command of [CANCEL, 'BATCH|0|' + CANCEL]) {
                const decoder = await runAll([
                    { id: 'create01', action: create({}), source: SOURCE, outputs: [] },
                    { id: 'cancel01', action: command,    source: SOURCE, outputs: [] },
                ], ABOVE_GATE)
                assert.strictEqual(decoder.model.rows.length, 1)
                assert.strictEqual(decoder.model.rows[0].expiredBlockIndex, null,
                    'the cancel mirror is retired: closing on a guessed target is the ' +
                    'money-bearing direction')
            }
        })

        it('captures the oracle fee of a create+refill batch from the CREATE payload', async () => {
            // Interaction with row 21's oracle-fee union, verified rather than assumed:
            // oracle resolution runs BEFORE registration in the transaction loop, so the v2
            // sub-command's DB lookup cannot see a row its own batch is about to write. It
            // does not need to - the v0 create sitting in the same command list resolves its
            // oracle by PARSING field [13], and the union covers the refill's output too.
            const decoder = await runAll([
                { id: 'batch01',
                  action: 'BATCH|0|' + [create({ oracle: ORACLE_A }), refill(EXP_LATE)].join(';'),
                  source: SOURCE,
                  outputs: [{ destinationAddress: ORACLE_A, vout: 0, amount: 1000 },
                             { destinationAddress: CHANGE,  vout: 1, amount: 100000 }] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.captured.map(o => o.destinationAddress), [ORACLE_A])
        })

        it('a batched v2 edit with a PAST expiration is skipped, as at top level', async () => {
            const decoder = await runAll([
                { id: 'create01', action: create({ expiration: EXP_LATE }), source: SOURCE, outputs: [] },
                { id: 'batch01',  action: 'BATCH|0|' + refill(T0 - 1),      source: SOURCE, outputs: [] },
            ], ABOVE_GATE)
            assert.deepStrictEqual(decoder.model.extendCalls, [])
            assert.strictEqual(decoder.model.rows[0].expiration, EXP_LATE)
        })
    })

    describe('registration rides the SAME flag-day as payment-output capture', function () {

        // ONE gate, not two. The registry IS the address set that decides which outputs are
        // captured as dispenses, so a decoder that registered batch dispensers at one instant
        // and captured batch payment outputs at another would be half-batch-aware for a
        // stretch of chain with nothing gained. This drives the REAL helper by arming mainnet
        // in place, and fails the moment someone gives registration its own constant.
        const ARMED = 1789430400
        const BATCHED = 'BATCH|0|COINPAY|0|101;' + create({})
        const OUTPUTS = [{ destinationAddress: SELLER, vout: 0, amount: 100000000 }]

        async function probe(blockTime) {
            const model = new DispenserModel()
            const decoder = buildDecoder(
                [{ id: 'tx01', action: BATCHED, source: SOURCE, outputs: OUTPUTS }],
                model, { network: 'bitcoin-mainnet', blockTime, feeDestination: null })
            await decoder.start()
            return { registered: model.rows.length, captured: decoder.captured.length }
        }

        it('both are off one second below the instant and on AT it', async () => {
            const saved = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet
            BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = ARMED
            try {
                assert.deepStrictEqual(await probe(ARMED - 1), { registered: 0, captured: 0 })
                assert.deepStrictEqual(await probe(ARMED),     { registered: 1, captured: 1 })
            } finally {
                BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = saved
            }
            assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, null,
                'the map must be back to DISARMED after the probe')
            assert.deepStrictEqual(await probe(ARMED), { registered: 0, captured: 0 })
        })
    })
})

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
