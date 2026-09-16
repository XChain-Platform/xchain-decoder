// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Unit tests for Database query methods (no real DB).
// Covers: all async query methods, getConnection retry/give-up,
// releaseConnection, beginTransaction, endTransaction, commitTransaction,
// verifyDatabase, createDatabase, dropDatabase, and related helpers.
// Uses sinon to inject a fake pool (no proxyquire).

'use strict';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../../src/db.js');


function makeDb(name = 'xchain_btc_mainnet') {
    return new Database('127.0.0.1', 3306, name, 'u', 'p');
}

// Build a fake connection + pool stub that resolves with the given query stub.
function withConn(queryStub) {
    const conn = {
        query:            queryStub || sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves(),
    };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn };
}

// Inject a fake pool into db (replaces the one created by mariadbMock).
function injectPool(db, pool) {
    db.pool = pool;
}

describe('Database#insertDispenser()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertDispenser({ txIndex: 1, address: 'addr', expiration: 9999 });
        assert.strictEqual(r, true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const q = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 }), false);
    });

});
describe('Database#insertDispenser()', () => {
    afterEach(() => sinon.restore());

    it('passes txIndex, addressId, expiration as params', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(7);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertDispenser({ txIndex: 42, address: 'addr', expiration: 1234 });
        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[0], 42);
        assert.strictEqual(params[1], 7);
        assert.strictEqual(params[2], 1234);
    });

    // Y2038 regression: expiration must be stored as a raw unix integer, NOT routed
    // through FROM_UNIXTIME() (which caps at 2147483647 and NULLs anything past 2038,
    // silently dropping expirations the parser accepts up to 4294967295 / year 2106).
    it('stores expiration as a raw unix value without FROM_UNIXTIME (Y2038 safe)', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(7);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const farFuture = 4102444800; // 2100-01-01, above the Y2038 FROM_UNIXTIME cap
        await db.insertDispenser({ txIndex: 1, address: 'addr', expiration: farFuture });
        const sql = conn.query.firstCall.args[0];
        assert.ok(!/FROM_UNIXTIME/i.test(sql), 'insertDispenser must not wrap expiration in FROM_UNIXTIME');
        assert.strictEqual(conn.query.firstCall.args[1][2], farFuture, 'far-future expiration must pass through unmodified');
    });
});
