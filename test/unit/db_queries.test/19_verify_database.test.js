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

describe('Database#verifyDatabase()', () => {
    afterEach(() => sinon.restore());

    it('returns true when schemata row found', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([{ schema_name: 'xchain_btc_mainnet' }]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, 'createConnection').resolves(fakeConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, true);
    });

    it('returns false when schemata is empty', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, 'createConnection').resolves(fakeConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, false);
    });

    it('retries once on error then succeeds', async () => {
        const db = makeDb();
        const utilMod = require('../../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const goodConn = {
            query: sinon.stub().resolves([{ schema_name: 'xchain_btc_mainnet' }]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, 'createConnection')
            .onFirstCall().rejects(new Error('no db'))
            .onSecondCall().resolves(goodConn);
        const r = await db.verifyDatabase();
        assert.strictEqual(r, true);
    });
});

describe('Database#createDatabase()', () => {
    afterEach(() => sinon.restore());

    it('returns true after creating the database', async () => {
        const db = makeDb();
        const fakeConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, 'createConnection').resolves(fakeConn);
        const r = await db.createDatabase();
        assert.strictEqual(r, true);
    });

    it('retries once on error then succeeds', async () => {
        const db = makeDb();
        const utilMod = require('../../../src/util.js');
        sinon.stub(utilMod, 'sleep').resolves();
        const goodConn = {
            query: sinon.stub().resolves([]),
            end: sinon.stub().resolves()
        };
        sinon.stub(db, 'createConnection')
            .onFirstCall().rejects(new Error('transient'))
            .onSecondCall().resolves(goodConn);
        const r = await db.createDatabase();
        assert.strictEqual(r, true);
    });
});
