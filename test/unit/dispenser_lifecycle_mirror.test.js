// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DISPENSER lifecycle mirror: ADVISORY open-view.
//
// The decoder once tracked DISPENSER format 1 (cancel) and format 2 (edit) so its
// open-dispenser view would CLOSE when the indexer's did. The two sides do not address
// dispensers the same way at all: the indexer targets a cancel/edit by an explicit
// DISPENSER_ACTION_INDEX, while the decoder runs UPSTREAM of it and has no such id, so
// it resolved the target by SOURCE with a most-recent-first guess. Whenever one source
// held more than one open dispenser that guess could close the WRONG row, which stops
// capturing payment outputs to a still-live dispenser: money-bearing, and not fixable
// by any tie-break rule.
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
// SENSITIVITY: the cancel and shorten assertions FAIL against the closing-mirror code
// they replace, which closed the row at the indexer's close height or re-dated it
// earlier.

const assert = require('assert')
const { DispenserModel, buildDecoder, T0, INDEXER_CLOSE_DELAY, ADDR, CREATE, CREATOR,
        DELEGATE, DISPENSER_EXPIRY_REALIGN_ACTIVATION } =
    require('./dispenser_lifecycle_mirror.test/helpers/support.js')

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
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

        // It closes only at its OWN expiration: the soft-expire is the single closer.
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
        // blockIndex rides along so the mirror can clear a same-block soft-expiry stamp.
        assert.deepStrictEqual(model.calls.extend[0],
            { sourceAddress: ADDR, newExpiration: extended, blockIndex: 0 })
        assert.strictEqual(model.rows[0].expiration, extended, 'the stored expiry moved out')

        // Past the ORIGINAL expiry the dispenser is still open, matching the indexer.
        await model.deleteOpenDispensers(1, (T0 + 1000000) + 1)
        const open = await model.getAllOpenDispenserAddresses()
        assert.ok(open.has(ADDR), 'the extended dispenser is still captured past its old expiry')
    })
})
