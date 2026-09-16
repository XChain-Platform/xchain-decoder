// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Unit tests for Database utility methods that are pure-logic (no real DB connection).
// These exercise: constructor validation, bigIntSatoshiToDecimalsString,
// stripSqlLineComments, parseExpectedColumns, and the transaction-lock queue.
// All tests use the mariadbMock (loaded via setup.js) so no real DB is needed.

const assert = require('assert')
const Database = require('../../src/db.js')

// Helper: build a Database instance with a valid name (mariadb is mocked via setup.js)
function makeDb(name = 'test_db') {
    return new Database('127.0.0.1', 3306, name, 'user', 'pass')
}


// ============================================================================
// Constructor validation
// ============================================================================
describe('Database constructor', () => {
    it('should construct successfully with a valid alphanumeric name', () => {
        const db = makeDb('xchain_btc_mainnet')
        assert.strictEqual(db.dbName, 'xchain_btc_mainnet')
        assert.strictEqual(db.host, '127.0.0.1')
        assert.strictEqual(db.port, 3306)
        assert.strictEqual(db.DUPLICATED_TRANSACTION, 1)
    })

    it('should construct successfully with uppercase and digits', () => {
        const db = makeDb('MyDB123')
        assert.strictEqual(db.dbName, 'MyDB123')
    })

    it('should construct with underscore in name', () => {
        const db = makeDb('xchain_decoder_db')
        assert.strictEqual(db.dbName, 'xchain_decoder_db')
    })
})

describe('Database constructor', () => {
    it('should throw for a DB name with a hyphen', () => {
        assert.throws(() => {
            new Database('127.0.0.1', 3306, 'bad-name', 'u', 'p')
        }, /Invalid database name/)
    })

    it('should throw for a DB name with a semicolon', () => {
        assert.throws(() => {
            new Database('127.0.0.1', 3306, 'db; DROP TABLE', 'u', 'p')
        }, /Invalid database name/)
    })

    it('should throw for a DB name with a space', () => {
        assert.throws(() => {
            new Database('127.0.0.1', 3306, 'bad name', 'u', 'p')
        }, /Invalid database name/)
    })

    it('should throw for an empty DB name', () => {
        assert.throws(() => {
            new Database('127.0.0.1', 3306, '', 'u', 'p')
        }, /Invalid database name/)
    })

    it('should initialize transactionConnection to null', () => {
        const db = makeDb()
        assert.strictEqual(db.transactionConnection, null)
    })

    it('should initialize _transactionLock to false', () => {
        const db = makeDb()
        assert.strictEqual(db._transactionLock, false)
    })

    it('should initialize _transactionLockQueue as an empty array', () => {
        const db = makeDb()
        assert.deepStrictEqual(db._transactionLockQueue, [])
    })
})

describe('Database constructor', () => {
    describe('DB_QUERY_TIMEOUT handling', () => {
        const ORIGINAL = process.env.DB_QUERY_TIMEOUT

        afterEach(() => {
            if (ORIGINAL === undefined) delete process.env.DB_QUERY_TIMEOUT
            else process.env.DB_QUERY_TIMEOUT = ORIGINAL
        })

        it('should default queryTimeout to 30000 when unset', () => {
            delete process.env.DB_QUERY_TIMEOUT
            assert.strictEqual(makeDb().connectionPoolParams.queryTimeout, 30000)
        })

        it('should disable the timeout when DB_QUERY_TIMEOUT=0', () => {
            process.env.DB_QUERY_TIMEOUT = '0'
            assert.strictEqual(makeDb().connectionPoolParams.queryTimeout, 0)
        })

        it('should honor an explicit positive DB_QUERY_TIMEOUT', () => {
            process.env.DB_QUERY_TIMEOUT = '45000'
            assert.strictEqual(makeDb().connectionPoolParams.queryTimeout, 45000)
        })

        it('should fall back to 30000 for a non-numeric value', () => {
            process.env.DB_QUERY_TIMEOUT = 'nope'
            assert.strictEqual(makeDb().connectionPoolParams.queryTimeout, 30000)
        })

        it('should fall back to 30000 for a negative value', () => {
            process.env.DB_QUERY_TIMEOUT = '-5'
            assert.strictEqual(makeDb().connectionPoolParams.queryTimeout, 30000)
        })
    })
})
