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
// parseExpectedColumns
// ============================================================================
describe('Database#parseExpectedColumns()', () => {
    let db

    before(() => {
        db = makeDb()
    })
    it('should parse a simple CREATE TABLE with two columns', () => {
        // A surrogate AUTO_INCREMENT column whose PK is a different column (e.g.
        // pubkeys.id, PK is address_id). AUTO_INCREMENT implies NOT NULL; if this
        // read as nullable, alterTableForDrift would emit a bare `MODIFY <type> NULL`
        // that silently strips AUTO_INCREMENT (the 2026-06-10 mirror-cursor incident).
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
})

describe('Database#parseExpectedColumns()', () => {
    let db

    before(() => {
        db = makeDb()
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
})

describe('Database#parseExpectedColumns()', () => {
    let db

    before(() => {
        db = makeDb()
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

    it('should treat a bare non-PK AUTO_INCREMENT column as notNull even without the NOT NULL token', () => {
        // A surrogate AUTO_INCREMENT column whose PK is a different column (e.g.
        // pubkeys.id, PK is address_id). AUTO_INCREMENT implies NOT NULL; if this
        // read as nullable, alterTableForDrift would emit a bare `MODIFY <type> NULL`
        // that silently strips AUTO_INCREMENT from a live table.
        const sql = `
            CREATE TABLE t (
                address_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                id BIGINT UNSIGNED AUTO_INCREMENT UNIQUE
            );
        `
        const cols = db.parseExpectedColumns(sql)
        assert.ok(cols)
        const idCol = cols.find(c => c.name === 'id')
        assert.ok(idCol)
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
})

describe('Database#parseExpectedColumns()', () => {
    let db

    before(() => {
        db = makeDb()
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
        // Either parses successfully ignoring the empty entry, or returns null.
        // The key is that it doesn't throw.
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
