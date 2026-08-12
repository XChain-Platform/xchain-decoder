// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DB-layer unit tests for the DISPENSER open-view mirror (, revised by #3119).
// These pin the real db.js UPDATE that re-dates an open dispenser row: the SQL shape,
// the bound args order, and the same false/true rollback-signalling contract
// insertDispenser uses. No real DB: a fake pool is injected, like db.queries.test.js.
//
// #3119 turned the two closing mirrors into ONE extending one. The decoder's open-view is
// advisory (the indexer targets a cancel/edit by DISPENSER_ACTION_INDEX, which the decoder
// does not have), so what the SQL must NOT do is now as load-bearing as what it does:
// never move an expiration earlier, and never pick one row out of several. Both negatives
// are asserted below, because both were present before and either one coming back
// reintroduces the money-bearing failure (closing a row while the indexer still dispenses
// from it, so payments to it stop being captured).

'use strict';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../src/db.js');

function makeDb(name = 'xchain_btc_regtest') {
    return new Database('127.0.0.1', 3306, name, 'u', 'p');
}

function withConn(queryStub) {
    const conn = {
        query:   queryStub || sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
    };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn };
}

function injectPool(db, pool) {
    db.pool = pool;
}

describe('the cancel mirror is retired (#3119)', () => {
    it('db.js exposes no dispenser-closing method at all', () => {
        const db = makeDb();
        // A cancel could only ever be mirrored by moving an expiration EARLIER on a row
        // resolved by SOURCE, i.e. closing a guessed dispenser. The method is gone rather
        // than fixed; re-adding one under any name reopens #3119.
        assert.strictEqual(typeof db.cancelOpenDispenserBySource, 'undefined');
        assert.strictEqual(typeof db.editOpenDispenserExpirationBySource, 'undefined',
            'the unconditional-set edit is gone too; only the extending form survives');
    });
});

describe('Database#extendOpenDispenserExpirationBySource() (#3119)', () => {
    afterEach(() => sinon.restore());

    it('extends with GREATEST and never shortens', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const ok = await db.extendOpenDispenserExpirationBySource('bcrt1qsource', 1700050000, 900);

        assert.strictEqual(ok, true);
        assert.ok(q.calledOnce, 'exactly one query is issued');
        const [sql, args] = q.firstCall.args;
        assert.match(sql, /UPDATE\s+dispensers/i);
        assert.match(sql, /SET\s+expiration\s*=\s*GREATEST\(\s*expiration\s*,\s*\?\s*\)/i,
            'the stored expiration may only move outward');
        assert.doesNotMatch(sql, /SET\s+expiration\s*=\s*\?/i,
            'an unconditional SET would let a shortening edit close the row early');
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i);
        // Args: the new expiration, this block's height (the soft-expiry stamp the CASE
        // clears, ), the acting address once per key subquery, then the height
        // again for the WHERE's this-block admission. The third bind of the pre-#3119
        // query was the ranking term, which no longer exists.
        assert.deepStrictEqual(args, [1700050000, 900, 'bcrt1qsource', 'bcrt1qsource', 900]);
    });

    // . deleteOpenDispensers stamps expired_block_index at block START, before
    // the transaction loop that applies a format-2 edit, so an `IS NULL`-only filter could
    // not reach the very row a same-block extend exists for: the extend no-oped, the
    // decoder row stayed closed forever, and it stopped capturing payments to a dispenser
    // the indexer applied the same edit to and kept open. The restore is scoped to THIS
    // block's stamp; an earlier block's close stays closed, since reopening one would be
    // the guessed-target row surgery #3119 removed.
    it('reopens a row soft-expired by THIS block, and only this block', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        await db.extendOpenDispenserExpirationBySource('bcrt1qsource', 1700050000, 900);

        const [sql, args] = q.firstCall.args;
        assert.match(sql, /expired_block_index\s*=\s*CASE\s+WHEN\s+expired_block_index\s*=\s*\?\s+THEN\s+NULL\s+ELSE\s+expired_block_index\s+END/i,
            'the soft-expiry mark must be cleared, not merely stepped over');
        assert.match(sql, /\(\s*expired_block_index\s+IS\s+NULL\s+OR\s+expired_block_index\s*=\s*\?\s*\)/i,
            'the WHERE must admit a row this block expired');
        assert.doesNotMatch(sql, /expired_block_index\s+IS\s+NOT\s+NULL/i,
            'a blanket reopen would resurrect dispensers closed in earlier blocks');
        // Both height binds are the CURRENT block, never a range or a constant.
        assert.strictEqual(args[1], 900);
        assert.strictEqual(args[4], 900);
    });

    it('picks no row: no ORDER BY and no LIMIT, so every open row of the source is covered', async () => {
        // The target selection IS the defect. With two open dispensers on one source, a
        // LIMIT 1 pick could extend the wrong one and leave the right one to expire early
        // in the decoder view, which stops capturing payments the indexer still honours.
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        await db.extendOpenDispenserExpirationBySource('bcrt1qsource', 1700050000, 900);

        const sql = q.firstCall.args[0];
        assert.doesNotMatch(sql, /ORDER\s+BY/i, 'no ranking: ranking is how the wrong row got picked');
        // No row limit on the UPDATE itself. Anchored past the last WHERE term, because the
        // scalar address subqueries legitimately carry their own LIMIT 1 (one id per
        // address) and a bare /LIMIT/ would match those and pass for the wrong reason.
        assert.doesNotMatch(sql, /expired_block_index\s+IS\s+NULL[\s\S]*\bLIMIT\b/i,
            'no single-row limit on the dispensers UPDATE');
        //  reach is kept: the indexer authorises an edit from the dispenser SOURCE
        // *or* its GET_ADDRESS, so both keys still match.
        assert.match(sql, /address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
        assert.match(sql, /OR\s+source_address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
    });

    it('returns false on a query error and does not end a non-existent transaction', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        // Not inside a block transaction, so the error path must not try to end one.
        db.endTransaction = sinon.stub().resolves();

        const ok = await db.extendOpenDispenserExpirationBySource('bcrt1qsource', 1700050000, 900);

        assert.strictEqual(ok, false, 'a failed write signals rollback to the block loop');
        assert.ok(db.endTransaction.notCalled, 'no open block transaction to end');
        assert.ok(conn.release.calledOnce, 'the leased connection is released');
    });
});

// : the create SOURCE is stored alongside the operating address so a
// cancel/edit/refill from EITHER address resolves to the dispenser, matching the
// indexer's ownership gate (SOURCE == dispenser SOURCE or GET_ADDRESS).
describe('dispenser create-SOURCE keying ', () => {
    afterEach(() => sinon.restore());

    it('insertDispenser stores the create SOURCE when the dispenser is delegated', async () => {
        const db = makeDb();
        // Operating address (GET_ADDRESS) interns as 7, the creating SOURCE as 9.
        sinon.stub(db, 'createAddress')
            .withArgs('bcrt1qdelegated').resolves(7)
            .withArgs('bcrt1qcreator').resolves(9);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        await db.insertDispenser({
            txIndex: 42,
            address: 'bcrt1qdelegated',
            sourceAddress: 'bcrt1qcreator',
            expiration: 1234,
        });

        const [sql, params] = conn.query.firstCall.args;
        assert.match(sql, /source_address_id/i, 'the create SOURCE has a column to land in');
        assert.strictEqual(params[1], 7, 'address_id stays the operating address');
        assert.strictEqual(params[4], 9, 'source_address_id records the delegating creator');
    });

    it('insertDispenser leaves source_address_id NULL for a self-opened dispenser', async () => {
        const db = makeDb();
        const createAddress = sinon.stub(db, 'createAddress').resolves(7);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        // GET_ADDRESS omitted, so the decoder passes SOURCE as both fields. Storing a
        // duplicate id would buy nothing (address_id already matches), so the row is
        // written exactly as it was before .
        await db.insertDispenser({
            txIndex: 42,
            address: 'bcrt1qself',
            sourceAddress: 'bcrt1qself',
            expiration: 1234,
        });

        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[4], null, 'no redundant source id when it equals address_id');
        assert.strictEqual(createAddress.callCount, 1, 'and no redundant address interning');
    });

    it('the oracle-address lookup resolves on the create SOURCE too', async () => {
        // A v2 refill of a DELEGATED Mode B dispenser is paid by its creator, whose
        // SOURCE is not the operating address. Before  that lookup found nothing,
        // no oracle-fee output was captured, and the indexer rejected the refill.
        const db = makeDb();
        const q = sinon.stub().resolves([{ oracle_address: 'bcrt1qoracle' }]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const oracle = await db.getOpenDispenserOracleAddressBySource('bcrt1qcreator');

        assert.strictEqual(oracle, 'bcrt1qoracle');
        const [sql, args] = q.firstCall.args;
        assert.match(sql, /OR\s+d\.source_address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
        assert.deepStrictEqual(args, ['bcrt1qcreator', 'bcrt1qcreator', 'bcrt1qcreator']);
    });
});
