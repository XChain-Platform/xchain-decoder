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

    // Delegated (GET_ADDRESS) dispensers. The indexer authorises a cancel/edit from the
    // dispenser SOURCE *or* its GET_ADDRESS (xchain-indexer/src/actions/dispenser.js,
    // "invalid: SOURCE (not owner)"). The decoder keys the open row on the operating
    // address (GET_ADDRESS when delegated) and stores the create SOURCE beside it, so a
    // creator-issued edit still reaches its row. That reach is kept here; only the
    // closing behaviour it once drove is gone.

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
})

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

    it('a creator-issued lengthening edit still reaches the delegated dispenser', async () => {
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
        // the old code therefore picked ONE row (operating address first, then most
        // recent): the guess that could act on the wrong dispenser. Extending BOTH is what
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
})
