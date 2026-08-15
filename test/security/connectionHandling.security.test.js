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

    // SEC-06 intent: getConnection must be bounded so a MariaDB outage surfaces as a
    // thrown error instead of hanging block ingestion forever. The bound was reshaped
    // from a wall-clock cap (GET_CONNECTION_TIMEOUT_MS) to an attempt cap with
    // exponential backoff + jitter (maxAttempts), matching the indexer's retry shape;
    // these assertions track the current, still-bounded implementation.
    describe('getConnection retry bound', () => {
        it('[REGRESSION P0] R-SEC-003: should cap connection retries with a maxAttempts bound', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                source.includes('maxAttempts'),
                'db.js getConnection should bound retries with a maxAttempts cap'
            )
        })

        it('should verify getConnection bails out once the attempt cap is reached', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                /attempts\s*>=\s*maxAttempts/.test(source),
                'getConnection should stop retrying once attempts reaches maxAttempts'
            )
        })

        it('should verify getConnection throws after exhausting attempts', () => {
            const fs = require('fs')
            const source = fs.readFileSync(require.resolve('../../src/db.js'), 'utf-8')

            assert.ok(
                source.includes("throw new Error('Failed to get database connection"),
                'getConnection should throw once retries are exhausted'
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

            db._releaseTransactionLock()
        })

        it('should queue second caller when lock is held', async () => {
            const db = new Database('localhost', 3306, 'test_db', 'root', '')

            await db._acquireTransactionLock()
            assert.strictEqual(db._transactionLock, true)

            let secondAcquired = false
            const secondPromise = db._acquireTransactionLock().then(() => {
                secondAcquired = true
            })

            // Poll for the waiter to enqueue rather than sleeping a fixed 10ms: the wait
            // is on an observable condition, so a loaded machine cannot under-sleep it.
            // Same shape as the FIFO test below.
            const deadline = Date.now() + 2000
            while (db._transactionLockQueue.length < 1 && Date.now() < deadline) {
                await new Promise(resolve => setImmediate(resolve))
            }
            assert.strictEqual(secondAcquired, false)
            assert.strictEqual(db._transactionLockQueue.length, 1)

            db._releaseTransactionLock()
            await secondPromise
            assert.strictEqual(secondAcquired, true)

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

            // Poll for the three waiters to enqueue rather than sleeping a fixed 10ms:
            // the wait is on an observable condition, so a loaded machine cannot under-sleep it.
            const deadline = Date.now() + 2000
            while (db._transactionLockQueue.length < 3 && Date.now() < deadline) {
                await new Promise(resolve => setImmediate(resolve))
            }
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
    // with the lock still held. A held lock permanently deadlocks every later
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
