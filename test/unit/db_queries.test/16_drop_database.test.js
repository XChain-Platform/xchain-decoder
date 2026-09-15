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

describe('Database#dropDatabase()', () => {
    afterEach(() => sinon.restore());

    it('executes all DROP TABLE queries without throwing', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.dropDatabase();
        // Should have called query at least 9 times (9 tables)
        assert.ok(conn.query.callCount >= 9);
        const sqls = conn.query.getCalls().map(c => c.args[0]);
        assert.ok(sqls.some(s => /DROP TABLE IF EXISTS blocks/i.test(s)));
        assert.ok(sqls.some(s => /DROP TABLE IF EXISTS transactions/i.test(s)));
        assert.ok(conn.release.calledOnce);
    });
});


describe('Database#getConnection()', () => {
    afterEach(() => sinon.restore());

    it('returns transactionConnection when one is set', async () => {
        const db = makeDb();
        const fakeTxConn = { query: sinon.stub(), release: sinon.stub() };
        db.transactionConnection = fakeTxConn;
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeTxConn);
    });

    it('succeeds on first pool.getConnection call', async () => {
        const db = makeDb();
        const fakeConn = { query: sinon.stub(), release: sinon.stub() };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeConn);
    });

    it('retries on transient failure and succeeds on second attempt', async () => {
        const db = makeDb();
        // Stub util.sleep to avoid actual delays
        const utilMod = require('../../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const fakeConn = { query: sinon.stub(), release: sinon.stub() };
        db.pool = {
            getConnection: sinon.stub()
                .onFirstCall().rejects(new Error('transient'))
                .onSecondCall().resolves(fakeConn)
        };
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeConn);
    });

    it('throws after maxAttempts (30) consecutive failures', async () => {
        const db = makeDb();
        const utilMod = require('../../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        db.pool = {
            getConnection: sinon.stub().rejects(new Error('always fails'))
        };
        await assert.rejects(
            () => db.getConnection(),
            /Failed to get database connection after 30 attempts/
        );
    });
});
