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

describe('Database#getAllOpenDispenserAddresses()', () => {
    afterEach(() => sinon.restore());

    it('returns a Set of every open-dispenser address from a single query', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([
            { address: 'addr1' },
            { address: 'addr2' },
        ]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.ok(set instanceof Set);
        assert.strictEqual(set.size, 2);
        assert.ok(set.has('addr1'));
        assert.ok(set.has('addr2'));
        // The whole point of the method: one query for the entire block, not one per output.
        assert.strictEqual(q.callCount, 1);
    });

    it('skips NULL addresses (dispenser row with no matching index_addresses join)', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([
            { address: 'addr1' },
            { address: null },
        ]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.strictEqual(set.size, 1);
        assert.ok(set.has('addr1'));
        assert.ok(!set.has(null));
    });

    it('returns an empty Set when there are no open dispensers', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.ok(set instanceof Set);
        assert.strictEqual(set.size, 0);
    });

    it('returns null on query error (a failed read must stay distinguishable from an empty set)', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('fail'));
        const { pool } = withConn(q);
        injectPool(db, pool);

        const set = await db.getAllOpenDispenserAddresses();
        assert.strictEqual(set, null);
    });
});
