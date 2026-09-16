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
const Database = require('../../../src/db.js')

function makeDb(name = 'test_db') {
    return new Database('127.0.0.1', 3306, name, 'user', 'pass')
}

// Transaction lock mechanics (acquireTransactionLock / releaseTransactionLock)

// ============================================================================
// Transaction lock mechanics (_acquireTransactionLock / _releaseTransactionLock)
// ============================================================================
describe('Database transaction lock queue', () => {
    let db

    beforeEach(() => {
        db = makeDb()
    })

    it('should acquire lock immediately when not held', async () => {
        assert.strictEqual(db._transactionLock, false)
        await db.acquireTransactionLock()
        assert.strictEqual(db._transactionLock, true)
    })

    it('should release lock and set flag to false when queue is empty', async () => {
        await db.acquireTransactionLock()
        db.releaseTransactionLock()
        assert.strictEqual(db._transactionLock, false)
    })

    it('should queue a second caller and resume it on release', async () => {
        // Acquire first
        await db.acquireTransactionLock()
        assert.strictEqual(db._transactionLock, true)

        // Start a second acquire (it will block until released)
        let secondAcquired = false
        const secondPromise = db.acquireTransactionLock().then(() => {
            secondAcquired = true
        })

        // Not yet (still held by first)
        assert.strictEqual(secondAcquired, false)

        // Release first; second should now resolve
        db.releaseTransactionLock()

        await secondPromise
        assert.strictEqual(secondAcquired, true)
        // Lock is still held by the second caller
        assert.strictEqual(db._transactionLock, true)

        // Release the second one
        db.releaseTransactionLock()
        assert.strictEqual(db._transactionLock, false)
    })
})
