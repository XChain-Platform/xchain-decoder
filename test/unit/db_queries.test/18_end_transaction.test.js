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

describe('Database#endTransaction()', () => {
    afterEach(() => sinon.restore());

    it('rolls back and releases when transactionConnection is set', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const rollbackStub = sinon.stub().resolves();
        const releaseStub  = sinon.stub().resolves();
        db.transactionConnection = { rollback: rollbackStub, release: releaseStub };
        await db.endTransaction();
        assert.ok(rollbackStub.calledOnce);
        assert.ok(releaseStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('releases the transaction lock', async () => {
        const db = makeDb();
        db._transactionLock = true;
        db.transactionConnection = {
            rollback: sinon.stub().resolves(),
            release: sinon.stub().resolves()
        };
        await db.endTransaction();
        assert.strictEqual(db._transactionLock, false);
    });

    it('does nothing when transactionConnection is null', async () => {
        const db = makeDb();
        db._transactionLock = true;
        // Should not throw even with no connection
        await db.endTransaction();
        assert.strictEqual(db._transactionLock, false);
    });
});

describe('Database#commitTransaction()', () => {
    afterEach(() => sinon.restore());

    it('commits, releases, clears transactionConnection, and returns true', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const commitStub  = sinon.stub().resolves();
        const releaseStub = sinon.stub().resolves();
        db.transactionConnection = { commit: commitStub, release: releaseStub };
        const r = await db.commitTransaction();
        assert.strictEqual(r, true);
        assert.ok(commitStub.calledOnce);
        assert.ok(releaseStub.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('returns false when transactionConnection is null', async () => {
        const db = makeDb();
        assert.strictEqual(await db.commitTransaction(), false);
    });

    it('calls endTransaction and returns undefined/falsy on commit error', async () => {
        const db = makeDb();
        db._transactionLock = true;
        const commitStub  = sinon.stub().rejects(new Error('commit fail'));
        const rollbackStub = sinon.stub().resolves();
        const releaseStub  = sinon.stub().resolves();
        db.transactionConnection = { commit: commitStub, rollback: rollbackStub, release: releaseStub };
        const r = await db.commitTransaction();
        // After endTransaction, falls through to return false
        assert.strictEqual(r, false);
        assert.ok(rollbackStub.calledOnce);
    });
});
