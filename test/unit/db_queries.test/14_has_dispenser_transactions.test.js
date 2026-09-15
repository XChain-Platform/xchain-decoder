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

// hasDispenserTransactions backs clear-reorg-halt's only guard against a database
// whose money-bearing dispenser rows were already hard-purged. A dispenser opened
// inside a BATCH is stored as `BATCH|0|DISPENSER|0|...`, so a top-level-only prefix
// probe answers "clean" on a database that held dispenser state.
describe('Database#hasDispenserTransactions()', () => {
    afterEach(() => sinon.restore());

    it('probes BOTH the top-level and the batch-carried shape', async () => {
        const db = makeDb();
        const q  = sinon.stub().resolves([]);
        const { pool, conn } = withConn(q);
        injectPool(db, pool);
        assert.strictEqual(await db.hasDispenserTransactions(), false);
        const sql = String(conn.query.firstCall.args[0]);
        assert.match(sql, /LIKE\s+'DISPENSER\|%'/i, 'must still match a top-level DISPENSER');
        assert.match(sql, /LIKE\s+'%\|DISPENSER\|%'/i, 'must also match a BATCH-carried DISPENSER');
        assert.match(sql, /LIMIT 1/i);
    });

    // The fake applies LIKE semantics to sample rows, so the predicate is EXECUTED
    // rather than asserted: a top-level-only probe leaves the BATCH row unmatched and
    // this case goes red.
    function likeConn(rows) {
        return sinon.stub().callsFake(async (sql) => {
            const patterns = [...String(sql).matchAll(/LIKE\s+'([^']*)'/gi)].map(m => m[1]);
            const toRe = (p) => new RegExp('^' + p.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
            return rows.filter(r => patterns.some(p => toRe(p).test(r))).slice(0, 1).map(() => ({ 1: 1 }));
        });
    }

    it('sees a dispenser opened inside a BATCH', async () => {
        const db = makeDb();
        const { pool } = withConn(likeConn(['SEND|0|a', 'BATCH|0|DISPENSER|0|xyz']));
        injectPool(db, pool);
        assert.strictEqual(await db.hasDispenserTransactions(), true);
    });

    it('sees a top-level dispenser', async () => {
        const db = makeDb();
        const { pool } = withConn(likeConn(['DISPENSER|0|xyz']));
        injectPool(db, pool);
        assert.strictEqual(await db.hasDispenserTransactions(), true);
    });

    it('stays false on a database that never decoded a DISPENSER', async () => {
        const db = makeDb();
        const { pool } = withConn(likeConn(['SEND|0|a', 'BATCH|0|SEND|0|b', 'ISSUANCE|0|c']));
        injectPool(db, pool);
        assert.strictEqual(await db.hasDispenserTransactions(), false);
    });
});
