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

describe('Database#insertMempoolTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertMempoolTransaction({
            hash: 'abc', source: 'src', destination: 'dst', amount: 0, fee: 0, data: null
        });
        assert.strictEqual(r, true);
    });

    // Regression guard: mempool ingestion must NEVER allocate index_addresses /
    // index_transactions rows. Those lookup tables are replicated and their ids are
    // node-local non-deterministic if assigned in mempool-arrival order; ids are
    // allocated only during deterministic block-confirmation processing. Mempool rows
    // store the raw strings verbatim.
    it('does not allocate index ids and stores raw strings', async () => {
        const db = makeDb();
        const createTx = sinon.stub(db, 'createTransaction').resolves(1);
        const createAddr = sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        await db.insertMempoolTransaction({
            hash: 'rawhash', source: 'rawsrc', destination: 'rawdst', amount: 7, fee: 0, data: 'd'
        });
        assert.ok(createTx.notCalled, 'insertMempoolTransaction must not call createTransaction');
        assert.ok(createAddr.notCalled, 'insertMempoolTransaction must not call createAddress');
        const params = q.firstCall.args[1];
        assert.deepStrictEqual(params, ['rawhash', 'rawsrc', 'rawdst', 7, 0, 'd', null]);
    });

});
describe('Database#insertMempoolTransaction()', () => {
    afterEach(() => sinon.restore());

    // Parity with insertTransaction: the encoder emits a second Latin-1 push (FILE bytes,
    // gated ciphertext) that the confirmed path stores in transactions.raw_data. A pending
    // row that drops it cannot be content-correlated with its confirmed twin.
    it('binds raw_data as the 7th param, null when absent', async () => {
        const db = makeDb();
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const payload = Buffer.from([0x00, 0xff, 0x10]);
        await db.insertMempoolTransaction({
            hash: 'h', source: 's', destination: 'd', amount: 0, fee: 0, data: 'x', raw_data: payload
        });
        assert.deepStrictEqual(q.firstCall.args[1][6], payload);
        assert.match(q.firstCall.args[0], /raw_data/, 'the INSERT column list must name raw_data');

        const q2 = sinon.stub().resolves([]);
        const { pool: pool2 } = withConn(q2);
        const db2 = makeDb();
        injectPool(db2, pool2);
        await db2.insertMempoolTransaction({ hash: 'h', source: 's', destination: 'd', amount: 0, fee: 0, data: 'x' });
        assert.strictEqual(q2.firstCall.args[1][6], null);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q = sinon.stub().rejects(new Error('nope'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertMempoolTransaction({ hash: 'x', source: 's', destination: 'd', amount: 0, fee: 0, data: null }), false);
    });
});
