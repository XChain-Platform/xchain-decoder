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

// DISPENSER wire field-offset drift guard.
//
// The decoder reads six DISPENSER positions by split offset, plus the length of the
// required run: GIVE_COIN and GET_COIN (the chain gate), GET_ADDRESS (the operating
// address the dispenser row is registered under), ORACLE_ADDRESS (the token oracle-fee
// capture keys on), the v0 create EXPIRATION and the v2 edit EXPIRATION. The
// authoritative layout is the indexer's own format strings
// (xchain-indexer/src/actions/dispenser.js this.formats), and until this guard existed the
// only thing binding the two was a prose comment, while every comparable dependency at this
// seam already had a mechanical gate (indexerBatchLimits.js vendoring,
// oracleFeeOutputActivationConformance.js).
//
// Drift is money-bearing in both directions: a field inserted ahead of ORACLE_ADDRESS makes
// capture key on the wrong token, so the indexer rejects every fee-bearing Mode B create
// with 'missing oracle fee output' after the payer's coin is spent; a shifted EXPIRATION
// diverges the decoder's open-dispenser set from the indexer's; and a shifted GET_ADDRESS
// registers the dispenser on a token no output can pay, so its payments never reach
// transaction_outputs and no DISPENSE is emitted while the indexer keeps it open and
// escrowed. The guard covered only the last three of those until every position the
// decode path reads was named - the three unbound ones happened to be correct, which is
// what a coverage gap looks like from inside.
//
// Two tiers, so a one-sided edit fails somewhere no matter which checkout is present:
//   1. PIN     - the constants equal the offsets this repo's decode path was written
//                against, in this repo alone.
//   2. INDEXER - they equal the offsets derived from the LIVE sibling Dispenser's
//                this.formats, read off an instance rather than scraped from source.
// Tier 2 skips when the sibling is absent (standalone deploy); XCHAIN_REQUIRE_SIBLINGS=1
// makes absence a failure instead of a green-by-skip.
//
// The PIN tier is deliberately hard-coded rather than derived. A sibling that REORDERS the
// format string is a protocol fork that needs a human decision, so it must fail this file
// loudly rather than be adopted by re-running a generator.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { V0_GIVE_COIN_INDEX, V0_GET_COIN_INDEX, V0_GET_ADDRESS_INDEX, V0_REQUIRED_FIELD_COUNT,
        ORACLE_ADDRESS_INDEX, V0_EXPIRATION_INDEX, V2_EXPIRATION_INDEX, oracleAddressFromCreate } =
    require('../../src/oracleFeeOutput.js');

// Offsets the decode path in src/XChainDecoder.js and src/oracleFeeOutput.js was written
// against. Decoder offset = indexer format position + 1: the decoder splits with the ACTION
// token ('DISPENSER') at 0, the indexer's format string starts at VERSION.
// REQUIRED_FIELD_COUNT is a COUNT, not a position: the required run ends at GET_AMOUNT
// (offset 9), so a conforming create is at least 10 tokens.
const PINNED = {
    GIVE_COIN: 2, GET_COIN: 7, GET_ADDRESS: 10, ORACLE_ADDRESS: 13,
    V0_EXPIRATION: 14, V2_EXPIRATION: 4, REQUIRED_FIELD_COUNT: 10,
};
const ACTION_TOKEN_OFFSET = 1;

const INDEXER_DISPENSER = process.env.XCHAIN_INDEXER_DIR
    ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'dispenser.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'dispenser.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true;
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file);
    ctx.skip();
    return false;
}

// Read the formats off a REAL Dispenser instance, not a regex over its source: they are
// assigned on `this` in the constructor, so a rename or a reformat keeps working while a
// scrape would silently read nothing and pass. The constructor only stores its collaborators,
// so a stub-shaped action object is enough and no database is needed (same trick as
// test/tools/sync-batch-limits.js).
function siblingFormats(){
    const Dispenser = require(INDEXER_DISPENSER);
    const dispenser = new Dispenser({
        config:          {},
        decoderDb:       {},
        indexerDb:       {},
        util:            {},
        mapper:          {},
        protocolChanges: {},
        actionAliases:   {},
    });
    return dispenser.formats;
}

function offsetOf(format, field){
    const position = String(format).split('|').indexOf(field);
    assert.notStrictEqual(position, -1, 'the sibling format no longer carries ' + field + ': ' + format);
    return position + ACTION_TOKEN_OFFSET;
}

describe('DISPENSER wire field offsets', function () {

    it('pins the offsets the decode path was written against', function () {
        assert.strictEqual(V0_GIVE_COIN_INDEX, PINNED.GIVE_COIN);
        assert.strictEqual(V0_GET_COIN_INDEX, PINNED.GET_COIN);
        assert.strictEqual(V0_GET_ADDRESS_INDEX, PINNED.GET_ADDRESS);
        assert.strictEqual(V0_REQUIRED_FIELD_COUNT, PINNED.REQUIRED_FIELD_COUNT);
        assert.strictEqual(ORACLE_ADDRESS_INDEX, PINNED.ORACLE_ADDRESS);
        assert.strictEqual(V0_EXPIRATION_INDEX, PINNED.V0_EXPIRATION);
        assert.strictEqual(V2_EXPIRATION_INDEX, PINNED.V2_EXPIRATION);
    });

    it('reads ORACLE_ADDRESS from the pinned slot and not a neighbouring one', function () {
        // Binds the behaviour, not just the constant: a split whose ORACLE_ADDRESS slot alone
        // carries an address must resolve to that address, and its neighbours must not.
        const fields = new Array(18).fill('');
        fields[0] = 'DISPENSER';
        fields[PINNED.ORACLE_ADDRESS] = 'bc1qoracle';
        assert.strictEqual(oracleAddressFromCreate(fields), 'bc1qoracle');

        const shifted = new Array(18).fill('');
        shifted[0] = 'DISPENSER';
        shifted[PINNED.ORACLE_ADDRESS - 1] = 'bc1qneighbour';
        assert.strictEqual(oracleAddressFromCreate(shifted), null);
    });

    it('matches the offsets derived from the live sibling indexer Dispenser formats', function () {
        if (!siblingOrSkip(this, INDEXER_DISPENSER)) return;
        const formats = siblingFormats();
        assert.ok(formats && typeof formats === 'object',
            'xchain-indexer Dispenser must expose this.formats');

        assert.strictEqual(offsetOf(formats[0], 'GIVE_COIN'), V0_GIVE_COIN_INDEX,
            'GIVE_COIN moved in the indexer v0 format: the decoder would gate dispenser opens on '
            + 'the wrong token, so a create for this chain would be skipped or one for another '
            + 'chain registered');
        assert.strictEqual(offsetOf(formats[0], 'GET_COIN'), V0_GET_COIN_INDEX,
            'GET_COIN moved in the indexer v0 format: same chain gate, same divergence between '
            + 'the decoder open set and the indexer');
        assert.strictEqual(offsetOf(formats[0], 'GET_ADDRESS'), V0_GET_ADDRESS_INDEX,
            'GET_ADDRESS moved in the indexer v0 format: the dispenser would be registered under '
            + 'the wrong operating address, its native-coin payments would never be captured to '
            + 'transaction_outputs, and no DISPENSE would be emitted while the indexer keeps the '
            + 'dispenser open and escrowed');
        // Derived from GET_AMOUNT, the last REQUIRED field, not from GET_ADDRESS: the two
        // are equal today only because the optional tail starts exactly there.
        assert.strictEqual(V0_REQUIRED_FIELD_COUNT, offsetOf(formats[0], 'GET_AMOUNT') + 1,
            'the required run no longer ends at GET_AMOUNT: the length gate would admit an '
            + 'incomplete create or drop a conforming one, the shape the old >= 14 gate cost');
        assert.strictEqual(offsetOf(formats[0], 'ORACLE_ADDRESS'), ORACLE_ADDRESS_INDEX,
            'ORACLE_ADDRESS moved in the indexer v0 format: oracle-fee capture would key on the '
            + 'wrong token and the indexer would reject every fee-bearing Mode B create');
        assert.strictEqual(offsetOf(formats[0], 'EXPIRATION'), V0_EXPIRATION_INDEX,
            'the v0 create EXPIRATION moved in the indexer format: the decoder open-dispenser '
            + 'set would diverge from the indexer');
        assert.strictEqual(offsetOf(formats[2], 'EXPIRATION'), V2_EXPIRATION_INDEX,
            'the v2 edit EXPIRATION moved in the indexer format: the decoder would extend the '
            + 'wrong expiry, or none');
    });
});
