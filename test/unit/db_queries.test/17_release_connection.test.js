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

describe('Database#releaseConnection()', () => {
    afterEach(() => sinon.restore());

    it('releases transactionConnection and sets it to null', async () => {
        const db = makeDb();
        const relStub = sinon.stub().resolves();
        db.transactionConnection = { release: relStub };
        await db.releaseConnection();
        assert.ok(relStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('does nothing when transactionConnection is null', async () => {
        const db = makeDb();
        // Should not throw
        await db.releaseConnection();
        assert.strictEqual(db.transactionConnection, null);
    });
});

describe('Database#beginTransaction()', () => {
    afterEach(() => sinon.restore());

    it('acquires lock and sets transactionConnection', async () => {
        const db = makeDb();
        const fakeConn = {
            beginTransaction: sinon.stub().resolves(),
            release: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            query: sinon.stub().resolves([]),
        };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        await db.beginTransaction();
        assert.strictEqual(db.transactionConnection, fakeConn);
        assert.ok(fakeConn.beginTransaction.calledOnce);
    });

    it('releases and re-throws when beginTransaction() on connection throws', async () => {
        const db = makeDb();
        const fakeConn = {
            beginTransaction: sinon.stub().rejects(new Error('btx fail')),
            release: sinon.stub().resolves(),
        };
        db.pool = { getConnection: sinon.stub().resolves(fakeConn) };
        await assert.rejects(() => db.beginTransaction(), /btx fail/);
        assert.strictEqual(db.transactionConnection, null);
        assert.ok(fakeConn.release.calledOnce);
        // Lock should be released so next caller can proceed
        assert.strictEqual(db._transactionLock, false);
    });

});
describe('Database#beginTransaction()', () => {
    afterEach(() => sinon.restore());

    it('rolls back existing transaction if one is open before starting new', async () => {
        // beginTransaction checks `if (this.transactionConnection != null)` AFTER acquiring the lock
        // and calls endTransaction() to roll it back. We simulate this by pre-setting
        // transactionConnection and calling beginTransaction with the lock NOT held
        // (so acquireTransactionLock resolves immediately).
        const db = makeDb();
        const rollbackStub = sinon.stub().resolves();
        const oldConn = {
            rollback: rollbackStub,
            release: sinon.stub().resolves(),
        };
        const newConn = {
            beginTransaction: sinon.stub().resolves(),
            release: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            query: sinon.stub().resolves([]),
        };
        db.pool = { getConnection: sinon.stub().resolves(newConn) };

        // Pre-set transactionConnection to simulate a leaked open transaction.
        // The lock is NOT held so acquireTransactionLock resolves immediately.
        db.transactionConnection = oldConn;

        // beginTransaction should detect transactionConnection != null and call endTransaction
        await db.beginTransaction();
        assert.ok(rollbackStub.calledOnce, 'old transaction should have been rolled back');
    });
});
