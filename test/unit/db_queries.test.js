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
const Database = require('../../src/db.js');


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

describe('Database#getLastBlockIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns Number when rows have a BigInt max_height', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: 42n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getLastBlockIndex();
        assert.strictEqual(r, 42);
        assert.ok(typeof r === 'number');
    });

    it('returns -1 when max_height is null (empty blocks table)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: null }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastBlockIndex(), -1);
    });

    it('returns -1 when rows is empty', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastBlockIndex(), -1);
    });

});
describe('Database#getLastBlockIndex()', () => {
    afterEach(() => sinon.restore());

    it('[REGRESSION P1] throws (never returns false) after retries on persistent query error', async () => {
        // A `false` return was silently coerced to a height (false + 1 === 1),
        // colliding block 1 and wedging the parse loop. The getter must surface a
        // real number or throw. Never a non-numeric sentinel. (sleep is stubbed so
        // the bounded retry loop doesn't take real wall-clock time.)
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('boom'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        await assert.rejects(() => db.getLastBlockIndex(), /getLastBlockIndex failed after/);
        assert.ok(conn.query.callCount >= 2, 'should retry before giving up');
    });

    it('recovers and returns the height when a transient error clears on retry', async () => {
        const db = makeDb();
        const q  = sinon.stub();
        q.onFirstCall().rejects(new Error('transient'));
        q.onSecondCall().resolves([{ max_height: 9n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        assert.strictEqual(await db.getLastBlockIndex(), 9);
    });

    it('queries MAX(block_index) from blocks', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_height: 100n }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getLastBlockIndex();
        assert.ok(conn.query.calledOnce);
        assert.ok(/MAX\(block_index\)/i.test(conn.query.firstCall.args[0]));
    });
});

describe('Database#getLastTxIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns Number when rows have a BigInt max_tx_index', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: 7n }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getLastTxIndex();
        assert.strictEqual(r, 7);
        assert.ok(typeof r === 'number');
    });

    it('returns -1 when max_tx_index is null', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: null }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastTxIndex(), -1);
    });

    it('returns -1 when rows is empty', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getLastTxIndex(), -1);
    });

    it('[REGRESSION P1] throws (never returns false) after retries on persistent query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('oops'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        await assert.rejects(() => db.getLastTxIndex(), /getLastTxIndex failed after/);
        assert.ok(conn.query.callCount >= 2, 'should retry before giving up');
    });

    it('queries MAX(tx_index) from transactions', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ max_tx_index: 3n }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getLastTxIndex();
        assert.ok(/MAX\(tx_index\)/i.test(conn.query.firstCall.args[0]));
    });
});

describe('Database#getBlockByIndex()', () => {
    afterEach(() => sinon.restore());

    it('returns the first row when found', async () => {
        const block = { block_index: 5, block_hash: 'abc' };
        const db = makeDb();
        const q  = sinon.stub().resolves([block]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.getBlockByIndex(5);
        assert.deepStrictEqual(r, block);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getBlockByIndex(99), null);
    });

    it('[REGRESSION P0] throws (never returns the missing-row sentinel) after retries on persistent query error', async () => {
        // Returning null on a query error made a failed read indistinguishable
        // from "no such row", and verifyReorg's backward walk reads
        // a null row as "table exhausted". One transient DB error therefore ended the
        // rollback walk early and reported the reorg reconciled with orphan blocks
        // still stored. Same retry-then-throw contract as getLastBlockIndex.
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        await assert.rejects(() => db.getBlockByIndex(1), /getBlockByIndex\(1\) failed after/);
        assert.ok(conn.query.callCount >= 2, 'should retry before giving up');
    });

    it('recovers and returns the row when a transient error clears on retry', async () => {
        const block = { block_index: 7, block_hash: 'def' };
        const db = makeDb();
        const q  = sinon.stub();
        q.onFirstCall().rejects(new Error('transient'));
        q.onSecondCall().resolves([block]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        sinon.stub(db, 'sleep').resolves();
        assert.deepStrictEqual(await db.getBlockByIndex(7), block);
    });

    it('passes blockIndex as param', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ block_index: 10 }]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.getBlockByIndex(10);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [10]);
    });
});

describe('Database#getTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns the first row when found', async () => {
        const tx = { tx_index: 1, hash: 'deadbeef' };
        const db = makeDb();
        const q  = sinon.stub().resolves([tx]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.deepStrictEqual(await db.getTransaction('deadbeef'), tx);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransaction('notfound'), null);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransaction('x'), false);
    });
});

describe('Database#getTransactionId()', () => {
    afterEach(() => sinon.restore());

    it('returns id when row found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ id: 99 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransactionId('myhash'), 99);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getTransactionId('missing'), null);
    });

    it('returns null (swallows) on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('bang'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        // error is caught; id stays null
        assert.strictEqual(await db.getTransactionId('bad'), null);
    });
});

describe('Database#createTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns 1 for null hash (sentinel)', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createTransaction(null), 1);
    });

    it('returns 1 for empty-string hash (sentinel)', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createTransaction(''), 1);
    });

    it('returns existing id when record already exists', async () => {
        const db = makeDb();
        // getTransactionId called twice; both return 7
        const q = sinon.stub().resolves([{ id: 7 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('abc123'), 7);
    });

    it('inserts and returns id when record does not exist (first lookup null, then 5)', async () => {
        const db = makeDb();
        // First SELECT returns nothing → INSERT → second SELECT returns id 5
        const q = sinon.stub()
            .onFirstCall().resolves([])       // getTransactionId returns null
            .onSecondCall().resolves([])      // INSERT IGNORE
            .onThirdCall().resolves([{ id: 5 }]); // getTransactionId after insert
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('newhash'), 5);
    });

    it('does not throw when INSERT errors; returns id from re-fetch', async () => {
        const db = makeDb();
        // getTransactionId→null, INSERT throws, re-fetch returns 3
        const q = sinon.stub()
            .onFirstCall().resolves([])
            .onSecondCall().rejects(new Error('insert fail'))
            .onThirdCall().resolves([{ id: 3 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createTransaction('x'), 3);
    });
});

describe('Database#getAddressId()', () => {
    afterEach(() => sinon.restore());

    it('returns id when row found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ id: 42 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('1BitcoinAddr'), 42);
    });

    it('returns null when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('nobody'), null);
    });

    it('swallows query errors and returns null', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.getAddressId('x'), null);
    });
});

describe('Database#createAddress()', () => {
    afterEach(() => sinon.restore());

    it('returns 1 for null address', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createAddress(null), 1);
    });

    it('returns 1 for empty string address', async () => {
        const db = makeDb();
        assert.strictEqual(await db.createAddress(''), 1);
    });

    it('returns existing id when address already exists', async () => {
        const db = makeDb();
        const q = sinon.stub().resolves([{ id: 10 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createAddress('1BitcoinAddr'), 10);
    });

    it('inserts and returns id when address does not exist', async () => {
        const db = makeDb();
        const q = sinon.stub()
            .onFirstCall().resolves([])       // getAddressId → null
            .onSecondCall().resolves([])      // INSERT IGNORE
            .onThirdCall().resolves([{ id: 8 }]); // getAddressId after insert
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.createAddress('newaddr'), 8);
    });
});
