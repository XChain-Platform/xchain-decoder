// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DISPENSER lifecycle mirror: ADVISORY open-view (#3119, revising ).
//
//  made the decoder track DISPENSER format 1 (cancel) and format 2 (edit) so its
// open-dispenser view would CLOSE when the indexer's did. #3119 found that the two sides
// do not address dispensers the same way at all: the indexer targets a cancel/edit by an
// explicit DISPENSER_ACTION_INDEX, while the decoder runs UPSTREAM of it and has no such
// id, so it resolved the target by SOURCE with a most-recent-first guess. Whenever one
// source held more than one open dispenser that guess could close the WRONG row, which
// stops capturing payment outputs to a still-live dispenser: money-bearing, and not
// fixable by any tie-break rule.
//
// The open-view is therefore explicitly advisory and the indexer is the sole arbiter of
// closure. What this suite now pins:
//   * a format-1 cancel is NOT mirrored at all (it could only ever close, on a guess);
//   * a format-2 EXPIRATION edit is mirrored in the EXTEND direction only, and against
//     every open row of the source rather than one guessed row, so the correct row is
//     always covered and any extra row is merely held open longer;
//   * the resulting divergence is one-directional: the decoder may stay open longer than
//     the indexer (extra captured outputs the indexer drops), never close earlier.
//
// These tests drive the REAL block-processing loop (decoder.start) with a faithful
// in-memory dispensers model whose methods mirror the db.js SQL semantics
// (deleteOpenDispensers: expiration < block_time AND open -> soft-expire;
// getAllOpenDispenserAddresses: addresses of open rows; extend: GREATEST(expiration, ?)
// over every open row the acting address may act on). The loop's own decision code
// decides whether to extend; the model reflects it; we then assert the open-view.
//
// SENSITIVITY: the cancel and shorten assertions FAIL against the  code they
// replace, which closed the row at the indexer's close height / re-dated it earlier.

const assert = require('assert')
const XChainDecoder = require('../../src/XChainDecoder')

const PREV_WIRE = Buffer.from(
    '00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210',
    'hex'
)

const T0 = 1700000000            // block timestamp used for the single processed block
// The indexer's cancel close-delay. Kept here as a local test value ONLY to express "a
// block time past where the indexer would have closed a cancelled dispenser"; the decoder
// no longer carries this constant (its twin and drift guard went with the cancel mirror).
const INDEXER_CLOSE_DELAY = 3600

// A faithful in-memory model of the decoder `dispensers` table. Each method mirrors
// the corresponding db.js query so the open-view we assert on is the same one the
// real SQL would produce.
class DispenserModel {
    constructor() {
        this.rows  = []
        this.calls = { insert: [], extend: [] }
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
    // Mirrors getOpenDispenserOracleAddressBySource's target resolution: open rows this
    // address may act on (operating address OR stored create SOURCE, ),
    // operating-address matches ranked first, then most recent. Since #3119 only the
    // oracle-address read uses the ranking - the extend path deliberately takes the whole
    // set (no ORDER BY, no LIMIT), because ranking is the guess that closed wrong rows.
    // `thisBlock` () widens the candidate set by exactly the rows THIS block's
    // soft-expire stamped, matching the extend UPDATE's
    // `(expired_block_index IS NULL OR expired_block_index = ?)`. Omitted by the readers,
    // which see only genuinely-open rows.
    _openFor(actingAddress, thisBlock) {
        return this.rows
            .filter(r => (r.expiredBlockIndex === null ||
                          (thisBlock !== undefined && r.expiredBlockIndex === thisBlock)) &&
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
    // Mirrors extendOpenDispenserExpirationBySource (#3119):
    //   UPDATE ... SET expiration = GREATEST(expiration, ?) ... (no ORDER BY, no LIMIT)
    // over EVERY open row the acting address may act on. Never shortens, never picks.
    // : the candidate set also admits a row THIS block soft-expired, and clears
    // that stamp, because deleteOpenDispensers ran before the transaction loop.
    async extendOpenDispenserExpirationBySource(sourceAddress, newExpiration, blockIndex) {
        this.calls.extend.push({ sourceAddress, newExpiration: Number(newExpiration), blockIndex })
        for (const r of this._openFor(sourceAddress, blockIndex)) {
            r.expiration = Math.max(Number(r.expiration), Number(newExpiration))
            if (r.expiredBlockIndex === blockIndex) r.expiredBlockIndex = null
        }
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
        extendOpenDispenserExpirationBySource: (s, e, b) => model.extendOpenDispenserExpirationBySource(s, e, b),
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

describe('DISPENSER lifecycle mirror: advisory open-view (#3119, revising )', function () {
    this.timeout(0)

    it('a format 1 cancel is not mirrored at all: no DB call, no closure', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                  source: ADDR },
            { id: 'cancel01', action: 'DISPENSER|1|7|bye',     source: ADDR },
        ], model)

        await decoder.start()

        // The create still registers. The cancel reaches no dispenser method whatsoever:
        // there is no longer a closing mirror to reach, guessed target or not.
        assert.strictEqual(model.calls.insert.length, 1)
        assert.strictEqual(model.calls.insert[0].address, ADDR)
        assert.strictEqual(model.calls.extend.length, 0, 'a cancel must not touch the open-view')

        // Past the height the indexer's DISPENSER_CLOSE would have fired, the decoder is
        // deliberately STILL open: it keeps capturing payment outputs and the indexer
        // authoritatively drops the triggers. That is the benign direction of divergence.
        await model.deleteOpenDispensers(1, T0 + INDEXER_CLOSE_DELAY + 1)
        let open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'a cancelled dispenser stays in the decoder open-view')

        // It closes only at its OWN expiration - the soft-expire is the single closer.
        await model.deleteOpenDispensers(2, (T0 + 1000000) + 1)
        open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(ADDR), 'the row still closes at its own EXPIRATION')
    })

    it('a format 2 edit that LENGTHENS the expiry is mirrored (the money-bearing case)', async () => {
        // This is why the edit mirror survives at all: the indexer overlays the edited
        // EXPIRATION, so without mirroring an extension the decoder would soft-expire at
        // the ORIGINAL time while the indexer kept dispensing, and payments to a live
        // dispenser would stop being captured.
        const model = new DispenserModel()
        const extended = T0 + 2000000            // beyond the create's T0 + 1000000
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                          source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${extended}||`,   source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 1)
        // blockIndex rides along since #4223 so the mirror can clear a same-block stamp.
        assert.deepStrictEqual(model.calls.extend[0],
            { sourceAddress: ADDR, newExpiration: extended, blockIndex: 0 })
        assert.strictEqual(model.rows[0].expiration, extended, 'the stored expiry moved out')

        // Past the ORIGINAL expiry the dispenser is still open, matching the indexer.
        await model.deleteOpenDispensers(1, (T0 + 1000000) + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'the extended dispenser is still captured past its old expiry')
    })

    // : the ORDERING case the mirror was missing.
    //
    // The decoder soft-expires at block START (deleteOpenDispensers, before the tx loop);
    // the indexer expires at block END (processExpirations, after it). So on the first
    // block whose header time passes an expiration, the indexer applies a same-block
    // format-2 extension BEFORE its expiry pass and keeps the dispenser open, while the
    // decoder had already stamped expired_block_index and its `IS NULL`-only extend filter
    // could not reach the row. The extend no-oped, the decoder row stayed closed FOREVER,
    // and payments to a dispenser the indexer still honours stopped being captured. That is
    // the money-bearing direction, and it is the exact failure this mirror exists to
    // prevent, so a stamp from THIS block is cleared.
    it('a same-block extend REOPENS a row this block soft-expired (#4223)', async () => {
        const model = new DispenserModel()
        // Pre-existing row, already past its expiry at this block's header time, so the
        // block-start soft-expire stamps it before any transaction is seen.
        model.rows.push({ txIndex: 1, address: ADDR, expiration: T0 - 10,
                          expiredBlockIndex: null, oracleAddress: null, sourceAddress: null })
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'edit01', action: `DISPENSER|2|7||${extended}||`, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 1, 'the edit must reach the mirror')
        assert.strictEqual(model.rows[0].expiredBlockIndex, null,
            'the soft-expiry stamp from THIS block must be cleared, not left to close the row forever');
        assert.strictEqual(model.rows[0].expiration, extended, 'and the expiry moved out')
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR),
            'a validly-extended dispenser must be back in the open-view, matching the indexer')
    })

    it('a same-block extend does NOT reopen a row an EARLIER block expired (#4223 scope)', async () => {
        // Reopening a row closed in an earlier block would be exactly the guessed-target
        // row surgery #3119 removed, and the indexer settled that lifecycle long ago.
        const model = new DispenserModel()
        // The harness processes height 0, so a stamp of -1 is "some other, earlier block".
        // deleteOpenDispensers only stamps rows still at NULL, so it stays -1.
        model.rows.push({ txIndex: 1, address: ADDR, expiration: T0 - 10,
                          expiredBlockIndex: -1, oracleAddress: null, sourceAddress: null })
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'edit01', action: `DISPENSER|2|7||${extended}||`, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.rows[0].expiredBlockIndex, -1,
            'a row closed by another block stays closed')
        assert.strictEqual(model.rows[0].expiration, T0 - 10, 'and its expiry is untouched')
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(!open.has(ADDR), 'it must not return to the open-view')
    })

    it('a format 2 edit that SHORTENS the expiry is deliberately NOT mirrored', async () => {
        // The indexer will close at the shortened time; the decoder keeps capturing until
        // the original one. Mirroring the shortening faithfully would mean closing a row
        // the decoder only guessed at, which is the defect #3119 is about.
        const model = new DispenserModel()
        const shortened = T0 + 100  // future (indexer requires EXPIRATION > BLOCK_TIME), earlier than create
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                          source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${shortened}||`,  source: ADDR },
        ], model)

        await decoder.start()

        // The decision still fires (the loop cannot know which direction is safe; the DB
        // layer's GREATEST is what refuses to shorten), and the row keeps its own expiry.
        assert.strictEqual(model.calls.extend.length, 1)
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000, 'expiration never moves earlier')

        await model.deleteOpenDispensers(1, shortened + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'the decoder stays open past the indexer close, never before it')
    })

    it('format 2 edit with an empty EXPIRATION is a no-op (only a present EXPIRATION moves the view)', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                source: ADDR },
            { id: 'edit01',   action: 'DISPENSER|2|7|||||',  source: ADDR }, // EXPIRATION (index 4) empty
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 0, 'empty EXPIRATION does not re-date the dispenser')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000, 'stored expiration is unchanged')
    })

    it('format 2 edit with a past EXPIRATION is skipped (indexer rejects EXPIRATION <= BLOCK_TIME)', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                          source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${T0 - 100}||`,  source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 0, 'a non-future EXPIRATION is not applied')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000)
    })

    it('an extend from an address that owns no dispenser at all is a no-op', async () => {
        // The extend still resolves by acting address (operating address OR recorded
        // create SOURCE, ). An address that is neither matches zero rows, exactly as
        // the indexer rejects it with "invalid: SOURCE (not owner)". Nothing is guessed at,
        // and in this direction a miss is harmless anyway.
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                              source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${T0 + 2000000}||`,   source: 'bcrt1qsomeoneelse' },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 1, 'the extend decision still fires')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000, 'an unauthorised edit moves nothing')
    })

    // ── Delegated (GET_ADDRESS) dispensers, . The indexer authorises a cancel/edit
    //    from the dispenser SOURCE *or* its GET_ADDRESS
    //    (xchain-indexer/src/actions/dispenser.js, "invalid: SOURCE (not owner)"). The
    //    decoder keys the open row on the operating address (GET_ADDRESS when delegated)
    //    and stores the create SOURCE beside it, so a creator-issued edit still reaches
    //    its row.  wired that up to close delegated rows; #3119 keeps the reach and
    //    drops the closing.

    it('a delegated dispenser is NOT closed by a cancel from its original creator', async () => {
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

        // The cancel changes nothing: the delegated address stays captured past the
        // indexer's close height, which is the benign side of the divergence.
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000)
        await model.deleteOpenDispensers(1, T0 + INDEXER_CLOSE_DELAY + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(DELEGATE), 'the delegated dispenser stays in the decoder open-view')
    })

    it('a creator-issued lengthening edit still reaches the delegated dispenser ( reach kept)', async () => {
        const model = new DispenserModel()
        const delegatedCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|${DELEGATE}||||${T0 + 1000000}`
        const extended = T0 + 3000000
        const decoder = buildDecoder([
            { id: 'create01', action: delegatedCreate,                source: CREATOR },
            { id: 'edit01',   action: `DISPENSER|2|7||${extended}||`, source: CREATOR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 1)
        assert.strictEqual(model.rows[0].expiration, extended,
            'the creator-issued extension reaches the delegated row via source_address_id')
        await model.deleteOpenDispensers(1, (T0 + 1000000) + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(DELEGATE), 'still captured past its original expiry, as the indexer expects')
    })

    it('an extend covers EVERY open row of the source, so no row is guessed at', async () => {
        // An address can hold its own dispenser AND be the creator of a delegated one.
        // The action_index that would disambiguate is not in the decoder's id space, and
        // the pre-#3119 code therefore picked ONE row (operating address first, then most
        // recent) - the guess that could act on the wrong dispenser. Extending BOTH is what
        // removes the guess: the correct row is always covered, and the other one is merely
        // held open longer, which the indexer authoritatively absorbs.
        const model = new DispenserModel()
        const delegatedCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|${DELEGATE}||||${T0 + 1000000}`
        const extended = T0 + 4000000
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                          source: CREATOR },  // own, older
            { id: 'create02', action: delegatedCreate,                 source: CREATOR },  // delegated, newer
            { id: 'edit01',   action: `DISPENSER|2|7||${extended}||`,   source: CREATOR },
        ], model)

        await decoder.start()

        const ownRow       = model.rows.find(r => r.address === CREATOR)
        const delegatedRow = model.rows.find(r => r.address === DELEGATE)
        assert.strictEqual(ownRow.expiration, extended,       'the own dispenser is extended')
        assert.strictEqual(delegatedRow.expiration, extended, 'and so is the delegated one');
        // Teeth: a LIMIT 1 resolution would have left one of the two at its create expiry.
        assert.notStrictEqual(ownRow.expiration, T0 + 1000000)
        assert.notStrictEqual(delegatedRow.expiration, T0 + 1000000)
    })

    // ── DISPENSER caps twin (, Leg F). At/after the caps flag-day
    //    (dispenser_caps_activation.js, mainnet block_time 1786060800, testnet/regtest
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
        // insert/extend/expire, never to close on dispense volume.
        assert.strictEqual(model.calls.extend.length, 0, 'no dispense count moves the open-view')

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
        assert.strictEqual(model.calls.extend.length, 0, 'a pure escrow refill does not move the decoder open-view')
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'the dispenser stays open regardless of the refill accept/reject verdict')
    })

    // -- Fractional EXPIRATION (). dispensers.expiration is BIGINT UNSIGNED on
    //    BOTH sides, and the indexer rejects any non-integer EXPIRATION outright
    //    (xchain-indexer/src/actions/dispenser.js, isInteger). A decoder that accepts one
    //    either wedges the block loop (a strict sql_mode fails the write, so the loop
    //    retries the same deterministic tx forever) or truncates it, leaving an open row
    //    for a dispenser the indexer never registered. Both write sites refuse it at parse
    //    time.

    it('a CREATE with a fractional EXPIRATION is skipped before the BIGINT write', async () => {
        const model = new DispenserModel()
        const fractionalCreate = `DISPENSER|0|BTC|TICK|1||10|BTC||1|||||${T0 + 1000000}.5`
        const decoder = buildDecoder([
            { id: 'create01', action: fractionalCreate, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 0,
            'a fractional EXPIRATION must never reach insertDispenser')
        assert.strictEqual(decoder.parseErrors, 1, 'the skip is counted as a parse error')
        const open = await model.getAllOpenDispenserAddresses()
        assert.strictEqual(open.size, 0, 'no open row exists for an indexer-invalid dispenser')
    })

    it('an EDIT with a fractional EXPIRATION does not extend anything', async () => {
        const model = new DispenserModel()
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                               source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${T0 + 2000000}.25||`, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.extend.length, 0,
            'a fractional edit EXPIRATION must never reach extendOpenDispenserExpirationBySource')
        assert.strictEqual(model.rows[0].expiration, T0 + 1000000, 'the stored expiry is unchanged')
    })

    it('an integral EXPIRATION still passes both guards unchanged', async () => {
        // Teeth for the two cases above: the same wire shapes with integral values must
        // still create and still extend, so the guard rejects fractions and nothing else.
        const model = new DispenserModel()
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'create01', action: CREATE,                        source: ADDR },
            { id: 'edit01',   action: `DISPENSER|2|7||${extended}||`, source: ADDR },
        ], model)

        await decoder.start()

        assert.strictEqual(model.calls.insert.length, 1, 'an integral create still registers')
        assert.strictEqual(model.calls.extend.length, 1, 'an integral edit still extends')
        assert.strictEqual(decoder.parseErrors, 0, 'no parse error on the valid path')
        assert.strictEqual(model.rows[0].expiration, extended)
    })
})
