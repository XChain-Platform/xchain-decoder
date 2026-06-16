// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression coverage for the pooled-connection release accounting in the
// transactional insert helpers of Database.
//
// Inside an open block transaction, getConnection() returns the shared
// this.transactionConnection, so the local `connection` in each insert helper
// IS the transaction connection. On a DB error the catch block calls
// endTransaction(), which release()s that socket and nulls
// this.transactionConnection. The finally block must NOT release it a second
// time. The helpers snapshot lease ownership (ownLease) at entry and key the
// finally-release off that snapshot rather than the post-mutation field, so a
// single physical socket is returned to the pool exactly once on every path.
//
// Tests use the mariadbMock (loaded via setup.js) plus a per-test tracked
// connection that counts release() calls — no real DB needed.

const assert = require('assert')
const Database = require('../../src/db.js')

function makeDb(name = 'test_db') {
    return new Database('127.0.0.1', 3306, name, 'user', 'pass')
}

// A leased connection whose release() calls are counted. query() throws an
// error (errno 1452 — a non-duplicate failure, so it takes the real error
// branch rather than the 1062 short-circuit) whenever the SQL matches `throwOn`.
function makeTrackedConn(throwOn = null) {
    return {
        releaseCount: 0,
        rollbackCount: 0,
        queryLog: [],
        async beginTransaction() {},
        async commit() {},
        async rollback() { this.rollbackCount++ },
        async release() { this.releaseCount++ },
        async query(sql) {
            this.queryLog.push(sql)
            if (throwOn && throwOn.test(sql)) {
                const e = new Error('simulated insert failure')
                e.errno = 1452
                throw e
            }
            return []
        }
    }
}

describe('Database connection release accounting (transactional inserts)', () => {
    it('[REGRESSION P1] R-BUG-002: insertBlock error inside a transaction releases the pooled connection exactly once', async () => {
        const db = makeDb()
        const conn = makeTrackedConn(/INSERT INTO blocks/i)
        db.pool.getConnection = async () => conn

        await db.beginTransaction()
        assert.strictEqual(db.transactionConnection, conn, 'transaction borrowed the tracked connection')

        // Empty hashes make createTransaction() short-circuit, so the only
        // release accounting under test is insertBlock's own.
        const result = await db.insertBlock({
            block_index: 1, block_hash: '', block_time: 1, previous_block_hash: ''
        })

        assert.strictEqual(result, false, 'insert reports failure')
        assert.strictEqual(conn.rollbackCount, 1, 'endTransaction rolled back once')
        assert.strictEqual(conn.releaseCount, 1,
            'connection released exactly once (endTransaction) — NOT a second time in finally')
        assert.strictEqual(db.transactionConnection, null, 'transaction connection cleared')
    })

    it('[REGRESSION P1] R-BUG-002: insertTransaction error inside a transaction releases the pooled connection exactly once', async () => {
        const db = makeDb()
        const conn = makeTrackedConn(/INSERT INTO transactions/i)
        db.pool.getConnection = async () => conn

        await db.beginTransaction()

        const result = await db.insertTransaction({
            index: 1, hash: '', block_index: 1, source: '', destination: '',
            amount: '0', fee: '0', data: null, raw_data: null
        })

        assert.strictEqual(result, false)
        assert.strictEqual(conn.releaseCount, 1,
            'connection released exactly once on the transactional error path')
        assert.strictEqual(db.transactionConnection, null)
    })

    it('[REGRESSION P1] R-BUG-002: insertBlock outside a transaction releases its own lease exactly once on success', async () => {
        const db = makeDb()
        const conn = makeTrackedConn() // never throws
        db.pool.getConnection = async () => conn

        const result = await db.insertBlock({
            block_index: 2, block_hash: '', block_time: 1, previous_block_hash: ''
        })

        assert.strictEqual(result, true)
        assert.strictEqual(conn.releaseCount, 1, 'non-transaction success path releases once')
        assert.strictEqual(db.transactionConnection, null)
    })

    it('[REGRESSION P1] R-BUG-002: insertBlock outside a transaction releases its own lease exactly once on error', async () => {
        const db = makeDb()
        const conn = makeTrackedConn(/INSERT INTO blocks/i)
        db.pool.getConnection = async () => conn

        const result = await db.insertBlock({
            block_index: 3, block_hash: '', block_time: 1, previous_block_hash: ''
        })

        assert.strictEqual(result, false)
        assert.strictEqual(conn.releaseCount, 1, 'non-transaction error path releases once (no endTransaction)')
    })
})
