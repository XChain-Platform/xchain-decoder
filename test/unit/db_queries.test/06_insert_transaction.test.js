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

describe('Database#insertTransaction()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertTransaction({
            index: 0, hash: 'abc', block_index: 1, source: 'src', destination: 'dst',
            amount: 100, fee: 1, data: null, raw_data: null
        });
        assert.strictEqual(r, true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const err = new Error('dup'); err.errno = 1062;
        const q = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null }), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertTransaction({ index: 0, hash: 'x', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null }), false);
    });

    it('passes null raw_data when absent', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const q = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertTransaction({ index: 0, hash: 'h', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        const params = conn.query.firstCall.args[1];
        assert.strictEqual(params[8], null); // raw_data
    });

});
describe('Database#insertTransaction()', () => {
    afterEach(() => sinon.restore());

    // parseTransaction's opportunistic pubkey write only fires for a source
    // index_addresses already holds, and createAddress here is what allocates the row
    // for a first-ever source. Without this write that address's exposed key is lost
    // for the block that exposed it, and the indexer's source_pubkey join reads NULL.
    it('records the exposed pubkey for a source whose address id it just allocated', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').callsFake(async (a) => (a === 'src' ? 77 : 5));
        const insertPubkey = sinon.stub(db, 'insertPubkey').resolves(true);
        const { pool } = withConn(sinon.stub().resolves([]));
        injectPool(db, pool);
        await db.insertTransaction({
            index: 0, hash: 'h', block_index: 1, source: 'src', source_pubkey: '02aa',
            destination: 'dst', amount: 0, fee: 0, data: 'SEND|0|x'
        });
        assert.ok(insertPubkey.calledOnceWithExactly(77, '02aa'), 'the key must be stored against the freshly allocated source id');
    });

    it('writes no pubkey when the transaction exposed none, or the source is the empty-address sentinel', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(1); // reserved sentinel row
        const insertPubkey = sinon.stub(db, 'insertPubkey').resolves(true);
        const { pool } = withConn(sinon.stub().resolves([]));
        injectPool(db, pool);
        await db.insertTransaction({ index: 0, hash: 'h', block_index: 1, source: '', source_pubkey: '02aa', destination: 'd', amount: 0, fee: 0, data: null });
        await db.insertTransaction({ index: 1, hash: 'i', block_index: 1, source: 's', destination: 'd', amount: 0, fee: 0, data: null });
        assert.ok(insertPubkey.notCalled, 'no pubkey write for the sentinel id or an absent key');
    });

    // A pubkey hiccup must never turn a fee-paid transaction into a quarantined row.
    it('still inserts the transaction when the pubkey write reports failure', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(9);
        sinon.stub(db, 'insertPubkey').resolves(false);
        const { pool, conn } = withConn(sinon.stub().resolves([]));
        injectPool(db, pool);
        const r = await db.insertTransaction({ index: 0, hash: 'h', block_index: 1, source: 's', source_pubkey: '02aa', destination: 'd', amount: 0, fee: 0, data: null });
        assert.strictEqual(r, true);
        assert.ok(conn.query.calledOnce, 'the transaction INSERT still ran');
    });
});
