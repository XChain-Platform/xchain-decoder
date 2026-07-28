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
const util = require('../../src/util')

describe('CE-03: Database Connection Pool Exhaustion', function () {
    let db

    beforeEach(function () {
        db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')
    })

    afterEach(function () {
        sinon.restore()
    })

    // getConnection is bounded by an ATTEMPT count (30) with exponential backoff
    // capped at 15s, not by a wall-clock GET_CONNECTION_TIMEOUT_MS. There is no such
    // constant any more, and the real schedule runs for minutes, so the old
    // "elapsed >= 28s under a 60s mocha timeout" assertion could never pass on any
    // code. Stub the backoff sleep and assert the schedule the code actually
    // implements: 30 attempts, exponential from 500ms, clamped at 15s, then throw.
    it('getConnection gives up after the bounded retry schedule', async function () {
        const delays = []
        sinon.stub(util, 'sleep').callsFake(async (ms) => { delays.push(ms) })

        db.pool = {
            getConnection: sinon.stub().rejects(new Error('Too many connections'))
        }

        let err = null
        try {
            await db.getConnection()
        } catch (e) {
            err = e
        }

        assert.ok(err, 'Should have thrown once the attempt budget was exhausted')
        assert.ok(err.message.includes('Failed to get database connection'), `Got: ${err.message}`)
        assert.ok(err.message.includes('30 attempts'), `Should report the attempt budget. Got: ${err.message}`)

        // 30 attempts means 29 backoff sleeps (the last failure throws instead).
        assert.strictEqual(db.pool.getConnection.callCount, 30)
        assert.strictEqual(delays.length, 29)

        // Exponential from 500ms with up to 30% jitter, clamped at 15s.
        assert.ok(delays[0] >= 500 && delays[0] <= 650, `first backoff out of range: ${delays[0]}`)
        assert.ok(delays[1] >= 1000 && delays[1] <= 1300, `second backoff out of range: ${delays[1]}`)
        for (let i = 1; i < delays.length; i++) {
            assert.ok(delays[i] >= delays[i - 1] * 0.7, 'backoff must not collapse back toward zero')
        }
        assert.ok(delays[delays.length - 1] <= 15000 * 1.3, 'backoff must stay clamped at the 15s cap')
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
