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

describe('Database#hasPubkey()', () => {
    afterEach(() => sinon.restore());

    it('returns true when a row exists', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([{ 1: 1 }]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), true);
    });

    it('returns false when no rows found', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), false);
    });

    it('returns false on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasPubkey(5), false);
    });

    it('passes addressId to the query', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.hasPubkey(99);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [99]);
    });
});
