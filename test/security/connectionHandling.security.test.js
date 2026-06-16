// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const Database = require('../../src/db')

describe('Security: Connection Handling', () => {

    // --- SEC-06: Connection pool timeout ---

    describe('getConnection timeout', () => {
        it('[REGRESSION P0] R-SEC-003: should verify GET_CONNECTION_TIMEOUT_MS constant exists in source', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                source.includes('GET_CONNECTION_TIMEOUT_MS'),
                'db.js should define GET_CONNECTION_TIMEOUT_MS constant'
            )
        })

        it('should verify getConnection has a timeout check', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                source.includes('Date.now() - startTime > GET_CONNECTION_TIMEOUT_MS'),
                'getConnection should check elapsed time against timeout'
            )
        })

        it('should verify getConnection throws after timeout', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                source.includes("throw new Error('Failed to get database connection"),
                'getConnection should throw on timeout'
            )
        })
    })

    // --- SEC-07: Transaction lock ---

    describe('Transaction lock mechanism', () => {
        it('should verify _acquireTransactionLock method exists', () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            assert.ok(typeof db._acquireTransactionLock === 'function')
        })

        it('should verify _releaseTransactionLock method exists', () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            assert.ok(typeof db._releaseTransactionLock === 'function')
        })

        it('should initialize lock state correctly', () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            assert.strictEqual(db._transactionLock, false)
            assert.ok(Array.isArray(db._transactionLockQueue))
            assert.strictEqual(db._transactionLockQueue.length, 0)
        })

        it('[REGRESSION P0] R-SEC-003: should acquire lock on first call', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            await db._acquireTransactionLock()
            assert.strictEqual(db._transactionLock, true)

            // Clean up
            db._releaseTransactionLock()
        })

        it('should queue second caller when lock is held', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            await db._acquireTransactionLock()
            assert.strictEqual(db._transactionLock, true)

            // Second call should queue
            let secondAcquired = false
            const secondPromise = db._acquireTransactionLock().then(() => {
                secondAcquired = true
            })

            // Second hasn't resolved yet
            await new Promise(resolve => setTimeout(resolve, 10))
            assert.strictEqual(secondAcquired, false)
            assert.strictEqual(db._transactionLockQueue.length, 1)

            // Release first — second should resolve
            db._releaseTransactionLock()
            await secondPromise
            assert.strictEqual(secondAcquired, true)

            // Clean up
            db._releaseTransactionLock()
        })

        it('should release lock when queue is empty', () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            db._transactionLock = true
            db._releaseTransactionLock()

            assert.strictEqual(db._transactionLock, false)
            assert.strictEqual(db._transactionLockQueue.length, 0)
        })

        it('should process queued waiters in FIFO order', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')
            const order = []

            await db._acquireTransactionLock()

            const p1 = db._acquireTransactionLock().then(() => order.push(1))
            const p2 = db._acquireTransactionLock().then(() => order.push(2))
            const p3 = db._acquireTransactionLock().then(() => order.push(3))

            await new Promise(resolve => setTimeout(resolve, 10))
            assert.strictEqual(db._transactionLockQueue.length, 3)

            db._releaseTransactionLock()
            await p1
            db._releaseTransactionLock()
            await p2
            db._releaseTransactionLock()
            await p3
            db._releaseTransactionLock()

            assert.deepStrictEqual(order, [1, 2, 3])
        })
    })

    // --- SEC-08: deleteBlockByIndex must not leak the transaction lock on failure ---
    //
    // deleteBlockByIndex runs four DELETE queries inside a transaction. If one
    // of them throws (DB timeout, deadlock, disk full) the error must not escape
    // with the lock still held — that would permanently deadlock every later
    // caller waiting on _acquireTransactionLock(), including verifyReorg's own
    // retry loop, halting all block ingestion until a manual restart.

    describe('deleteBlockByIndex failure handling', () => {
        // A fake connection whose query() fails on the Nth call, recording
        // whether the transaction was rolled back and the connection released.
        function makeFailingConnection(failOnCall = 1) {
            const state = { rolledBack: false, released: false, committed: false, calls: 0 }
            const connection = {
                beginTransaction: async () => {},
                commit: async () => { state.committed = true },
                rollback: async () => { state.rolledBack = true },
                release: async () => { state.released = true },
                query: async () => {
                    state.calls += 1
                    if (state.calls === failOnCall) {
                        throw new Error('simulated DB failure (timeout/deadlock/disk full)')
                    }
                    return []
                }
            }
            return { connection, state }
        }

        it('[REGRESSION P1] R-BUG-001: releases the transaction lock when a query fails', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')
            const { connection, state } = makeFailingConnection(1)
            db.getConnection = async () => connection

            await assert.rejects(
                () => db.deleteBlockByIndex(123),
                /simulated DB failure/,
                'deleteBlockByIndex must propagate the query error to the caller'
            )

            // The lock and connection must be released so the reorg retry path
            // (and every other transaction) can make progress afterward.
            assert.strictEqual(db._transactionLock, false, 'transaction lock must be released after a failed delete')
            assert.strictEqual(db.transactionConnection, null, 'transaction connection must be cleared after a failed delete')
            assert.strictEqual(db._transactionLockQueue.length, 0, 'no waiters should be left queued')
            assert.ok(state.rolledBack, 'a failed delete should roll back the open transaction')
            assert.ok(state.released, 'a failed delete should release the connection')
        })

        it('[REGRESSION P1] R-BUG-001: a subsequent call does not deadlock after a failure', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            // First call: every query fails.
            const failing = makeFailingConnection(1)
            db.getConnection = async () => failing.connection
            await assert.rejects(() => db.deleteBlockByIndex(123), /simulated DB failure/)

            // Second call (the verifyReorg retry): a healthy connection. This
            // must acquire the lock immediately rather than hang forever waiting
            // on a promise that the failed call never resolved.
            const healthy = makeFailingConnection(Infinity) // never fails
            db.getConnection = async () => healthy.connection

            const result = await Promise.race([
                db.deleteBlockByIndex(123),
                new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: retry hung on transaction lock')), 1000))
            ])

            assert.strictEqual(result, true, 'the retry should complete successfully')
            assert.ok(healthy.state.committed, 'the retry should commit its transaction')
            assert.strictEqual(db._transactionLock, false, 'lock should be released after a successful retry')
            assert.strictEqual(db.transactionConnection, null, 'connection should be cleared after a successful retry')
        })
    })
})
