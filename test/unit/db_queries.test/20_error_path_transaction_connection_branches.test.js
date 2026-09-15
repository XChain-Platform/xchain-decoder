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

// Additional coverage: error paths when transactionConnection is active
// These cover the `if (this.transactionConnection)` branches in error handlers

describe('Database error-path transactionConnection branches', () => {
    afterEach(() => sinon.restore());

    it('createAddress: swallows INSERT error even with active transactionConnection', async () => {
        const db = makeDb();
        // Use a fake transactionConnection so getConnection returns it
        const txConn = {
            query: sinon.stub()
                .onFirstCall().resolves([])      // getAddressId → null
                .onSecondCall().rejects(new Error('insert addr fail'))  // INSERT IGNORE
                .onThirdCall().resolves([{ id: 11 }]),  // getAddressId after insert
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        // Should not throw; error in INSERT catch is logged and swallowed
        const id = await db.createAddress('newaddr2');
        // id may be 11 from re-fetch or null if re-fetch also fails; just assert no throw
        assert.ok(id === 11 || id === null);
    });

    // Regression guard: on a generic error inside an active transaction, insertEvent
    // must call endTransaction() like every sibling insert (rollback, release, free the
    // lock). A bare releaseConnection() here leaves the transaction open on the pooled
    // connection and never runs releaseTransactionLock, deadlocking the next beginTransaction().
    it('insertEvent: calls endTransaction (rollback + frees lock) when a transaction is active on generic error', async () => {
        const db = makeDb();
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('event fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertEvent('CODE', { x: 1 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

});
describe('Database error-path transactionConnection branches', () => {
    afterEach(() => sinon.restore());

    // Companion: with the REAL endTransaction (not stubbed), the transaction lock is
    // actually released so a subsequent beginTransaction would not deadlock.
    it('insertEvent: a transaction-active error frees the transaction lock (no deadlock)', async () => {
        const db = makeDb();
        const txConn = {
            query: sinon.stub().rejects(new Error('event fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertEvent('CODE', { x: 1 });
        assert.strictEqual(r, false);
        assert.ok(txConn.rollback.calledOnce, 'transaction should be rolled back');
        assert.strictEqual(db.transactionConnection, null, 'transaction connection cleared');
        assert.strictEqual(db._transactionLock, false, 'transaction lock released');
    });

    it('insertDispenser: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(3);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('dispenser fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertDispenser({ txIndex: 1, address: 'a', expiration: 0 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    it('insertTransactionOutput: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(4);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('txout fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertTransactionOutput({ txIndex: 1, vout: 0, destinationAddress: 'a', amount: 0n });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

});
describe('Database error-path transactionConnection branches', () => {
    afterEach(() => sinon.restore());

    it('deleteOpenDispensers: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('delete fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.deleteOpenDispensers(1000);
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    it('insertBlock: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('block fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertBlock({ block_hash: 'x', previous_block_hash: 'y', block_index: 1, block_time: 0 });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

    it('insertTransaction: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('tx fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });

});
describe('Database error-path transactionConnection branches', () => {
    afterEach(() => sinon.restore());

    it('insertMempoolTransaction: calls endTransaction when transactionConnection is active on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const endTxStub = sinon.stub(db, 'endTransaction').resolves();
        const txConn = {
            query: sinon.stub().rejects(new Error('mempool fail')),
            release: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
        };
        db.transactionConnection = txConn;
        db._transactionLock = true;
        const r = await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        assert.strictEqual(r, false);
        assert.ok(endTxStub.calledOnce);
    });
});

// ensureMigrationsLedger: covered cheaply via a fake connection

describe('Database#ensureMigrationsLedger()', () => {
    afterEach(() => sinon.restore());

    it('calls CREATE TABLE IF NOT EXISTS schema_migrations on the connection', async () => {
        const db = makeDb();
        const queryStub = sinon.stub().resolves([]);
        const conn = { query: queryStub, release: sinon.stub().resolves() };
        await db.ensureMigrationsLedger(conn);
        assert.ok(queryStub.calledOnce);
        assert.ok(/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(queryStub.firstCall.args[0]));
    });
});
