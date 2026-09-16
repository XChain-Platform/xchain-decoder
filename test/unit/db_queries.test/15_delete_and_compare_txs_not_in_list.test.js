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

// deleteAndCompareTxsNotInList diffs the stored mempool against the node's
// current mempool entirely in SQL via a session temp table, instead of
// streaming every mempool_transactions row into Node. This
// fake connection models that flow: it holds a set of currently-stored tx
// hashes and a temp-table snapshot seeded by the INSERTs, and answers the
// anti-join DELETE and the intersection SELECT accordingly.
function makeMempoolConn(storedHashes) {
    const stored   = new Set(storedHashes);
    const snapshot = new Set();
    const seenSql  = [];

    async function query(sql, params) {
        seenSql.push(sql);
        if (/CREATE\s+TEMPORARY\s+TABLE/i.test(sql)) return {};
        if (/DROP\s+TEMPORARY\s+TABLE/i.test(sql))   return {};
        // Clear the snapshot temp table (distinct from the anti-join DELETE,
        // which targets mempool_transactions).
        if (/^\s*DELETE\s+FROM\s+_mempool_node_snapshot/i.test(sql)) {
            snapshot.clear();
            return { affectedRows: 0 };
        }
        if (/INSERT\s+IGNORE\s+INTO\s+_mempool_node_snapshot/i.test(sql)) {
            for (const h of (params || [])) snapshot.add(h);
            return { affectedRows: (params || []).length };
        }
        // Anti-join delete: stored rows absent from the node snapshot.
        if (/DELETE\s+m\s+FROM\s+mempool_transactions/i.test(sql)) {
            let deleted = 0;
            for (const h of Array.from(stored)) {
                if (!snapshot.has(h)) { stored.delete(h); deleted++; }
            }
            return { affectedRows: deleted };
        }
        // Intersection select: snapshot txids that are already stored.
        if (/SELECT\s+s\.tx_hash\s+AS\s+hash\s+FROM\s+_mempool_node_snapshot/i.test(sql)) {
            return Array.from(snapshot).filter((h) => stored.has(h)).map((h) => ({ hash: h }));
        }
        return [];
    }

    const conn = { query: sinon.spy(query), release: sinon.stub().resolves() };
    const pool = { getConnection: sinon.stub().resolves(conn) };
    return { pool, conn, stored, snapshot, seenSql };
}

describe('Database#deleteAndCompareTxsNotInList()', () => {
    afterEach(() => sinon.restore());

    it('deletes every stored row when the node mempool is empty', async () => {
        const db = makeDb();
        const { pool } = makeMempoolConn(['aaaa', 'bbbb']);
        injectPool(db, pool);
        // Empty node mempool → both stored rows are stale and removed.
        const r = await db.deleteAndCompareTxsNotInList([]);
        assert.strictEqual(r.transactionsDeleted, 2);
    });

    it('removes stored rows not in txidList and returns the delete count', async () => {
        const db = makeDb();
        // Stored: aaaa, bbbb. Node mempool: only aaaa → bbbb is stale.
        const { pool } = makeMempoolConn(['aaaa', 'bbbb']);
        injectPool(db, pool);
        const r = await db.deleteAndCompareTxsNotInList(['aaaa']);
        assert.strictEqual(r.transactionsDeleted, 1);
    });

    it('never issues a bare full-table scan of mempool_transactions', async () => {
        const db = makeDb();
        const { pool, conn } = makeMempoolConn(['aaaa']);
        injectPool(db, pool);
        await db.deleteAndCompareTxsNotInList(['aaaa', 'cccc']);
        const sqls = conn.query.getCalls().map((c) => String(c.args[0]));
        // Every stored-row read goes through the temp-table JOIN instead of an
        // unqualified `SELECT tx_hash FROM mempool_transactions`, so no such
        // scan should be issued.
        assert.ok(!sqls.some((s) => /FROM\s+mempool_transactions\s*;?\s*$/i.test(s.trim())),
            'must not run an unqualified SELECT ... FROM mempool_transactions');
    });

});
describe('Database#deleteAndCompareTxsNotInList()', () => {
    afterEach(() => sinon.restore());

    it('returns transactionsDeleted=0 on query error', async () => {
        const db = makeDb();
        const q  = sinon.stub().rejects(new Error('db error'));
        const { pool } = withConn(q);
        injectPool(db, pool);
        const r = await db.deleteAndCompareTxsNotInList(['aaaa']);
        assert.deepStrictEqual(r, { transactionsDeleted: 0 });
    });

    it('removes already-stored txids from the list in place (leaving only new arrivals)', async () => {
        const db = makeDb();
        // aaaa is already stored; bbbb is a new arrival.
        const { pool } = makeMempoolConn(['aaaa']);
        injectPool(db, pool);
        const list = ['bbbb', 'aaaa'];
        await db.deleteAndCompareTxsNotInList(list);
        // Same array reference is mutated: aaaa (already stored) dropped, bbbb kept.
        assert.ok(!list.includes('aaaa'), 'already-stored txid removed');
        assert.ok(list.includes('bbbb'), 'new arrival retained');
    });

    it('drops the temp table and releases the connection even on the happy path', async () => {
        const db = makeDb();
        const { pool, conn } = makeMempoolConn(['aaaa']);
        injectPool(db, pool);
        await db.deleteAndCompareTxsNotInList(['aaaa']);
        const sqls = conn.query.getCalls().map((c) => String(c.args[0]));
        assert.ok(sqls.some((s) => /DROP\s+TEMPORARY\s+TABLE/i.test(s)), 'temp table dropped');
        assert.ok(conn.release.calledOnce, 'connection released');
    });
});
