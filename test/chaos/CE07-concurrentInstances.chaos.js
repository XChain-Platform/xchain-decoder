/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CE-07: Concurrent Decoder Instances
 *
 * Tests behavior when multiple decoder instances attempt to write
 * to the same database. Validates duplicate key handling and
 * documents the lack of cross-instance locking.
 */
const assert = require('assert')
const sinon = require('sinon')
const Database = require('../../src/db.js')

describe('CE-07: Concurrent Instance Behavior', function () {
    it('insertTransaction should handle duplicate key error (errno 1062)', async function () {
        const db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        const mockConn = {
            query: sinon.stub().callsFake(async () => {
                const err = new Error('Duplicate entry')
                err.errno = 1062
                throw err
            }),
            release: sinon.stub().resolves()
        }

        db.pool = { getConnection: sinon.stub().resolves(mockConn) }

        // createTransaction and createAddress need to work
        sinon.stub(db, 'createTransaction').resolves(1)
        sinon.stub(db, 'createAddress').resolves(1)

        const result = await db.insertTransaction({
            index: 1, hash: 'abc', block_index: 1,
            source: 'addr1', destination: null, amount: 0, fee: 0, data: 'TEST'
        })

        // Should return DUPLICATED_TRANSACTION, not false or throw
        assert.ok(result !== false, 'Should not return false for duplicate key')
        assert.ok(!db.transactionConnection, 'Should not have rolled back transaction')
    })

    it('insertMempoolTransaction should handle duplicate key error', async function () {
        const db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        const mockConn = {
            query: sinon.stub().callsFake(async () => {
                const err = new Error('Duplicate entry')
                err.errno = 1062
                throw err
            }),
            release: sinon.stub().resolves()
        }

        db.pool = { getConnection: sinon.stub().resolves(mockConn) }
        sinon.stub(db, 'createTransaction').resolves(1)
        sinon.stub(db, 'createAddress').resolves(1)

        const result = await db.insertMempoolTransaction({
            hash: 'abc', source: 'addr1', destination: null,
            amount: 0, fee: 0, data: '0xdeadbeef'
        })

        assert.ok(result !== false, 'Should handle duplicate gracefully')
    })

    it('insertBlock should rollback on non-duplicate errors', async function () {
        const db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        const mockConn = {
            query: sinon.stub().callsFake(async () => {
                const err = new Error('Table full')
                err.errno = 1114
                throw err
            }),
            release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            commit: sinon.stub().resolves()
        }

        db.pool = { getConnection: sinon.stub().resolves(mockConn) }
        sinon.stub(db, 'createTransaction').resolves(1)

        // Set up transaction state
        db.transactionConnection = mockConn

        const result = await db.insertBlock({
            block_index: 1, block_hash: 'abc',
            block_time: 1234567890, previous_block_hash: 'def'
        })

        assert.strictEqual(result, false, 'Should return false on non-duplicate error')
    })

    it('insertDispenser should handle duplicate key error', async function () {
        const db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        const mockConn = {
            query: sinon.stub().callsFake(async () => {
                const err = new Error('Duplicate entry')
                err.errno = 1062
                throw err
            }),
            release: sinon.stub().resolves()
        }

        db.pool = { getConnection: sinon.stub().resolves(mockConn) }
        sinon.stub(db, 'createAddress').resolves(1)

        const result = await db.insertDispenser({
            txIndex: 1, address: 'addr1', expiration: 9999999999
        })

        assert.ok(result !== false, 'Should handle duplicate dispenser gracefully')
    })

    it('two database instances should have independent transaction locks', async function () {
        const db1 = new Database('localhost', 3306, 'test_chaos_db', 'root', '')
        const db2 = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        // Lock db1
        db1._transactionLock = true

        // db2 should be independently unlocked
        assert.strictEqual(db2._transactionLock, false,
            'Transaction lock should not be shared across instances — no cross-instance locking exists')

        db1._transactionLock = false
    })

    it('deleteBlockByIndex should use its own transaction scope', async function () {
        const db = new Database('localhost', 3306, 'test_chaos_db', 'root', '')

        const mockConn = {
            query: sinon.stub().resolves([]),
            release: sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves()
        }

        db.pool = { getConnection: sinon.stub().resolves(mockConn) }

        await db.deleteBlockByIndex(5)

        // deleteBlockByIndex calls beginTransaction -> queries -> commitTransaction
        assert.ok(mockConn.beginTransaction.called, 'Should begin transaction')
        assert.ok(mockConn.query.calledTwice, 'Should run DELETE for transactions and blocks')
        assert.ok(mockConn.commit.called, 'Should commit transaction')
    })
})
