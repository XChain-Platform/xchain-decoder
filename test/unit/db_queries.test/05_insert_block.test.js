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

describe('Database#insertBlock()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        // createTransaction calls getTransactionId (SELECT) then maybe INSERT IGNORE
        // For simplicity, stub createTransaction on the instance
        sinon.stub(db, 'createTransaction').resolves(5);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertBlock({
            block_hash: 'abc',
            previous_block_hash: 'def',
            block_index: 1,
            block_time: 1234567890
        });
        assert.strictEqual(r, true);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        sinon.stub(db, 'createTransaction').resolves(1);
        const q = sinon.stub().rejects(new Error('insert fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.insertBlock({ block_hash: 'x', previous_block_hash: 'y', block_index: 2, block_time: 1 });
        assert.strictEqual(r, false);
    });

    it('calls createTransaction for both block_hash and previous_block_hash', async () => {
        const db = makeDb();
        const createTxStub = sinon.stub(db, 'createTransaction').resolves(9);
        const q = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        await db.insertBlock({ block_hash: 'h1', previous_block_hash: 'h2', block_index: 1, block_time: 0 });
        assert.ok(createTxStub.calledWith('h1'));
        assert.ok(createTxStub.calledWith('h2'));
    });
});
