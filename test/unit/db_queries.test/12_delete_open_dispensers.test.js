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

describe('Database#deleteOpenDispensers()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), true);
    });

    it('returns DUPLICATED_TRANSACTION on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('dup'); err.errno = 1062;
        const q  = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.deleteOpenDispensers(5, 1000), false);
    });

    // The expiry sweep must SOFT-expire (stamp the block height into
    // expired_block_index) rather than hard-DELETE, so a reorg's
    // deleteBlockByIndex can restore a dispenser an orphaned block's non-monotonic
    // timestamp expired. It must also be idempotent on replay (IS NULL guard).
    it('soft-expires (UPDATE ... SET expired_block_index, guarded IS NULL): not a DELETE', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteOpenDispensers(42, 5555);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /UPDATE\s+dispensers/i, 'must be an UPDATE');
        assert.match(sql, /SET\s+expired_block_index\s*=\s*\?/i, 'must stamp the expiring block height');
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i, 'must guard already-expired rows (idempotent replay)');
        assert.ok(!/DELETE\s+FROM/i.test(sql), 'must NOT hard-delete');
        // params: [blockIndex, minExpiration]
        assert.deepStrictEqual(conn.query.firstCall.args[1], [42, 5555]);
    });

    // Y2038 regression: compare the raw unix block time directly against the raw
    // unix expiration column, NOT through FROM_UNIXTIME() (which caps at 2038).
    it('compares expiration against the raw unix value without FROM_UNIXTIME (Y2038 safe)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.deleteOpenDispensers(7, 4102444800); // 2100-01-01, above the Y2038 cap
        const sql = conn.query.firstCall.args[0];
        assert.ok(!/FROM_UNIXTIME/i.test(sql), 'deleteOpenDispensers must not wrap the comparison in FROM_UNIXTIME');
        assert.match(sql, /expiration\s*<\s*\?/i, 'must compare expiration against the raw bound');
    });
});
