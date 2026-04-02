const assert = require('assert')

const SMOKE_DB = process.env.SMOKE_DB

// These tests require a real MariaDB instance.
// Run with: SMOKE_DB=1 npm run test:smoke
const describeOrSkip = SMOKE_DB ? describe : describe.skip

describeOrSkip('Smoke: Database Initialization', () => {
    // Use real mariadb — bypass the unit test mock by loading directly
    let mariadb
    let Database
    let db
    const DB_HOST = process.env.DECODER_DB_HOST || '127.0.0.1'
    const DB_PORT = process.env.DECODER_DB_PORT || 3306
    const DB_NAME = 'xchain_decoder_smoke'
    const DB_USER = process.env.DECODER_DB_USER || 'root'
    const DB_PASS = process.env.DECODER_DB_PASS || ''

    before(async function () {
        this.timeout(10000)

        // Load real mariadb (not the mock)
        // The unit setup.js redirects 'mariadb' requires to the mock.
        // For this test, we load the real module by its resolved path.
        const realMariadbPath = require.resolve('mariadb')
        delete require.cache[realMariadbPath]
        mariadb = require(realMariadbPath)

        // We need to load Database fresh so it picks up real mariadb
        // But since unit/setup.js may have intercepted the require,
        // we construct the DB object manually with real mariadb
        Database = require('../../src/db')
        db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS)

        // Drop the smoke test database if it exists
        let conn
        try {
            conn = await mariadb.createConnection({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASS
            })
            await conn.query(`DROP DATABASE IF EXISTS ${DB_NAME}`)
        } finally {
            if (conn) await conn.end()
        }
    })

    after(async function () {
        this.timeout(10000)
        // Clean up: drop the smoke database
        let conn
        try {
            conn = await mariadb.createConnection({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASS
            })
            await conn.query(`DROP DATABASE IF EXISTS ${DB_NAME}`)
        } catch (e) {
            // Best-effort cleanup
        } finally {
            if (conn) await conn.end()
        }
        // Close the pool
        if (db && db.pool) {
            try { await db.pool.end() } catch (e) { /* ignore */ }
        }
    })

    it('should create the database', async function () {
        this.timeout(5000)
        const result = await db.createDatabase()
        assert.strictEqual(result, true)
    })

    it('should verify the database exists', async function () {
        this.timeout(5000)
        const result = await db.verifyDatabase()
        assert.strictEqual(result, true)
    })

    it('should create and verify all tables', async function () {
        this.timeout(5000)
        const result = await db.verifyTables()
        assert.strictEqual(result, true)
    })

    it('should have all 8 expected tables', async function () {
        this.timeout(5000)
        const expectedTables = [
            'blocks', 'transactions', 'mempool_transactions', 'dispensers',
            'transaction_outputs', 'index_addresses', 'index_transactions', 'events'
        ]

        const conn = await mariadb.createConnection({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASS,
            database: DB_NAME
        })

        try {
            const rows = await conn.query(
                'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
                [DB_NAME]
            )
            const tableNames = rows.map(r => r.TABLE_NAME || r.table_name)

            for (const expected of expectedTables) {
                assert.ok(
                    tableNames.includes(expected),
                    `Missing table: ${expected}. Found: ${tableNames.join(', ')}`
                )
            }
        } finally {
            await conn.end()
        }
    })

    it('should return -1 for last block index on empty database', async function () {
        this.timeout(5000)
        const lastBlock = await db.getLastBlockIndex()
        assert.strictEqual(lastBlock, -1)
    })

    it('should return -1 for last tx index on empty database', async function () {
        this.timeout(5000)
        const lastTx = await db.getLastTxIndex()
        assert.strictEqual(lastTx, -1)
    })
})
