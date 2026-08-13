// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DISPENSER soft-expire measurement point: the cross-service realignment.
//
// The decoder soft-expires open dispensers with db.deleteOpenDispensers and then loads the
// open-dispenser address set every output in the block is tested against. The INDEXER expires
// at block END (xchain-indexer/src/utility.js processExpirations, called from
// XChainIndexer.js AFTER the `for(const tx of blockTransactions)` loop). While the decoder
// expired at block START the two disagreed for the whole of one block: on the block whose
// header time first passes an expiration the decoder had already dropped the dispenser from
// its capture set while the indexer still treated it as open for every transaction in that
// block. Because the indexer only ever sees outputs the decoder persisted, a native payment
// to that dispenser on the boundary block reached NOBODY: the payer's coin is spent and no
// DISPENSE is ever produced for it.
//
// DISPENSER_EXPIRY_REALIGN_ACTIVATION moves the decoder's soft-expire to the end of its block
// loop so both measurement points coincide. It is consensus-affecting (it changes the
// persisted output set on boundary blocks), so the LEGACY block-start behavior must survive
// verbatim below the gate or a from-genesis re-decode stops matching what the fleet wrote.
//
// This suite drives the REAL block loop (decoder.start) against the in-memory dispensers model
// and asserts BOTH eras, by arming and disarming the regtest entry of the map in place. The
// era assertions are each other's teeth: the legacy cases fail if the move is not gated, and
// the realigned cases fail if the move never happens.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')
const { DISPENSER_EXPIRY_REALIGN_ACTIVATION } = require('../../src/dispenserExpiryRealign')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0   = 1700000000          // this block's header time
const ADDR = 'bcrt1qdispenser'   // the dispenser's operating address

// The decoder `dispensers` table, plus an ordered event log. The log is what lets us assert
// WHERE in the block the soft-expire ran, which is the whole subject of the gate.
class DispenserModel {
    constructor() {
        this.rows   = []
        this.events = []
        this.expireCalls = []
        // Sets handed to parseTransaction, one per transaction, snapshotted at call time.
        this.seenOpenSets = []
    }
    async insertDispenser({ txIndex, address, sourceAddress, expiration }) {
        this.events.push('insert')
        this.rows.push({ txIndex, address, expiration: Number(expiration), expiredBlockIndex: null,
                         oracleAddress: null,
                         sourceAddress: (sourceAddress && sourceAddress !== address) ? sourceAddress : null })
        return true
    }
    async getOpenDispenserOracleAddressBySource() { return null }
    async getOpenDispenserOracleAddressesBySource() { return new Set() }
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        this.events.push('extend')
        for (const r of this.rows) {
            const reachable = (r.expiredBlockIndex === null || r.expiredBlockIndex === blockIndex)
            if (!reachable) continue
            if (r.address !== sourceAddress && r.sourceAddress !== sourceAddress) continue
            r.expiration = Math.max(Number(r.expiration), Number(newExpiration))
            if (r.expiredBlockIndex === blockIndex) r.expiredBlockIndex = null
        }
        return true
    }
    // Mirrors deleteOpenDispensers: soft-expire open rows whose expiration < minExpiration.
    async deleteOpenDispensers(blockIndex, minExpiration) {
        this.events.push('expire')
        this.expireCalls.push({ blockIndex, minExpiration })
        if (this.failExpireTimes > 0) { this.failExpireTimes--; return false }
        for (const r of this.rows)
            if (r.expiredBlockIndex === null && r.expiration < Number(minExpiration))
                r.expiredBlockIndex = blockIndex
        return true
    }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        this.events.push('loadOpenSet')
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
}

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

function parseResultFor(dataStr, source) {
    const buf = Buffer.from(dataStr)
    return {
        data:               buf,
        source,
        destination:        null,
        amount:             0,
        dispenseOutputs:    [],
        paymentOutputs:     [],
        compiledDataLength: buf.length,
        rawData:            null,
    }
}

// One block (height 0) at time T0 carrying `txSpecs`. parseTransaction is stubbed, but it
// snapshots the open-dispenser set it was handed: that set IS the capture surface the gate
// exists to fix, so the assertions read it rather than a downstream effect.
function buildDecoder(txSpecs, model) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = parseResultFor(s.action, s.source)
    decoder.parseTransaction = async (tx, openDispenserAddresses) => {
        model.events.push('parse')
        model.seenOpenSets.push(new Set(openDispenserAddresses || []))
        return byId[tx.getId()]
    }

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 0 }),
        getBlockHash:      async () => 'aabbccdd',
        getBlock:          async () => '',
    }

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
        insertTransactionOutput: async () => true,
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        insertDispenser:                       (d) => model.insertDispenser(d),
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
        deleteOpenDispensers:                  (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:                (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:          () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource:   (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE), timestamp: T0, transactions })
    }

    return decoder
}

// Run `fn` with the regtest entry of the gate map set to `value`, then restore it. The map is
// read per call by isDispenserExpiryRealignActive, so this switches the era the loop runs in.
async function withRegtestGate(value, fn) {
    const saved = DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest
    DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest = value
    try { return await fn() }
    finally { DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest = saved }
}

const GATE_ON  = 0      // genesis-on, the shipped regtest value
const GATE_OFF = null   // DISARMED, the shipped mainnet/testnet value

// A dispenser row that this block's header time has just passed: expiration < T0.
function expiringRow() {
    return { txIndex: 1, address: ADDR, expiration: T0 - 10,
             expiredBlockIndex: null, oracleAddress: null, sourceAddress: null }
}

// A plain payment transaction: no XChain data, so the loop only tests its outputs against
// the open-dispenser set.
const PAYMENT = { id: 'pay01', action: '', source: 'bcrt1qpayer' }

describe('DISPENSER expiry realignment (DISPENSER_EXPIRY_REALIGN_ACTIVATION)', function () {
    this.timeout(0)

    it('REALIGNED: a dispenser expiring on this block is still captured for every tx in it', async () => {
        const model = new DispenserModel()
        model.rows.push(expiringRow())
        const decoder = buildDecoder([PAYMENT], model)

        await withRegtestGate(GATE_ON, () => decoder.start())

        // The capture surface: the payment tx was handed a set that still holds the dispenser,
        // exactly as the indexer still holds it open for that transaction.
        assert.strictEqual(model.seenOpenSets.length, 1, 'the payment tx must have been parsed')
        assert.ok(model.seenOpenSets[0].has(ADDR),
            'the boundary block must still capture payments to the expiring dispenser; ' +
            'dropping them spends the payer coin with no DISPENSE reaching the indexer')

        // And the expiry still happened, just at the other end of the block.
        assert.strictEqual(model.rows[0].expiredBlockIndex, 0, 'the row is soft-expired by this block')
    })

    it('REALIGNED: the soft-expire runs AFTER the transaction loop, where the indexer runs it', async () => {
        const model = new DispenserModel()
        model.rows.push(expiringRow())
        const decoder = buildDecoder([
            { id: 'pay01', action: '', source: 'bcrt1qpayerA' },
            { id: 'pay02', action: '', source: 'bcrt1qpayerB' },
        ], model)

        await withRegtestGate(GATE_ON, () => decoder.start())

        // Ordering is the substance of the change, so assert the sequence itself.
        assert.deepStrictEqual(model.events, ['loadOpenSet', 'parse', 'parse', 'expire'],
            'the open set must be loaded first, every tx parsed against it, and the expiry run last')
        assert.strictEqual(model.expireCalls.length, 1, 'exactly one soft-expire per block')
        assert.deepStrictEqual(model.expireCalls[0], { blockIndex: 0, minExpiration: T0 },
            'the end-of-block expiry keys on the same height and header time as the legacy call')
        // Every transaction in the block saw the same open set: no mid-block change.
        assert.ok(model.seenOpenSets.every(s => s.has(ADDR)),
            'the dispenser is open for the WHOLE block, matching the indexer')
    })

    it('LEGACY: the block-start expiry survives verbatim below the gate', async () => {
        const model = new DispenserModel()
        model.rows.push(expiringRow())
        const decoder = buildDecoder([PAYMENT], model)

        await withRegtestGate(GATE_OFF, () => decoder.start())

        // The known defect, preserved on purpose: a from-genesis re-decode of pre-flag-day
        // history has to reproduce the output set the fleet actually wrote, defect included.
        assert.deepStrictEqual(model.events, ['expire', 'loadOpenSet', 'parse'],
            'below the gate the expiry must still run before the open set is loaded')
        assert.strictEqual(model.seenOpenSets.length, 1)
        assert.ok(!model.seenOpenSets[0].has(ADDR),
            'below the gate the boundary block still drops the payment (the legacy divergence)')
        assert.strictEqual(model.rows[0].expiredBlockIndex, 0)
    })

    it('the two eras differ ONLY on the boundary block: an unexpired dispenser is identical in both', async () => {
        // Scope check. If the gate changed anything for a dispenser whose expiration this block
        // does not pass, it would be re-writing ordinary history rather than one boundary.
        const runEra = async (gate) => {
            const model = new DispenserModel()
            model.rows.push({ txIndex: 1, address: ADDR, expiration: T0 + 1000000,
                              expiredBlockIndex: null, oracleAddress: null, sourceAddress: null })
            const decoder = buildDecoder([PAYMENT], model)
            await withRegtestGate(gate, () => decoder.start())
            return model
        }
        const realigned = await runEra(GATE_ON)
        const legacy    = await runEra(GATE_OFF)

        for (const [name, m] of [['realigned', realigned], ['legacy', legacy]]) {
            assert.ok(m.seenOpenSets[0].has(ADDR), name + ': a live dispenser is captured')
            assert.strictEqual(m.rows[0].expiredBlockIndex, null, name + ': and is not expired')
            assert.strictEqual(m.rows[0].expiration, T0 + 1000000, name + ': with its expiry untouched')
        }
    })

    it('the two eras agree on a dispenser an EARLIER block already expired', async () => {
        // The realignment must not resurrect anything. A row closed by a previous block stays
        // out of the capture set in both eras (the harness parses height 0, so -1 is "earlier").
        const runEra = async (gate) => {
            const model = new DispenserModel()
            model.rows.push({ txIndex: 1, address: ADDR, expiration: T0 - 10,
                              expiredBlockIndex: -1, oracleAddress: null, sourceAddress: null })
            const decoder = buildDecoder([PAYMENT], model)
            await withRegtestGate(gate, () => decoder.start())
            return model
        }
        for (const [name, m] of [['realigned', await runEra(GATE_ON)], ['legacy', await runEra(GATE_OFF)]]) {
            assert.ok(!m.seenOpenSets[0].has(ADDR), name + ': an earlier-block closure stays closed')
            assert.strictEqual(m.rows[0].expiredBlockIndex, -1, name + ': and keeps its original stamp')
        }
    })

    it('REALIGNED: a same-block edge extension keeps the dispenser open past the end-of-block expiry', async () => {
        // The money-bearing case end to end. A dispenser expiring at this block's time is
        // extended by a format-2 edit in the same block. Under the realignment it was never
        // stamped, so it is captured for the whole block AND survives the end-of-block pass,
        // which is precisely what the indexer does with the same two events.
        const model = new DispenserModel()
        model.rows.push(expiringRow())
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'pay01',  action: '',                                 source: 'bcrt1qpayer' },
            { id: 'edit01', action: `DISPENSER|2|7||${extended}||`,      source: ADDR },
        ], model)

        await withRegtestGate(GATE_ON, () => decoder.start())

        assert.ok(model.seenOpenSets[0].has(ADDR),
            'the payment preceding the edit is captured; no in-memory re-seed could reach it')
        assert.strictEqual(model.rows[0].expiration, extended, 'the edit moved the expiry out')
        assert.strictEqual(model.rows[0].expiredBlockIndex, null,
            'and the end-of-block expiry leaves the now-unexpired row open, as the indexer does')
        assert.deepStrictEqual(model.events,
            ['loadOpenSet', 'parse', 'parse', 'extend', 'expire'],
            'the extend lands inside the loop and the expiry still runs last')
    })

    it('LEGACY: the same edge is the divergence the gate exists to close', async () => {
        // Teeth for the case above. Below the gate the payment preceding the edit is lost, and
        // only the same-block stamp clear in extendOpenDispenserExpirationBySource keeps the row
        // from staying closed forever. Both halves are asserted so a regression in either era is
        // visible.
        const model = new DispenserModel()
        model.rows.push(expiringRow())
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'pay01',  action: '',                             source: 'bcrt1qpayer' },
            { id: 'edit01', action: `DISPENSER|2|7||${extended}||`,  source: ADDR },
        ], model)

        await withRegtestGate(GATE_OFF, () => decoder.start())

        assert.ok(!model.seenOpenSets[0].has(ADDR),
            'below the gate the payment before the edit is dropped: the residual this gate closes')
        assert.strictEqual(model.rows[0].expiredBlockIndex, null,
            'the persistent leg stays fixed: the same-block stamp is cleared by the extend')
        assert.strictEqual(model.rows[0].expiration, extended)
    })

    // Unit cover for the e2e case (test/e2e/dispenserLifecycle.e2e.js B2.1), which runs on
    // regtest and therefore on the realigned side of the gate. A create whose EXPIRATION is
    // already past is stamped by the block that CARRIES it once the sweep runs last; below
    // the gate the sweep had already run, so only a LATER block could stamp it. This is the
    // assertion the e2e makes, pinned here so it does not need a live venue to regress.
    it('a create with an already-past EXPIRATION is expired by its own block only when REALIGNED', async () => {
        const pastExpiry = T0 - 10
        const CREATE_PAST = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${pastExpiry}`

        const runEra = async (gate) => {
            const model = new DispenserModel()
            const decoder = buildDecoder([{ id: 'create01', action: CREATE_PAST, source: ADDR }], model)
            await withRegtestGate(gate, () => decoder.start())
            return model
        }

        const realigned = await runEra(GATE_ON)
        assert.strictEqual(realigned.rows.length, 1, 'the create still registers a row')
        assert.strictEqual(realigned.rows[0].expiredBlockIndex, 0,
            'realigned: the end-of-block sweep expires the create in its own block')

        const legacy = await runEra(GATE_OFF)
        assert.strictEqual(legacy.rows.length, 1, 'the create still registers a row')
        assert.strictEqual(legacy.rows[0].expiredBlockIndex, null,
            'legacy: the block-start sweep already ran, so only a LATER block can expire it')
    })

    it('REALIGNED: a failed end-of-block expiry rolls the block back and retries it', async () => {
        // The new call site carries the same rollback contract as the legacy one: false means
        // the UPDATE failed and the block transaction is already rolled back, so the loop must
        // retry the block rather than commit past it and leave the expiry undone.
        const model = new DispenserModel()
        model.failExpireTimes = 1
        model.rows.push(expiringRow())
        const decoder = buildDecoder([PAYMENT], model)

        await withRegtestGate(GATE_ON, () => decoder.start())

        assert.strictEqual(model.expireCalls.length, 2,
            'the end-of-block soft-expire must be retried with the block')
        assert.strictEqual(model.rows[0].expiredBlockIndex, 0,
            'and the retry applies it, so no block commits with the expiry skipped')
    })
})
