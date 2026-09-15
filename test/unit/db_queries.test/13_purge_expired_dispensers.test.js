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

describe('Database#purgeExpiredDispensers()', () => {
    afterEach(() => sinon.restore());

    it('hard-deletes soft-expired rows at or below the safe height', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const r = await db.purgeExpiredDispensers(900);
        assert.strictEqual(r, true);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /DELETE\s+FROM\s+dispensers/i);
        assert.match(sql, /expired_block_index\s+IS\s+NOT\s+NULL/i, 'must only touch soft-expired rows');
        assert.match(sql, /expired_block_index\s*<=\s*\?/i);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [900]);
    });

    it('is a no-op before any reorg-safe depth (negative/undefined height)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.purgeExpiredDispensers(-5), true);
        assert.strictEqual(await db.purgeExpiredDispensers(undefined), true);
        assert.ok(conn.query.notCalled, 'must not issue a DELETE when nothing is reorg-safe yet');
    });
});
