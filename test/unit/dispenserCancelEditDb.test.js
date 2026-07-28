// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DB-layer unit tests for the DISPENSER cancel/edit mirror .
// These pin the real db.js UPDATE that closes / re-dates an open dispenser
// row: the SQL shape, the bound args order, the single-row target selection,
// and the same false/true rollback-signalling contract insertDispenser uses.
// No real DB: a fake pool is injected, exactly like db.queries.test.js.

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

describe('Database#cancelOpenDispenserBySource() ', () => {
    afterEach(() => sinon.restore());

    it('issues a single-row soft-close UPDATE keyed on address, args [expiration, address]', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        const ok = await db.cancelOpenDispenserBySource('bcrt1qsource', 1700003600);

        assert.strictEqual(ok, true);
        assert.ok(q.calledOnce, 'exactly one query is issued');
        const [sql, args] = q.firstCall.args;
        // Target: the open dispenser row(s) this address may act on, one row.
        assert.match(sql, /UPDATE\s+dispensers/i);
        assert.match(sql, /SET\s+expiration\s*=\s*\?/i);
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i);
        assert.match(sql, /ORDER\s+BY\s+.*tx_index\s+DESC/i);
        assert.match(sql, /LIMIT\s+1/i);
        // : the indexer authorises a cancel from the dispenser SOURCE *or* its
        // GET_ADDRESS, so the decoder matches its operating-address key AND the stored
        // create SOURCE, with operating-address matches ranked first.
        assert.match(sql, /address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
        assert.match(sql, /OR\s+source_address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
        assert.match(sql, /ORDER\s+BY\s+\(address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses[^)]*\)\s*\)\s*DESC/i);
        // Args order mirrors the query: SET expiration = ?, then the address bound once
        // per subquery (operating-address match, source match, preference ranking).
        assert.deepStrictEqual(args, [1700003600, 'bcrt1qsource', 'bcrt1qsource', 'bcrt1qsource']);
    });

    it('returns false on a query error and does not end a non-existent transaction', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        // Not inside a block transaction, so the error path must not try to end one.
        db.endTransaction = sinon.stub().resolves();

        const ok = await db.cancelOpenDispenserBySource('bcrt1qsource', 1700003600);

        assert.strictEqual(ok, false, 'a failed write signals rollback to the block loop');
        assert.ok(db.endTransaction.notCalled, 'no open block transaction to end');
        assert.ok(conn.release.calledOnce, 'the leased connection is released');
    });
});

describe('Database#editOpenDispenserExpirationBySource() ', () => {
    afterEach(() => sinon.restore());

    it('issues a single-row expiration UPDATE keyed on address, args [expiration, address]', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const ok = await db.editOpenDispenserExpirationBySource('bcrt1qsource', 1700050000);

        assert.strictEqual(ok, true);
        assert.ok(q.calledOnce);
        const [sql, args] = q.firstCall.args;
        assert.match(sql, /UPDATE\s+dispensers/i);
        assert.match(sql, /SET\s+expiration\s*=\s*\?/i);
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i);
        assert.match(sql, /ORDER\s+BY\s+.*tx_index\s+DESC/i);
        assert.match(sql, /LIMIT\s+1/i);
        // Same two-key (operating address OR create SOURCE) resolution as cancel, .
        assert.match(sql, /OR\s+source_address_id\s*=\s*\(SELECT\s+id\s+FROM\s+index_addresses/i);
        assert.deepStrictEqual(args, [1700050000, 'bcrt1qsource', 'bcrt1qsource', 'bcrt1qsource']);
    });

    it('returns false on a query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        db.endTransaction = sinon.stub().resolves();

        const ok = await db.editOpenDispenserExpirationBySource('bcrt1qsource', 1700050000);

        assert.strictEqual(ok, false);
        assert.ok(conn.release.calledOnce);
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
