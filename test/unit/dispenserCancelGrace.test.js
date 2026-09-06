'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Dispenser CANCELLATION GRACE: payment capture must outlast the indexer's fill window.
//
// The two services disagree about when a CANCELLED dispenser stops taking money, and the
// disagreement runs in the money-bearing direction. The indexer excludes `cancelling` rows
// from its expiration pass, keeps matching `status IN ('open','cancelling')`, and closes only
// at cancel time + DISPENSER_CLOSE_DELAY (3600s). The decoder mirrors no cancel at all, so it
// soft-expires the row at its raw expiration and drops the address from the block loop's
// capture set. Cancel a funded dispenser shortly before its expiration and the indexer keeps
// settling fills while the decoder captures nothing, so the buyer's native coin reaches the
// seller with no DISPENSE record and no inventory release.
//
// The invariant this suite drives, over a sweep of block times rather than one lucky point:
//   for every block in which the INDEXER would still settle a fill,
//   the DECODER's capture set contains the dispenser's address.
//
// SENSITIVITY: the sweep and the single-block case FAIL against a decoder whose capture set
// is `expired_block_index IS NULL` alone, which is the behavior below the flag-day and the
// behavior this suite exists to change. Below-the-gate assertions pin that older behavior in
// place, so the green side is a gate flip and not a rewritten expectation.

const assert = require('assert')
const sinon  = require('sinon')

const XChainDecoder = require('../../src/XChainDecoder')
const Database      = require('../../src/db.js')
const { DISPENSER_CANCEL_GRACE_SECONDS,
        cancelGraceFloor } = require('../../src/dispenserCancelGrace')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)
// The reorg check compares a block's prevHash, byte-reversed to display order, against the
// stored hash of the block below it.
const PREV_HASH = Buffer.from(PREV_WIRE).reverse().toString('hex')

const ADDR       = 'bcrt1qgracedispenser'
const EXPIRATION = 1700000000                     // the dispenser's own expiry instant
const CANCEL_AT  = EXPIRATION - 600               // cancelled 10 minutes before it
// The indexer's cancel close-delay, named here to express "a block the indexer would still
// settle a fill in". The decoder carries its own copy as DISPENSER_CANCEL_GRACE_SECONDS, and
// dispenserCancelGraceActivation.test.js pins the two together against the indexer's config.
const INDEXER_CLOSE_DELAY = 3600

// The indexer's rule for a CANCELLED dispenser: expiration does not close it (getExpiredItems
// skips `cancelling` rows), findMatchingDispensers still matches it, and DISPENSER_CLOSE fires
// at cancel time + close delay.
function indexerStillSettlesFill(blockTime){
    return blockTime < CANCEL_AT + INDEXER_CLOSE_DELAY
}

// A faithful in-memory model of the decoder `dispensers` table, mirroring the db.js SQL for
// the two methods this fix touches. Every capture load is recorded with the floor it was
// given, so a test can assert on the exact set the block loop received.
class DispenserModel {
    constructor(){
        this.rows = []
        this.captureLoads = []
    }
    async insertDispenser(){ return true }
    async extendOpenDispenserExpirationBySource(){ return true }
    async getOpenDispenserOracleAddressBySource(){ return null }
    async getOpenDispenserOracleAddressesBySource(){ return [] }
    async purgeExpiredDispensers(){ return true }
    // Mirrors deleteOpenDispensers: stamp open rows whose expiration < minExpiration.
    async deleteOpenDispensers(blockIndex, minExpiration){
        for (const r of this.rows)
            if (r.expiredBlockIndex === null && r.expiration < Number(minExpiration))
                r.expiredBlockIndex = blockIndex
        return true
    }
    // Mirrors getAllOpenDispenserAddresses:
    //   WHERE expired_block_index IS NULL                       (no floor)
    //   WHERE expired_block_index IS NULL OR expiration >= ?    (floor bound)
    async getAllOpenDispenserAddresses(graceFloor){
        // Same strict number test as db.js: `Number(null)` is 0, which would silently arm a
        // 1970 floor below the gate.
        const floor = graceFloor
        const graceActive = (typeof floor === 'number') && Number.isFinite(floor)
        const set = new Set(this.rows
            .filter(r => r.expiredBlockIndex === null || (graceActive && r.expiration >= floor))
            .map(r => r.address))
        this.captureLoads.push({ floor: graceActive ? floor : null, set })
        return set
    }
}

function fakeTx(id){
    return { getId: () => id, outs: [] }
}

// An inert parseTransaction result: this suite exercises the block loop's CAPTURE-SET
// plumbing, not the decode path.
function inertParseResult(){
    return {
        data: Buffer.alloc(0), source: null, destination: null, amount: 0,
        dispenseOutputs: [], paymentOutputs: [], compiledDataLength: 0, rawData: null,
    }
}

// Drive the real block loop over two blocks on `consensusNetwork`:
//   block 0 at `expireAt` - the decoder's own soft-expire stamps the dispenser here;
//   block 1 at `payAt`    - the payment block whose capture set the test asserts on.
// Nothing is pre-stamped by hand: the stamp under test is written by the production
// deleteOpenDispensers call site.
function runTwoBlocks(consensusNetwork, expireAt, payAt, model){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    // The gate reads consensusNetwork, so set it directly rather than routing a mainnet name
    // through the chain-identity machinery this suite does not exercise.
    decoder.consensusNetwork = consensusNetwork
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const timesByHeight = { 0: expireAt, 1: payAt }
    const setsSeenByParse = []
    decoder.parseTransaction = async (tx, openDispenserAddresses) => {
        setsSeenByParse.push(openDispenserAddresses)
        return inertParseResult()
    }

    decoder.connector = {
        getBlockchainInfo: async () => ({ verificationprogress: 1, blocks: 1 }),
        getBlockHash:      async (height) => 'height:' + height,
        getBlock:          async (hash) => hash,
    }

    let commits = 0
    decoder.db = {
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables:   async () => true,
        runMigrations:  async () => ({ applied: [], pending: [] }),
        getLastBlockIndex: async () => -1,
        getLastTxIndex:    async () => 0,
        // Block 1 runs the reorg check against block 0's stored hash. Both blocks carry the
        // same PREV_WIRE, so answering with that value keeps the chain contiguous and the loop
        // out of its reorg branch, which this suite does not exercise.
        getBlockByIndex:   async () => ({ block_hash: PREV_HASH }),
        beginTransaction:  async () => {},
        endTransaction:    async () => {},
        commitTransaction: async () => { if (++commits >= 2) decoder.stopFlag = true; return true },
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
        getAllOpenDispenserAddresses:          (f) => model.getAllOpenDispenserAddresses(f),
        getOpenDispenserOracleAddressBySource:   (s) => model.getOpenDispenserOracleAddressBySource(s),
        getOpenDispenserOracleAddressesBySource: (s) => model.getOpenDispenserOracleAddressesBySource(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: (hex) => ({
            prevHash: Buffer.from(PREV_WIRE),
            timestamp: timesByHeight[Number(String(hex).split(':')[1])],
            transactions: [fakeTx('tx-at-' + String(hex))],
        })
    }

    return decoder.start().then(() => ({ setsSeenByParse }))
}

// One funded dispenser, cancelled shortly before its expiration, as the decoder holds it:
// the decoder mirrors no cancel, so the row carries only its own expiration.
function fundedCancelledDispenser(){
    const model = new DispenserModel()
    model.rows.push({ address: ADDR, expiration: EXPIRATION, expiredBlockIndex: null })
    return model
}

describe('dispenser cancellation grace: decoder capture outlasts the indexer fill window', function () {
    this.timeout(0)

    it('captures a payment made after expiry while the indexer still settles fills', async () => {
        // The finding's named failure mode, driven end to end. The dispenser is cancelled at
        // EXPIRATION - 600, so the indexer keeps settling until EXPIRATION + 3000. A payment
        // 30 minutes past the expiration lands squarely inside that window.
        const payAt = EXPIRATION + 1800
        assert.ok(indexerStillSettlesFill(payAt),
            'the probe block must be one the indexer would still settle a fill in')

        const model = fundedCancelledDispenser()
        const { setsSeenByParse } = await runTwoBlocks('regtest', EXPIRATION + 1, payAt, model)

        // The production soft-expire really did stamp the row on the earlier block, so the
        // grace clause is what carries it, not an unexpired row.
        assert.strictEqual(model.rows[0].expiredBlockIndex, 0,
            'block 0 must have soft-expired the dispenser, or this test proves nothing')

        assert.strictEqual(model.captureLoads.length, 2)
        const payLoad = model.captureLoads[1]
        assert.strictEqual(payLoad.floor, payAt - DISPENSER_CANCEL_GRACE_SECONDS,
            'the block loop must pass the grace floor derived from this block header time')
        assert.ok(payLoad.set.has(ADDR),
            'a payment inside the indexer fill window must still be captured by the decoder')

        // The set the loop handed parseTransaction is the same object, so capture really runs
        // against the widened set rather than a copy made for the assertion.
        assert.strictEqual(setsSeenByParse[1], payLoad.set)
    })

    it('keeps the unwidened capture set below the flag-day (the other side of the gate)', async () => {
        // Same blocks, same model, DISARMED network. This is the behavior the fleet runs today
        // and the behavior a from-genesis re-decode of pre-flag-day history must reproduce.
        const payAt = EXPIRATION + 1800
        const model = fundedCancelledDispenser()
        await runTwoBlocks('mainnet', EXPIRATION + 1, payAt, model)

        assert.strictEqual(model.rows[0].expiredBlockIndex, 0)
        const payLoad = model.captureLoads[1]
        assert.strictEqual(payLoad.floor, null,
            'below the gate the block loop must pass no floor at all')
        assert.ok(!payLoad.set.has(ADDR),
            'below the gate the expired dispenser stays out of the capture set')
    })

    it('closes capture once the indexer can no longer settle a fill', async () => {
        // The grace is a window, not an amnesty: past expiration + grace the address leaves the
        // capture set, and by then the indexer stopped matching the dispenser long ago.
        const payAt = EXPIRATION + DISPENSER_CANCEL_GRACE_SECONDS + 1
        assert.ok(!indexerStillSettlesFill(payAt),
            'the probe block must be one the indexer has already closed')

        const model = fundedCancelledDispenser()
        await runTwoBlocks('regtest', EXPIRATION + 1, payAt, model)

        assert.ok(!model.captureLoads[1].set.has(ADDR),
            'past the grace window the dispenser leaves the capture set')
    })

    it('covers every block of the indexer fill window, swept at five-minute steps', async () => {
        // The invariant, not a lucky point. Walk the payment block from the expiration out past
        // the grace and assert the implication in both directions at each step.
        let insideWindowBlocks = 0
        for (let payAt = EXPIRATION + 1; payAt <= EXPIRATION + 4500; payAt += 300){
            const model = fundedCancelledDispenser()
            await runTwoBlocks('regtest', EXPIRATION + 1, payAt, model)
            const captured = model.captureLoads[model.captureLoads.length - 1].set.has(ADDR)

            if (indexerStillSettlesFill(payAt)){
                insideWindowBlocks++
                assert.ok(captured,
                    `block time ${payAt}: the indexer still settles fills here, so the decoder ` +
                    'must still capture payments to the dispenser')
            }
            // Outside the indexer's window capture is merely allowed to continue to the end of
            // the grace: over-capture is the direction the advisory contract calls safe, and
            // the indexer drops the surplus.
            if (payAt > EXPIRATION + DISPENSER_CANCEL_GRACE_SECONDS)
                assert.ok(!captured, `block time ${payAt}: capture must end with the grace window`)
        }
        // Guard against a vacuous sweep: an arithmetic slip that made the window empty would
        // otherwise pass every assertion above.
        assert.ok(insideWindowBlocks >= 8,
            `the sweep must cross at least 8 blocks inside the indexer fill window, saw ${insideWindowBlocks}`)
    })
})

describe('Database#getAllOpenDispenserAddresses() grace floor', function () {
    afterEach(() => sinon.restore())

    function makeDb(){ return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p') }
    function withConn(queryStub){
        const conn = {
            query: queryStub, release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(), commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
        }
        return { pool: { getConnection: sinon.stub().resolves(conn) } }
    }

    it('runs the unwidened predicate and binds nothing when no floor is given', async () => {
        const db = makeDb()
        const q  = sinon.stub().resolves([{ address: ADDR }])
        db.pool = withConn(q).pool
        await db.getAllOpenDispenserAddresses()
        const [sql, params] = q.firstCall.args
        assert.ok(/expired_block_index IS NULL/.test(sql))
        assert.ok(!/expiration >= \?/.test(sql),
            'the below-gate query must not carry the grace clause')
        assert.strictEqual(params, undefined, 'the below-gate query must bind no parameter')
    })

    it('adds the grace clause and binds the floor when one is given', async () => {
        const db = makeDb()
        const q  = sinon.stub().resolves([{ address: ADDR }])
        db.pool = withConn(q).pool
        const floor = cancelGraceFloor('regtest', EXPIRATION + 1800)
        await db.getAllOpenDispenserAddresses(floor)
        const [sql, params] = q.firstCall.args
        assert.ok(/expired_block_index IS NULL\s*\n\s*OR op\.expiration >= \?/.test(sql),
            'the above-gate query must admit rows whose expiration is no older than the floor')
        assert.deepStrictEqual(params, [EXPIRATION + 1800 - DISPENSER_CANCEL_GRACE_SECONDS])
    })

    it('treats a null or non-finite floor as no grace at all', async () => {
        // cancelGraceFloor returns null below the gate, so this is the fail-closed path that
        // keeps an unarmed network on the legacy capture set.
        for (const floor of [null, undefined, NaN, 'soon']){
            const db = makeDb()
            const q  = sinon.stub().resolves([])
            db.pool = withConn(q).pool
            await db.getAllOpenDispenserAddresses(floor)
            const [sql, params] = q.firstCall.args
            assert.ok(!/expiration >= \?/.test(sql), `floor ${String(floor)} must not widen the query`)
            assert.strictEqual(params, undefined)
        }
    })

    it('still returns null on a query fault, with or without a floor', async () => {
        // A failed read and an empty set must stay distinguishable; the grace path must not
        // quietly become an empty-set success.
        for (const floor of [null, EXPIRATION]){
            const db = makeDb()
            db.pool = withConn(sinon.stub().rejects(new Error('fail'))).pool
            assert.strictEqual(await db.getAllOpenDispenserAddresses(floor), null)
        }
    })
})
