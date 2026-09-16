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
})

describe('Database#stripSqlLineComments()', () => {
    let db

    before(() => {
        db = makeDb()
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

    it('should strip a # comment, which MariaDB honours to end-of-line like --', () => {
        const result = db.stripSqlLineComments('SELECT 1 # this is a comment\nSELECT 2')
        assert.ok(!result.includes('this is a comment'))
        assert.ok(result.includes('SELECT 1'))
        assert.ok(result.includes('SELECT 2'))
    })

    it('should preserve a # inside quoted strings and backtick identifiers', () => {
        assert.ok(db.stripSqlLineComments("SELECT '# not a comment' FROM t").includes('# not a comment'))
        assert.ok(db.stripSqlLineComments('SELECT "# not a comment" FROM t').includes('# not a comment'))
        assert.ok(db.stripSqlLineComments('SELECT `col#1` FROM t').includes('`col#1`'))
    })

    it('should copy /* */ block comments through verbatim', () => {
        const sql = '/* see issue #4413 -- and this */ SELECT 1'
        assert.strictEqual(db.stripSqlLineComments(sql), sql)
    })

    it('should not treat an apostrophe in block-comment prose as a quote start', () => {
        const result = db.stripSqlLineComments("/* don't do this */ SELECT 1 -- gone\nSELECT 2")
        assert.ok(!result.includes('gone'))
        assert.ok(result.includes('SELECT 2'))
    })
})
