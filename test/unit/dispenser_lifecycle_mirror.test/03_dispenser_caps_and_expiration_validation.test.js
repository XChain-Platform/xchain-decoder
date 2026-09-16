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

    // DISPENSER caps. At/after the caps flag-day (dispenser_caps_activation.js, mainnet
    // block_time 1786060800, testnet/regtest genesis) the INDEXER closes a dispenser at
    // MAX_DISPENSES and rejects the 6th refill (MAX_REFILLS). The cases below pin what
    // the recognition-only decoder can mirror in lockstep, and document what it
    // structurally cannot.
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
        // xchain-indexer/src/chain/dispenser_divergence_metrics.js (recordRejectedDispense) already
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
})

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

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

    // Fractional EXPIRATION. dispensers.expiration is BIGINT UNSIGNED on BOTH sides, and
    // the indexer rejects any non-integer EXPIRATION outright
    // (xchain-indexer/src/actions/dispenser.js, isInteger). A decoder that accepts one
    // either wedges the block loop (a strict sql_mode fails the write, so the loop
    // retries the same deterministic tx forever) or truncates it, leaving an open row for
    // a dispenser the indexer never registered. Both write sites refuse it at parse time.
})

describe("DISPENSER lifecycle mirror: advisory open-view", function () {
    this.timeout(0)

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
