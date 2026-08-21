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
// The decoder reads three DISPENSER fields by split offset: ORACLE_ADDRESS (the token
// oracle-fee capture keys on), the v0 create EXPIRATION and the v2 edit EXPIRATION. The
// authoritative layout is the indexer's own format strings
// (xchain-indexer/src/actions/dispenser.js this.formats), and until this guard existed the
// only thing binding the two was a prose comment, while every comparable dependency at this
// seam already had a mechanical gate (indexerBatchLimits.js vendoring,
// oracleFeeOutputActivationConformance.js).
//
// Drift is money-bearing in both directions: a field inserted ahead of ORACLE_ADDRESS makes
// capture key on the wrong token, so the indexer rejects every fee-bearing Mode B create
// with 'missing oracle fee output' after the payer's coin is spent; a shifted EXPIRATION
// diverges the decoder's open-dispenser set from the indexer's.
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

const { ORACLE_ADDRESS_INDEX, V0_EXPIRATION_INDEX, V2_EXPIRATION_INDEX, oracleAddressFromCreate } =
    require('../../src/oracleFeeOutput.js');

// Offsets the decode path in src/XChainDecoder.js and src/oracleFeeOutput.js was written
// against. Decoder offset = indexer format position + 1: the decoder splits with the ACTION
// token ('DISPENSER') at 0, the indexer's format string starts at VERSION.
const PINNED = { ORACLE_ADDRESS: 13, V0_EXPIRATION: 14, V2_EXPIRATION: 4 };
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
