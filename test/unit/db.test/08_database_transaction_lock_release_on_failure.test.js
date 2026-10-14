// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert   = require('assert')
const sinon    = require('sinon')
const Database = require('../../../src/db.js')

function makeDb() {
    return new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass')
}

function fakeConn(overrides = {}) {
    return Object.assign({
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves(),
    }, overrides)
}

// Resolve true when the lock can be acquired again before a short deadline, false when it is wedged.
async function lockIsFree(db) {
    const acquired = db.acquireTransactionLock().then(() => true)
    const timedOut = new Promise(resolve => setTimeout(() => resolve(false), 50))
    return Promise.race([acquired, timedOut])
}

// A begin/end failure must hand the transaction lock back, or the next caller waits forever.
describe('Database transaction lock release on failure', () => {
    afterEach(() => sinon.restore())

    it('releases the lock when getConnection gives up during beginTransaction', async () => {
        const db = makeDb()
        sinon.stub(db, 'getConnection').rejects(new Error('Failed to get database connection after 30 attempts: ECONNREFUSED'))
        await assert.rejects(db.beginTransaction(), /Failed to get database connection/)
        assert.strictEqual(db.transactionConnection, null)
        assert.strictEqual(await lockIsFree(db), true)
    })

    it('lets a retried beginTransaction proceed after a failed one', async () => {
        const db = makeDb()
        const conn = fakeConn()
        const getConnection = sinon.stub(db, 'getConnection')
        getConnection.onFirstCall().rejects(new Error('db down'))
        getConnection.onSecondCall().resolves(conn)
        await assert.rejects(db.beginTransaction(), /db down/)
        await db.beginTransaction()
        assert.strictEqual(db.transactionConnection, conn)
        assert.ok(conn.beginTransaction.calledOnce)
    })

    it('releases the lock and the connection when conn.beginTransaction throws', async () => {
        const db = makeDb()
        const conn = fakeConn({ beginTransaction: sinon.stub().rejects(new Error('begin failed')) })
        sinon.stub(db, 'getConnection').resolves(conn)
        await assert.rejects(db.beginTransaction(), /begin failed/)
        assert.ok(conn.release.calledOnce)
        assert.strictEqual(db.transactionConnection, null)
        assert.strictEqual(await lockIsFree(db), true)
    })

    it('keeps the lock while discarding a stale connection, so a queued caller stays queued', async () => {
        const db = makeDb()
        const stale = fakeConn()
        const fresh = fakeConn()
        db.transactionConnection = stale
        sinon.stub(db, 'getConnection').callsFake(async () => db.transactionConnection || fresh)
        await db.beginTransaction()
        assert.ok(stale.rollback.calledOnce)
        assert.ok(stale.release.calledOnce)
        assert.strictEqual(db.transactionConnection, fresh)
        // The lock is still ours: a second acquirer must wait rather than be woken.
        assert.strictEqual(await lockIsFree(db), false)
    })
})

describe('Database transaction lock release on failure', () => {
    afterEach(() => sinon.restore())

    it('releases the lock and the connection when rollback throws in endTransaction', async () => {
        const db = makeDb()
        await db.acquireTransactionLock()
        const conn = fakeConn({ rollback: sinon.stub().rejects(new Error('connection lost')) })
        db.transactionConnection = conn
        await assert.rejects(db.endTransaction(), /connection lost/)
        assert.ok(conn.release.calledOnce)
        assert.strictEqual(db.transactionConnection, null)
        assert.strictEqual(await lockIsFree(db), true)
    })

    it('returns false and frees the lock when commit and the rollback after it both fail', async () => {
        const db = makeDb()
        await db.acquireTransactionLock()
        const conn = fakeConn({
            commit:   sinon.stub().rejects(Object.assign(new Error('commit failed'), { code: 'ER_X' })),
            rollback: sinon.stub().rejects(new Error('connection lost')),
        })
        db.transactionConnection = conn
        assert.strictEqual(await db.commitTransaction(), false)
        assert.strictEqual(db.transactionConnection, null)
        assert.strictEqual(await lockIsFree(db), true)
    })
})
