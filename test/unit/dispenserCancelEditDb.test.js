// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DB-layer unit tests for the DISPENSER cancel/edit mirror .
// These pin the real db.js UPDATE that closes / re-dates an open dispenser
// row: the SQL shape, the bound args order, the single-row target selection,
// and the same false/true rollback-signalling contract insertDispenser uses.
// No real DB: a fake pool is injected, exactly like db.queries.test.js.

'use strict';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../src/db.js');

function makeDb(name = 'xchain_btc_regtest') {
    return new Database('127.0.0.1', 3306, name, 'u', 'p');
}

function withConn(queryStub) {
    const conn = {
        query:   queryStub || sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
    };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn };
}

function injectPool(db, pool) {
    db.pool = pool;
}

describe('Database#cancelOpenDispenserBySource() ', () => {
    afterEach(() => sinon.restore());

    it('issues a single-row soft-close UPDATE keyed on address, args [expiration, address]', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);

        const ok = await db.cancelOpenDispenserBySource('bcrt1qsource', 1700003600);

        assert.strictEqual(ok, true);
        assert.ok(q.calledOnce, 'exactly one query is issued');
        const [sql, args] = q.firstCall.args;
        // Target: the open dispenser row(s) at this address, most-recent first, one row.
        assert.match(sql, /UPDATE\s+dispensers/i);
        assert.match(sql, /SET\s+expiration\s*=\s*\?/i);
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i);
        assert.match(sql, /ORDER\s+BY\s+tx_index\s+DESC/i);
        assert.match(sql, /LIMIT\s+1/i);
        // Args order mirrors the query: SET expiration = ? ... WHERE address = ?
        assert.deepStrictEqual(args, [1700003600, 'bcrt1qsource']);
    });

    it('returns false on a query error and does not end a non-existent transaction', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        // Not inside a block transaction, so the error path must not try to end one.
        db.endTransaction = sinon.stub().resolves();

        const ok = await db.cancelOpenDispenserBySource('bcrt1qsource', 1700003600);

        assert.strictEqual(ok, false, 'a failed write signals rollback to the block loop');
        assert.ok(db.endTransaction.notCalled, 'no open block transaction to end');
        assert.ok(conn.release.calledOnce, 'the leased connection is released');
    });
});

describe('Database#editOpenDispenserExpirationBySource() ', () => {
    afterEach(() => sinon.restore());

    it('issues a single-row expiration UPDATE keyed on address, args [expiration, address]', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool } = withConn(q);
        injectPool(db, pool);

        const ok = await db.editOpenDispenserExpirationBySource('bcrt1qsource', 1700050000);

        assert.strictEqual(ok, true);
        assert.ok(q.calledOnce);
        const [sql, args] = q.firstCall.args;
        assert.match(sql, /UPDATE\s+dispensers/i);
        assert.match(sql, /SET\s+expiration\s*=\s*\?/i);
        assert.match(sql, /expired_block_index\s+IS\s+NULL/i);
        assert.match(sql, /ORDER\s+BY\s+tx_index\s+DESC/i);
        assert.match(sql, /LIMIT\s+1/i);
        assert.deepStrictEqual(args, [1700050000, 'bcrt1qsource']);
    });

    it('returns false on a query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db down'));
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        db.endTransaction = sinon.stub().resolves();

        const ok = await db.editOpenDispenserExpirationBySource('bcrt1qsource', 1700050000);

        assert.strictEqual(ok, false);
        assert.ok(conn.release.calledOnce);
    });
});
