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
})
