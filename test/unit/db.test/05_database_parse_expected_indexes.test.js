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
