// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.


const assert = require('assert')
const { DispenserModel, buildDecoder, T0, INDEXER_CLOSE_DELAY, ADDR, CREATE, CREATOR,
        DELEGATE, DISPENSER_EXPIRY_REALIGN_ACTIVATION } =
    require('./helpers/support.js')

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

    // The ORDERING case the mirror was missing.
    //
    // BELOW DISPENSER_EXPIRY_REALIGN_ACTIVATION the decoder soft-expires at block
    // START (deleteOpenDispensers, before the tx loop);
    // the indexer expires at block END (processExpirations, after it). So on the first
    // block whose header time passes an expiration, the indexer applies a same-block
    // format-2 extension BEFORE its expiry pass and keeps the dispenser open, while the
    // decoder had already stamped expired_block_index and its `IS NULL`-only extend filter
    // could not reach the row. The extend no-oped, the decoder row stayed closed FOREVER,
    // and payments to a dispenser the indexer still honours stopped being captured. That is
    // the money-bearing direction, and it is the exact failure this mirror exists to
    // prevent, so a stamp from THIS block is cleared.
    //
    // Pinned to the LEGACY era on purpose. The harness builds a regtest decoder, and regtest
    // is genesis-on for the realign gate, so left alone this case would never produce a
    // same-block stamp at all and would pass vacuously. The clear it asserts still governs
    // every network below the gate (and any re-processed block above it), so the era is
    // disarmed here to keep the assertion pointed at the mechanism it was written for.
    it('a same-block extend REOPENS a row this block soft-expired', async () => {
        const model = new DispenserModel()
        // Pre-existing row, already past its expiry at this block's header time, so the
        // block-start soft-expire stamps it before any transaction is seen.
        model.rows.push({ txIndex: 1, address: ADDR, expiration: T0 - 10,
                          expiredBlockIndex: null, oracleAddress: null, sourceAddress: null })
        const extended = T0 + 2000000
        const decoder = buildDecoder([
            { id: 'edit01', action: `DISPENSER|2|7||${extended}||`, source: ADDR },
        ], model)

        const savedGate = DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest
        DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest = null
        try { await decoder.start() }
        finally { DISPENSER_EXPIRY_REALIGN_ACTIVATION.regtest = savedGate }

        assert.strictEqual(model.calls.extend.length, 1, 'the edit must reach the mirror')
        assert.strictEqual(model.stampsCleared, 1,
            'the legacy block-start soft-expire must actually have stamped the row, and the ' +
            'extend must actually have cleared that stamp; 0 here means the case went vacuous');
        assert.strictEqual(model.rows[0].expiredBlockIndex, null,
            'the soft-expiry stamp from THIS block must be cleared, not left to close the row forever');
        assert.strictEqual(model.rows[0].expiration, extended, 'and the expiry moved out')
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR),
            'a validly-extended dispenser must be back in the open-view, matching the indexer')
    })
})

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

    it('a same-block extend does NOT reopen a row an EARLIER block expired', async () => {
        // Reopening a row closed in an earlier block would be exactly the guessed-target
        // row surgery this mirror removed, and the indexer settled that lifecycle long ago.
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
        // the decoder only guessed at, which is the defect the advisory design removes.
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
})

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

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
        // create SOURCE). An address that is neither matches zero rows, exactly as
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
})
