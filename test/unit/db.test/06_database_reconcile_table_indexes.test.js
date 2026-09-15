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
// reconcileTableIndexes
// ============================================================================
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

describe('Database#reconcileTableIndexes()', () => {
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
})

describe('Database#reconcileTableIndexes()', () => {
    beforeEach(() => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-idx-test-'))
        db = makeDb()
        db.sqlPath = fixtureDir
    })

    afterEach(() => {
        fs.rmSync(fixtureDir, { recursive: true, force: true })
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
