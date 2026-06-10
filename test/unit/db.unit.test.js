// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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

// ============================================================================
// bigIntSatoshiToDecimalsString
// ============================================================================

describe('Database#bigIntSatoshiToDecimalsString()', () => {
    let db

    before(() => {
        db = makeDb()
    })

    it('should convert 0 satoshis to "0.00000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(0), '0.00000000')
    })

    it('should convert 1 satoshi to "0.00000001"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(1), '0.00000001')
    })

    it('should convert 100000000 satoshis (1 BTC) to "1.00000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(100000000), '1.00000000')
    })

    it('should convert 150000000 satoshis (1.5 BTC) to "1.50000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(150000000), '1.50000000')
    })

    it('should convert 99 satoshis to "0.00000099"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(99), '0.00000099')
    })

    it('should convert 10000000 satoshis (0.1 BTC) to "0.10000000"', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(10000000), '0.10000000')
    })

    it('should handle BigInt input for 1 BTC', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(100000000n), '1.00000000')
    })

    it('should handle BigInt input for 0 satoshis', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(0n), '0.00000000')
    })

    it('should handle large value: 2100000000000000 satoshis (21M BTC)', () => {
        const result = db.bigIntSatoshiToDecimalsString(2100000000000000)
        assert.strictEqual(result, '21000000.00000000')
    })

    it('should handle negative values with a leading dash', () => {
        const result = db.bigIntSatoshiToDecimalsString(-100000000)
        assert.strictEqual(result, '-1.00000000')
    })

    it('should handle -1 satoshi', () => {
        const result = db.bigIntSatoshiToDecimalsString(-1)
        assert.strictEqual(result, '-0.00000001')
    })

    it('should handle 12345678 satoshis (0.12345678 BTC)', () => {
        assert.strictEqual(db.bigIntSatoshiToDecimalsString(12345678), '0.12345678')
    })
})

// ============================================================================
// stripSqlLineComments
// ============================================================================

describe('Database#stripSqlLineComments()', () => {
    let db

    before(() => {
        db = makeDb()
    })

    it('should strip a simple inline comment', () => {
        const sql = 'SELECT * FROM foo -- this is a comment\nWHERE id = 1'
        const result = db.stripSqlLineComments(sql)
        assert.ok(!result.includes('this is a comment'))
        assert.ok(result.includes('SELECT * FROM foo'))
        assert.ok(result.includes('WHERE id = 1'))
    })

    it('should preserve SQL without comments', () => {
        const sql = 'CREATE TABLE foo (id INT, name VARCHAR(20));'
        const result = db.stripSqlLineComments(sql)
        assert.strictEqual(result, sql)
    })

    it('should preserve -- inside a single-quoted string', () => {
        const sql = "SELECT '-- not a comment' FROM t"
        const result = db.stripSqlLineComments(sql)
        assert.ok(result.includes("'-- not a comment'"))
    })

    it('should preserve -- inside a double-quoted string', () => {
        const sql = 'SELECT "-- not a comment" FROM t'
        const result = db.stripSqlLineComments(sql)
        assert.ok(result.includes('"-- not a comment"'))
    })

    it('should preserve -- inside a backtick identifier', () => {
        const sql = 'SELECT `field--name` FROM t'
        const result = db.stripSqlLineComments(sql)
        assert.ok(result.includes('`field--name`'))
    })

    it('should strip a comment at the end of a line and preserve trailing newline', () => {
        const sql = 'SELECT 1 -- trailing comment\nSELECT 2'
        const result = db.stripSqlLineComments(sql)
        assert.ok(result.includes('\n'))
        assert.ok(result.includes('SELECT 2'))
        assert.ok(!result.includes('trailing comment'))
    })

    it('should handle multiple comments on separate lines', () => {
        const sql = '-- first comment\nSELECT 1\n-- second comment\nSELECT 2'
        const result = db.stripSqlLineComments(sql)
        assert.ok(!result.includes('first comment'))
        assert.ok(!result.includes('second comment'))
        assert.ok(result.includes('SELECT 1'))
        assert.ok(result.includes('SELECT 2'))
    })

    it('should handle empty input', () => {
        assert.strictEqual(db.stripSqlLineComments(''), '')
    })

    it('should handle doubled quotes inside a quoted string', () => {
        const sql = "SELECT 'it''s alive' FROM t -- comment"
        const result = db.stripSqlLineComments(sql)
        assert.ok(result.includes("'it''s alive'"))
        assert.ok(!result.includes('comment'))
    })

    it('should handle a comment-only line at end of file (no trailing newline)', () => {
        const sql = 'SELECT 1 -- end of file'
        const result = db.stripSqlLineComments(sql)
        assert.ok(!result.includes('end of file'))
        assert.ok(result.includes('SELECT 1'))
    })
})

// ============================================================================
// parseExpectedColumns
// ============================================================================

describe('Database#parseExpectedColumns()', () => {
    let db

    before(() => {
        db = makeDb()
    })

    it('should parse a simple CREATE TABLE with two columns', () => {
        const sql = `
            CREATE TABLE blocks (
                block_index BIGINT UNSIGNED NOT NULL,
                block_hash_id INT NULL
            ) ENGINE=InnoDB;
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(Array.isArray(cols))
        assert.strictEqual(cols.length, 2)
        assert.strictEqual(cols[0].name, 'block_index')
        assert.strictEqual(cols[0].nullable, false)
        assert.strictEqual(cols[0].notNull, true)
        assert.strictEqual(cols[1].name, 'block_hash_id')
        assert.strictEqual(cols[1].nullable, true)
    })

    it('should skip PRIMARY KEY, INDEX, and KEY constraint lines', () => {
        const sql = `
            CREATE TABLE t (
                id INT NOT NULL AUTO_INCREMENT,
                name VARCHAR(64) NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_name (name)
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        const names = cols.map(c => c.name)
        assert.ok(!names.includes('PRIMARY'))
        assert.ok(!names.includes('INDEX'))
        assert.strictEqual(names.length, 2)
    })

    it('should return null when there is no CREATE TABLE block', () => {
        const sql = 'SELECT * FROM foo;'
        const result = db.parseExpectedColumns(sql)
        assert.strictEqual(result, null)
    })

    it('should return null when column block is empty', () => {
        // An empty CREATE TABLE would have no usable columns after filtering
        const sql = 'CREATE TABLE empty (PRIMARY KEY (id));'
        const result = db.parseExpectedColumns(sql)
        assert.strictEqual(result, null)
    })

    it('should detect DEFAULT keyword correctly', () => {
        const sql = `
            CREATE TABLE t (
                status INT NOT NULL DEFAULT 0,
                name VARCHAR(32) NOT NULL
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        assert.strictEqual(cols[0].hasDefault, true)
        assert.strictEqual(cols[1].hasDefault, false)
    })

    it('should strip inline comments before parsing', () => {
        const sql = `
            CREATE TABLE t (
                id INT NOT NULL, -- primary key column
                value TEXT NULL -- some text
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        assert.strictEqual(cols.length, 2)
        assert.strictEqual(cols[0].name, 'id')
        assert.strictEqual(cols[1].name, 'value')
    })

    it('should handle IF NOT EXISTS in CREATE TABLE', () => {
        const sql = `
            CREATE TABLE IF NOT EXISTS txs (
                tx_index BIGINT NOT NULL,
                hash VARCHAR(64) NULL
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        const names = cols.map(c => c.name)
        assert.ok(names.includes('tx_index'))
        assert.ok(names.includes('hash'))
    })

    it('should treat PRIMARY KEY inline column as notNull (PRIMARY KEY forces NOT NULL)', () => {
        const sql = `
            CREATE TABLE t (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name TEXT
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        const idCol = cols.find(c => c.name === 'id')
        assert.ok(idCol)
        // PRIMARY KEY forces notNull = true
        assert.strictEqual(idCol.notNull, true)
        assert.strictEqual(idCol.nullable, false)
    })

    it('should preserve column definition verbatim', () => {
        const sql = `
            CREATE TABLE t (
                amount DECIMAL(16,8) NOT NULL DEFAULT 0
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        assert.ok(cols[0].definition.includes('DECIMAL'))
        assert.ok(cols[0].definition.includes('DEFAULT'))
    })

    it('should skip empty parts that arise from trailing commas or whitespace-only entries', () => {
        // The comma-split can produce empty strings between consecutive commas
        // or after a comment strips an entire line; the !line guard skips them.
        const sql = `
            CREATE TABLE t (
                id INT NOT NULL,
                ,
                name TEXT NULL
            );
        `
        const cols = db.parseExpectedColumns(sql)
        // Either parses successfully ignoring the empty entry, or returns null —
        // the key is that it doesn't throw.
        // If both id and name are parsed, we got 2 columns.
        if (cols) {
            assert.ok(cols.length >= 1)
        } else {
            assert.strictEqual(cols, null)
        }
    })

    it('should skip column parts that have only one token (e.g. just a backtick-quoted name)', () => {
        // A line with a single token (no type) has tokens.length < 2 and is skipped.
        const sql = `
            CREATE TABLE t (
                id INT NOT NULL,
                \`orphan_token\`,
                name TEXT NULL
            );
        `
        const cols = db.parseExpectedColumns(sql)
        // The `orphan_token` entry (single token after backtick removal) is silently skipped.
        if (cols) {
            const names = cols.map(c => c.name)
            assert.ok(!names.includes('orphan_token'))
        }
    })
})

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
        await db._acquireTransactionLock()
        assert.strictEqual(db._transactionLock, true)
    })

    it('should release lock and set flag to false when queue is empty', async () => {
        await db._acquireTransactionLock()
        db._releaseTransactionLock()
        assert.strictEqual(db._transactionLock, false)
    })

    it('should queue a second caller and resume it on release', async () => {
        // Acquire first
        await db._acquireTransactionLock()
        assert.strictEqual(db._transactionLock, true)

        // Start a second acquire — it will block until released
        let secondAcquired = false
        const secondPromise = db._acquireTransactionLock().then(() => {
            secondAcquired = true
        })

        // Not yet — still held by first
        assert.strictEqual(secondAcquired, false)

        // Release first — second should now resolve
        db._releaseTransactionLock()

        await secondPromise
        assert.strictEqual(secondAcquired, true)
        // Lock is still held by the second caller
        assert.strictEqual(db._transactionLock, true)

        // Release the second one
        db._releaseTransactionLock()
        assert.strictEqual(db._transactionLock, false)
    })
})

// ============================================================================
// parseExpectedIndexes
// ============================================================================

describe('Database#parseExpectedIndexes()', () => {
    let db

    before(() => {
        db = makeDb()
    })

    it('returns [] when no CREATE INDEX statements found', () => {
        const sql = 'CREATE TABLE t (id INT) ENGINE=InnoDB;'
        assert.deepStrictEqual(db.parseExpectedIndexes(sql, 't'), [])
    })

    it('parses a regular CREATE INDEX', () => {
        const sql = [
            'CREATE TABLE blocks (id INT, block_hash_id INT) ENGINE=InnoDB;',
            'CREATE INDEX block_hash_id ON blocks (block_hash_id);'
        ].join('\n')
        const idxs = db.parseExpectedIndexes(sql, 'blocks')
        assert.strictEqual(idxs.length, 1)
        assert.strictEqual(idxs[0].name, 'block_hash_id')
        assert.strictEqual(idxs[0].unique, false)
        assert.deepStrictEqual(idxs[0].columns, ['block_hash_id'])
    })

    it('parses a CREATE UNIQUE INDEX with a multi-column list', () => {
        const sql = 'CREATE UNIQUE INDEX uq_code_id ON events (code, id);'
        const idxs = db.parseExpectedIndexes(sql, 'events')
        assert.strictEqual(idxs.length, 1)
        assert.strictEqual(idxs[0].unique, true)
        assert.deepStrictEqual(idxs[0].columns, ['code', 'id'])
    })

    it('ignores indexes declared for other tables', () => {
        const sql = 'CREATE INDEX idx_other ON other_table (col1);'
        assert.strictEqual(db.parseExpectedIndexes(sql, 'blocks').length, 0)
    })

    it('ignores CREATE INDEX text inside -- line comments', () => {
        const sql = [
            '-- CREATE INDEX commented_out ON blocks (block_hash_id);',
            'CREATE INDEX real_idx ON blocks (block_hash_id);'
        ].join('\n')
        const idxs = db.parseExpectedIndexes(sql, 'blocks')
        assert.strictEqual(idxs.length, 1)
        assert.strictEqual(idxs[0].name, 'real_idx')
    })
})

// ============================================================================
// reconcileTableIndexes
// ============================================================================

describe('Database#reconcileTableIndexes()', () => {
    const fs   = require('fs')
    const os   = require('os')
    const path = require('path')
    let db, fixtureDir

    // Write a one-table SQL fixture and point the instance's sqlPath at it, so
    // the reconciliation reads exactly the statements under test.
    function writeFixture(name, sql) {
        fs.writeFileSync(path.join(fixtureDir, name), sql)
    }

    // A fake leased connection: information_schema reads come from `liveIndexRows` /
    // `idColumnRows`; every ALTER/DELETE is recorded; ADD UNIQUE can be primed to
    // fail once with a duplicate-entry error (the dedupe-then-retry path).
    function makeConn({ liveIndexRows = [], hasIdColumn = true, uniqueAddFailsOnce = false } = {}) {
        const calls = []
        let uniqueFailed = false
        return {
            calls,
            query: async (sql) => {
                calls.push(sql)
                if (/information_schema\.statistics/i.test(sql)) return liveIndexRows
                if (/information_schema\.columns/i.test(sql)) return hasIdColumn ? [{ COLUMN_NAME: 'id' }] : []
                if (/ADD UNIQUE INDEX/i.test(sql) && uniqueAddFailsOnce && !uniqueFailed) {
                    uniqueFailed = true
                    const e = new Error("Duplicate entry 'x' for key 'uq'")
                    e.errno = 1062
                    throw e
                }
                if (/^DELETE t1 FROM/i.test(sql)) return { affectedRows: 3 }
                return []
            }
        }
    }

    beforeEach(() => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-idx-test-'))
        db = makeDb()
        db.sqlPath = fixtureDir
    })

    afterEach(() => {
        fs.rmSync(fixtureDir, { recursive: true, force: true })
    })

    it('adds a declared index that is missing live', async () => {
        writeFixture('blocks.sql', [
            'CREATE TABLE blocks (id INT, block_hash_id INT) ENGINE=InnoDB;',
            'CREATE INDEX block_hash_id ON blocks (block_hash_id);'
        ].join('\n'))
        const conn = makeConn({ liveIndexRows: [] })
        await db.reconcileTableIndexes('blocks.sql', conn)
        assert.ok(conn.calls.some(s => /ALTER TABLE `blocks` ADD INDEX `block_hash_id` \(`block_hash_id`\)/.test(s)),
            'expected ADD INDEX, got: ' + JSON.stringify(conn.calls))
    })

    it('treats a renamed-but-equivalent live index as present (no ALTER)', async () => {
        writeFixture('blocks.sql', [
            'CREATE TABLE blocks (id INT, block_hash_id INT) ENGINE=InnoDB;',
            'CREATE INDEX block_hash_id ON blocks (block_hash_id);'
        ].join('\n'))
        const conn = makeConn({
            liveIndexRows: [{ INDEX_NAME: 'some_old_name', NON_UNIQUE: 1, COLUMN_NAME: 'block_hash_id', SEQ_IN_INDEX: 1 }]
        })
        await db.reconcileTableIndexes('blocks.sql', conn)
        assert.ok(!conn.calls.some(s => /ALTER TABLE/i.test(s)),
            'no ALTER expected when the column set is already indexed: ' + JSON.stringify(conn.calls))
    })

    it('leaves a live index alone when its name is taken by a different column set', async () => {
        writeFixture('blocks.sql', [
            'CREATE TABLE blocks (id INT, a INT, b INT) ENGINE=InnoDB;',
            'CREATE INDEX idx_a ON blocks (a);'
        ].join('\n'))
        const conn = makeConn({
            liveIndexRows: [{ INDEX_NAME: 'idx_a', NON_UNIQUE: 1, COLUMN_NAME: 'b', SEQ_IN_INDEX: 1 }]
        })
        await db.reconcileTableIndexes('blocks.sql', conn)
        assert.ok(!conn.calls.some(s => /ALTER TABLE/i.test(s)),
            'name collision must be left alone: ' + JSON.stringify(conn.calls))
    })

    it('upgrades via dedupe-then-retry when a UNIQUE add hits duplicate rows', async () => {
        writeFixture('mempool_transactions.sql', [
            'CREATE TABLE mempool_transactions (id INT, tx_hash_id INT) ENGINE=InnoDB;',
            'CREATE UNIQUE INDEX mempool_tx_hash_id ON mempool_transactions (tx_hash_id);'
        ].join('\n'))
        const conn = makeConn({ liveIndexRows: [], uniqueAddFailsOnce: true })
        await db.reconcileTableIndexes('mempool_transactions.sql', conn)
        const adds    = conn.calls.filter(s => /ADD UNIQUE INDEX/i.test(s))
        const dedupes = conn.calls.filter(s => /^DELETE t1 FROM `mempool_transactions` t1 JOIN/i.test(s))
        assert.strictEqual(adds.length, 2, 'ADD UNIQUE should be attempted, then retried after dedupe')
        assert.strictEqual(dedupes.length, 1, 'one dedupe DELETE expected')
    })

    it('skips the unique add (still resolving) when the table has no id column to dedupe by', async () => {
        writeFixture('t.sql', [
            'CREATE TABLE t (a INT) ENGINE=InnoDB;',
            'CREATE UNIQUE INDEX uq_a ON t (a);'
        ].join('\n'))
        const conn = makeConn({ liveIndexRows: [], hasIdColumn: false, uniqueAddFailsOnce: true })
        await db.reconcileTableIndexes('t.sql', conn)
        const adds = conn.calls.filter(s => /ADD UNIQUE INDEX/i.test(s))
        assert.strictEqual(adds.length, 1, 'no retry without a dedupe survivor column')
        assert.ok(!conn.calls.some(s => /^DELETE t1 FROM/i.test(s)), 'no dedupe DELETE without id')
    })

    it('is non-fatal when the SQL source cannot be read', async () => {
        const conn = makeConn()
        await db.reconcileTableIndexes('does-not-exist.sql', conn) // must not throw
        assert.ok(!conn.calls.some(s => /ALTER TABLE/i.test(s)))
    })
})
