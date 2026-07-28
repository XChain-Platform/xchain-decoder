// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DISPENSER lifecycle mirror : the decoder must track DISPENSER format 1
// (cancel) and format 2 (edit) so its open-dispenser view matches the indexer's.
// Before this fix the decoder only tracked format 0 (create), so its open-dispenser
// view outlived the indexer's once a dispenser was cancelled or re-dated
// (xchain-indexer/src/dispenserDivergenceMetrics.js enumerates exactly this gap:
// cancels applied, EXPIRATION edits, and DISPENSE triggers dropped against an
// already-closed dispenser).
//
// These tests drive the REAL block-processing loop (decoder.start) with a faithful
// in-memory dispensers model whose methods mirror the db.js SQL semantics
// (deleteOpenDispensers: expiration < block_time AND open -> soft-expire;
// getAllOpenDispenserAddresses: addresses of open rows; cancel/edit: most-recent
// open row at the address). The loop's own decision code decides whether/how to
// cancel or edit; the model reflects it; we then assert the resulting open-view.
//
// SENSITIVITY: the cancel-closure and edit-closure assertions FAIL against pre-fix
// code, because a format 1/2 tx is a no-op there (only format 0 was handled), so the
// row keeps its original far-future expiration and the address never leaves the open
// set at the indexer's close/expire height.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0 = 1700000000            // block timestamp used for the single processed block
const DISPENSER_CLOSE_DELAY = 3600 // must equal the decoder/indexer constant

// A faithful in-memory model of the decoder `dispensers` table. Each method mirrors
// the corresponding db.js query so the open-view we assert on is the same one the
// real SQL would produce.
class DispenserModel {
    constructor() {
        this.rows  = []
        this.calls = { insert: [], cancel: [], edit: [] }
    }
    async insertDispenser({ txIndex, address, sourceAddress, expiration, oracleAddress }) {
        this.calls.insert.push({ txIndex, address, sourceAddress, expiration: Number(expiration) })
        this.rows.push({ txIndex, address, expiration: Number(expiration), expiredBlockIndex: null,
                         oracleAddress: oracleAddress || null,
                         // Mirrors db.js: the create SOURCE is stored only when it differs
                         // from the operating address (NULL means "same as address").
                         sourceAddress: (sourceAddress && sourceAddress !== address) ? sourceAddress : null })
        return true
    }
    // Mirrors the shared target resolution of cancelOpenDispenserBySource /
    // editOpenDispenserExpirationBySource / getOpenDispenserOracleAddressBySource: open
    // rows this address may act on (operating address OR stored create SOURCE, ),
    // operating-address matches ranked first, then most recent.
    _openFor(actingAddress) {
        return this.rows
            .filter(r => r.expiredBlockIndex === null &&
                         (r.address === actingAddress || r.sourceAddress === actingAddress))
            .sort((a, b) => {
                const aKeyed = (a.address === actingAddress) ? 1 : 0
                const bKeyed = (b.address === actingAddress) ? 1 : 0
                if (aKeyed !== bKeyed) return bKeyed - aKeyed
                return b.txIndex - a.txIndex
            })
    }
    // Mirrors getOpenDispenserOracleAddressBySource : same target resolution as
    // cancel/edit.
    async getOpenDispenserOracleAddressBySource(sourceAddress) {
        const open = this._openFor(sourceAddress)
        return (open.length && open[0].oracleAddress) ? open[0].oracleAddress : null
    }
    // Mirrors cancelOpenDispenserBySource: UPDATE ... SET expiration=? on the single
    // resolved open row.
    async cancelOpenDispenserBySource(sourceAddress, closeExpiration) {
        this.calls.cancel.push({ sourceAddress, closeExpiration: Number(closeExpiration) })
        const open = this._openFor(sourceAddress)
        if (open.length) open[0].expiration = Number(closeExpiration)
        return true
    }
    async editOpenDispenserExpirationBySource(sourceAddress, newExpiration) {
        this.calls.edit.push({ sourceAddress, newExpiration: Number(newExpiration) })
        const open = this._openFor(sourceAddress)
        if (open.length) open[0].expiration = Number(newExpiration)
        return true
    }
    // Mirrors deleteOpenDispensers: soft-expire open rows whose expiration < minExpiration.
    async deleteOpenDispensers(blockIndex, minExpiration) {
        for (const r of this.rows)
            if (r.expiredBlockIndex === null && r.expiration < Number(minExpiration))
                r.expiredBlockIndex = blockIndex
        return true
    }
    async purgeExpiredDispensers() { return true }
    async getAllOpenDispenserAddresses() {
        return new Set(this.rows.filter(r => r.expiredBlockIndex === null).map(r => r.address))
    }
}

function fakeTx(id) {
    return { getId: () => id, outs: [] }
}

// A synthetic parseTransaction result carrying a decoded ACTION string + source.
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

// Build a decoder wired to process exactly one block (height 0) whose transactions are
// `txSpecs` (each { id, action, source }). parseTransaction is stubbed to return the
// crafted parseResult per txid, so the test exercises the block loop's DISPENSER
// lifecycle decisions rather than the (separately tested) decode path.
function buildDecoder(txSpecs, model) {
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}

    const transactions = txSpecs.map(s => fakeTx(s.id))
    const byId = {}
    for (const s of txSpecs) byId[s.id] = parseResultFor(s.action, s.source)
    decoder.parseTransaction = async (tx) => byId[tx.getId()]

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
        insertTransaction: async () => true,      // truthy, non-POISON, non-false -> success branch
        insertTransactionOutput: async () => true,
        POISON_ROW: 2,
        DUPLICATED_TRANSACTION: 1,
        // Dispenser lifecycle surface -> the in-memory model.
        insertDispenser:                     (d) => model.insertDispenser(d),
        cancelOpenDispenserBySource:         (s, e) => model.cancelOpenDispenserBySource(s, e),
        editOpenDispenserExpirationBySource: (s, e) => model.editOpenDispenserExpirationBySource(s, e),
        deleteOpenDispensers:                (b, m) => model.deleteOpenDispensers(b, m),
        purgeExpiredDispensers:              (h) => model.purgeExpiredDispensers(h),
        getAllOpenDispenserAddresses:        () => model.getAllOpenDispenserAddresses(),
        getOpenDispenserOracleAddressBySource: (s) => model.getOpenDispenserOracleAddressBySource(s),
    }

    decoder.xchainBlockDecoder = {
        blockFromHex: () => ({ prevHash: Buffer.from(PREV_WIRE), timestamp: T0, transactions })
    }

    return decoder
}

const ADDR = 'bcrt1qtestsource'
// A v0 create at ADDR (GET_ADDRESS empty -> operates on SOURCE) with a far-future expiry.
// Fields: DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|
//         GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION
const CREATE = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${T0 + 1000000}`
// Delegated-dispenser pair : CREATOR signs the create, DELEGATE is the
// GET_ADDRESS the dispenser then operates on.
const CREATOR  = 'bcrt1qtestcreator'
const DELEGATE = 'bcrt1qtestdelegate'

describe('DISPENSER lifecycle mirror ', function () {
    this.timeout(0)

    it('format 1 cancel closes the open dispenser in the decoder view at the indexer close height', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                  source: ADDR },
            { id: 'cancel01', action: 'DISPENSER|1|7|bye',     source: ADDR },
        ], model)

        await decoder.start()

        // Create registered the dispenser; cancel brought its expiration forward to the
        // indexer's close time (cancel_block_time + DISPENSER_CLOSE_DELAY).
        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.insert[0].address, ADDR)
        assert.strictEqual(model.calls.cancel.length, 1)
        assert.deepStrictEqual(model.calls.cancel[0], {
            sourceAddress:   ADDR,
            closeExpiration: T0 + DISPENSER_CLOSE_DELAY,
        })

        // During the cancelling window the address is still open (the indexer keeps
        // dispensing until DISPENSER_CLOSE fires), so it must remain captured.
        let open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'dispenser stays open through the close-delay window')

        // A later block whose time passes the close height soft-expires the row. After
        // it, the decoder view no longer holds the address -> matches the indexer, which
        // fired DISPENSER_CLOSE at exactly block_time > cancel_time + DISPENSER_CLOSE_DELAY.
        await model.deleteOpenDispensers(1, T0 + DISPENSER_CLOSE_DELAY + 1)
        open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(ADDR), 'cancel closes the dispenser at the indexer close height')
    })

    it('format 2 edit re-dates the expiry so the decoder view expires when the indexer does', async () => {
        const model = new DispenserModel()
        const editExpiration = T0 + 100 // future (indexer requires EXPIRATION > BLOCK_TIME), shorter than create
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                              source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${editExpiration}||`, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.edit.length, 1)
        assert.deepStrictEqual(model.calls.edit[0], { sourceAddress: ADDR, newExpiration: editExpiration })

        // Not yet expired at the edited time boundary...
        await model.deleteOpenDispensers(1, editExpiration)  // block_time == edited expiration: expiration < block_time is false
        let open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'still open at exactly the edited expiration')

        // ...expires once block_time passes the edited (earlier) expiration, not the
        // original far-future one. Pre-fix the row would still carry T0+1000000 here.
        await model.deleteOpenDispensers(2, editExpiration + 1)
        open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(ADDR), 'edit shortened the expiry to the indexer-overlaid value')
    })

    it('format 2 edit with an empty EXPIRATION is a no-op (only a present EXPIRATION moves the view)', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                source: ADDR },
            { id: 'edit01',   action: 'DISPENSER|2|7|||||',  source: ADDR }, // EXPIRATION (index 4) empty
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.edit.length, 0, 'empty EXPIRATION does not re-date the dispenser')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000, 'stored expiration is unchanged')
    })

    it('format 2 edit with a past EXPIRATION is skipped (indexer rejects EXPIRATION <= BLOCK_TIME)', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                          source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${T0 - 100}||`,  source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.edit.length, 0, 'a non-future EXPIRATION is not applied')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000)
    })

    it('a cancel from an address that owns no dispenser at all is a no-op', async () => {
        // The decoder resolves the target by acting address (it has no indexer
        // action_index). An address that is neither the operating address nor the
        // recorded create SOURCE of any open row matches nothing, exactly as the indexer
        // rejects it with "invalid: SOURCE (not owner)". No row is guessed at.
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,               source: ADDR },
            { id: 'cancel01', action: 'DISPENSER|1|7|bye',  source: 'bcrt1qsomeoneelse' },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.cancel.length, 1, 'the cancel decision still fires')
        // The far-future expiry is untouched: no open row was actionable by that address.
        await model.deleteOpenDispensers(1, T0 + DISPENSER_CLOSE_DELAY + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'an unauthorised cancel leaves the dispenser open')
    })

    // ── Delegated (GET_ADDRESS) dispensers, . The indexer authorises a cancel/edit
    //    from the dispenser SOURCE *or* its GET_ADDRESS
    //    (xchain-indexer/src/actions/dispenser.js, "invalid: SOURCE (not owner)"). The
    //    decoder keys the open row on the operating address (GET_ADDRESS when delegated),
    //    so before this fix a creator-issued cancel matched no row and the decoder kept
    //    the delegated address in its open set long past the indexer's DISPENSER_CLOSE:
    //    every later plain payment to that address was still captured as a dispense
    //    trigger the indexer drops. These pin the closure.
    //
    // SENSITIVITY: both fail against pre- code, where insertDispenser records no
    // create SOURCE and the cancel/edit lookups match on the operating address only.

    it('a delegated dispenser is closed by a cancel from its original creator', async () => {
        const model = new DispenserModel()
        // GET_ADDRESS (field 10) = DELEGATE, so the dispenser operates on DELEGATE while
        // CREATOR signs the create.
        const delegatedCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|${DELEGATE}||||${T0 + 1000000}`
        const decoder = buildDecoder([
            { id: 'create01', action: delegatedCreate,       source: CREATOR },
            { id: 'cancel01', action: 'DISPENSER|1|7|bye',   source: CREATOR },
        ], model)

        await decoder.start()

        // The row is keyed on the delegated operating address, and carries the creator.
        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.insert[0].address, DELEGATE)
        assert.strictEqual(model.rows[0].sourceAddress, CREATOR)

        // The creator's cancel resolves to it and brings the expiry to the indexer's
        // close time, so the address leaves the open set at the same height.
        assert.strictEqual(model.rows[0].expiration, T0 + DISPENSER_CLOSE_DELAY)
        let open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(DELEGATE), 'still open through the cancelling window')
        await model.deleteOpenDispensers(1, T0 + DISPENSER_CLOSE_DELAY + 1)
        open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(DELEGATE), 'closed at the indexer close height, not at its original expiry')
    })

    it('a creator-issued EXPIRATION edit re-dates the delegated dispenser', async () => {
        const model = new DispenserModel()
        const delegatedCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|${DELEGATE}||||${T0 + 1000000}`
        const shortened = T0 + 500
        const decoder = buildDecoder([
            { id: 'create01', action: delegatedCreate,                 source: CREATOR },
            { id: 'edit01',   action: `DISPENSER|2|7||${shortened}||`, source: CREATOR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.edit.length, 1)
        assert.strictEqual(model.rows[0].expiration, shortened)
        await model.deleteOpenDispensers(1, shortened + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(DELEGATE), 'the shortened expiry closes the delegated dispenser')
    })

    it('an operating-address dispenser wins over a delegated one the same address created', async () => {
        // An address can hold its own dispenser AND be the creator of a delegated one.
        // The action_index that would disambiguate is not in the decoder's id space, so
        // resolution prefers the row keyed on the acting address. That preference is the
        // safe direction: closing the delegated row early would stop capturing payments
        // to a dispenser that is still live (money-bearing), while leaving it open only
        // produces triggers the indexer authoritatively drops.
        const model = new DispenserModel()
        const delegatedCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|${DELEGATE}||||${T0 + 1000000}`
        // The delegated row is deliberately the MORE RECENT of the two, so a
        // recency-only resolution would pick it and the assertion below would fail.
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,               source: CREATOR },  // own, older
            { id: 'create02', action: delegatedCreate,      source: CREATOR },  // delegated, newer
            { id: 'cancel01', action: 'DISPENSER|1|7|bye',  source: CREATOR },
        ], model)

        await decoder.start()

        const ownRow       = model.rows.find(r => r.address === CREATOR)
        const delegatedRow = model.rows.find(r => r.address === DELEGATE)
        assert.strictEqual(ownRow.expiration, T0 + DISPENSER_CLOSE_DELAY, 'the own dispenser is the one closed')
        assert.strictEqual(delegatedRow.expiration, T0 + 1000000, 'the delegated dispenser is left alone')
    })

    // ── DISPENSER caps twin (, Leg F). At/after the caps flag-day
    //    (dispenser_caps_activation.js, mainnet block_time 1786924800, testnet/regtest
    //    genesis) the INDEXER closes a dispenser at MAX_DISPENSES and rejects the 6th
    //    refill (MAX_REFILLS). Below assess/pin what the recognition-only decoder can
    //    mirror in lockstep, and document what it structurally cannot.

    it('documented residual: the decoder cannot mirror the MAX_DISPENSES auto-close', async () => {
        // The indexer closes a dispenser once it has served MAX_DISPENSES (1000) VALID
        // dispenses since its last refill. "Valid" is an INDEXER-ONLY verdict: it depends
        // on COIN_AMOUNT vs GET_AMOUNT pricing (including FIAT/oracle reverse-match), the
        // remaining GIVE escrow, the ALLOW/BLOCK lists, and the per-trigger multiplier. The
        // decoder is recognition-only: it captures raw payment outputs to the dispenser
        // address (transaction_outputs) but tracks NO dispense count and NO escrow, so it
        // cannot know when the indexer's count reaches 1000 and cannot compute the multiplier
        // or escrow-exhaustion. There is therefore no faithful lockstep counting to
        // implement; the decoder's open-view is driven solely by create/cancel/edit/
        // EXPIRATION and has no count-based close surface at all. This pins the boundary (like
        // the delegated-cancel residual above): a dispenser the indexer closed via the cap
        // stays open in the decoder view until its OWN EXPIRATION (or a cancel/edit), and the
        // over-captured dispense payments are the known, bounded divergence the indexer
        // authoritatively drops (findMatchingDispensers ignores the closed dispenser) and
        // xchain-indexer/src/dispenserDivergenceMetrics.js (recordRejectedDispense) already
        // measures. Below the caps flag-day the indexer does not close at 1000, so there is
        // no divergence to mirror.
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE, source: ADDR },
        ], model)
        await decoder.start()

        // No count-based close surface exists: the lifecycle is only ever asked to
        // insert/cancel/edit/expire, never to close on dispense volume.
        assert.strictEqual(model.calls.cancel.length, 0, 'no dispense count triggers a cancel/close')
        assert.strictEqual(model.calls.edit.length, 0)

        // The dispenser stays open at its far-future create EXPIRATION regardless of dispense
        // volume; it leaves the open set only when block_time passes that EXPIRATION, NOT at
        // MAX_DISPENSES (which the decoder cannot detect).
        let open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'no dispense count closes the decoder dispenser')
        await model.deleteOpenDispensers(1, (T0 + 1000000) + 1)
        open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(ADDR), 'the decoder closes it only at its own EXPIRATION, not at the cap')
    })

    it('documented residual: MAX_REFILLS is open-view-neutral (a rejected 6th refill does not diverge)', async () => {
        // The indexer enforces MAX_REFILLS by REJECTING the 6th refill (an acceptance
        // verdict), which leaves the dispenser OPEN exactly as before. A refill is a format-2
        // edit that tops up GIVE_ESCROW; with no EXPIRATION change it does not move the
        // decoder's expiration-driven open-view (see the empty-EXPIRATION edit no-op test
        // above). So whether the indexer accepted or rejected the refill, BOTH sides keep the
        // dispenser open: MAX_REFILLS creates no decoder/indexer open-view divergence and
        // needs no decoder change. (The refill's reset of the dispense count only affects the
        // MAX_DISPENSES close point, which is the residual pinned above.)
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                  source: ADDR },
            { id: 'refill01', action: 'DISPENSER|2|7|100|||||', source: ADDR }, // give_escrow top-up, no EXPIRATION
        ], model)
        await decoder.start()

        // A pure escrow refill carries no EXPIRATION, so it does not re-date the row: the
        // open-view decision is a no-op and the dispenser stays open at its original expiry.
        assert.strictEqual(model.calls.edit.length, 0, 'a pure escrow refill does not move the decoder open-view')
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'the dispenser stays open regardless of the refill accept/reject verdict')
    })
})
