/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CE-03: Database Connection Pool Exhaustion
 *
 * Tests that the decoder handles database connection pool exhaustion
 * gracefully, including timeout behavior and recovery.
 */
const assert = require('assert')
const sinon = require('sinon')
const Database = require('../../src/db.js')

describe('CE-03: Database Connection Pool Exhaustion', function () {
    let db

    beforeEach(function () {
        db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')
    })

    it('getConnection should timeout after GET_CONNECTION_TIMEOUT_MS', async function () {
        // Override pool to always fail
        db.pool = {
            getConnection: sinon.stub().rejects(new Error('Too many connections'))
        }

        const startTime = Date.now()
        try {
            await db.getConnection()
            assert.fail('Should have thrown timeout error')
        } catch (err) {
            const elapsed = Date.now() - startTime
            assert.ok(err.message.includes('Failed to get database connection'), `Got: ${err.message}`)
            // Should take at least 30s (GET_CONNECTION_TIMEOUT_MS)
            assert.ok(elapsed >= 28000, `Expected >= 28s timeout, got ${elapsed}ms`)
        }
    })

    it('getConnection should return transactionConnection when available', async function () {
        const fakeConn = { query: sinon.stub(), release: sinon.stub() }
        db.transactionConnection = fakeConn

        const conn = await db.getConnection()
        assert.strictEqual(conn, fakeConn, 'Should return the transaction connection')
    })

    it('beginTransaction should release connection on beginTransaction failure', async function () {
        const mockConn = {
            query: sinon.stub().resolves([]),
            release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().rejects(new Error('Deadlock detected')),
            rollback: sinon.stub().resolves()
        }

        db.pool = {
            getConnection: sinon.stub().resolves(mockConn)
        }

        try {
            await db.beginTransaction()
            assert.fail('Should have thrown')
        } catch (err) {
            assert.strictEqual(err.message, 'Deadlock detected')
            // Verify the connection was released (fix we applied)
            assert.ok(mockConn.release.calledOnce, 'Connection should be released on beginTransaction failure')
            assert.strictEqual(db.transactionConnection, null, 'transactionConnection should be null')
            assert.strictEqual(db._transactionLock, false, 'Transaction lock should be released')
        }
    })

    it('commitTransaction should rollback and release on commit failure', async function () {
        const mockConn = {
            commit: sinon.stub().rejects(new Error('Lock wait timeout')),
            rollback: sinon.stub().resolves(),
            release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves()
        }

        db.pool = {
            getConnection: sinon.stub().resolves(mockConn)
        }

        await db.beginTransaction()
        const result = await db.commitTransaction()

        assert.strictEqual(result, false, 'Should return false on commit failure')
        assert.ok(mockConn.rollback.calledOnce, 'Should rollback on commit failure')
        assert.ok(mockConn.release.called, 'Should release connection')
        assert.strictEqual(db._transactionLock, false, 'Lock should be released')
    })

    it('endTransaction should release lock even without active connection', async function () {
        db._transactionLock = true
        db.transactionConnection = null

        await db.endTransaction()

        assert.strictEqual(db._transactionLock, false, 'Lock should be released')
    })

    it('transaction lock queue should serialize concurrent callers', async function () {
        const mockConn = {
            beginTransaction: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            release: sinon.stub().resolves()
        }
        db.pool = {
            getConnection: sinon.stub().resolves(mockConn)
        }

        const order = []

        // First caller takes the lock
        const p1 = db.beginTransaction().then(() => {
            order.push('begin1')
        })

        await p1

        // Second caller should queue
        const p2 = db.beginTransaction().then(() => {
            order.push('begin2')
        })

        // Allow first to complete
        await db.commitTransaction()
        order.push('commit1')

        await p2
        await db.commitTransaction()
        order.push('commit2')

        assert.deepStrictEqual(order, ['begin1', 'commit1', 'begin2', 'commit2'])
    })
})
