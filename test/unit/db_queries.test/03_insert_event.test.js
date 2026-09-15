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

describe('Database#insertEvent()', () => {
    afterEach(() => sinon.restore());

    it('returns true on success', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('NEW_BLOCK', { height: 1 }), true);
    });

    it('returns DUPLICATED_TRANSACTION (1) on errno 1062', async () => {
        const db = makeDb();
        const err = new Error('Duplicate entry');
        err.errno = 1062;
        const q  = sinon.stub().rejects(err);
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('X', {}), db.DUPLICATED_TRANSACTION);
    });

    it('returns false on generic error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('other'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.insertEvent('X', {}), false);
    });

    it('passes code and JSON-stringified data', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        await db.insertEvent('MYCODE', { foo: 'bar' });
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[1], 'MYCODE');
        assert.strictEqual(args[2], JSON.stringify({ foo: 'bar' }));
    });

    // A BigInt field (e.g. an events.id read back from the driver) must not kill the
    // whole write the way a plain JSON.stringify(data) does.
    it('serialises a BigInt field instead of throwing', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        const ok = await db.insertEvent('MYCODE', { cleared_halt_id: 7n, huge: 12345678901234567890n });
        assert.strictEqual(ok, true);
        const stored = JSON.parse(conn.query.firstCall.args[1][2]);
        // Fits a safe integer: becomes a plain Number.
        assert.strictEqual(stored.cleared_halt_id, 7);
        assert.strictEqual(typeof stored.cleared_halt_id, 'number');
        // Too big for a safe integer: becomes a decimal string, not a truncated Number.
        assert.strictEqual(stored.huge, '12345678901234567890');
    });
});
