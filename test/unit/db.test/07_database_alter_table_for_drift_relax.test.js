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
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const Database = require('../../../src/db.js')

// One table whose every column the source declares nullable; the live rows decide
// which ones the reconciler may relax with a bare MODIFY.
const SOURCE = 'CREATE TABLE t (\n  id INT NULL,\n  a VARCHAR(10) NULL,\n  b INT NULL\n) ENGINE=InnoDB;\n'

const liveCol = (name, over) => Object.assign({
    COLUMN_NAME: name, IS_NULLABLE: 'NO', COLUMN_TYPE: 'int(11)', COLUMN_KEY: '', EXTRA: '',
    COLUMN_DEFAULT: null, COLUMN_COMMENT: '', GENERATION_EXPRESSION: '', COLLATION_NAME: null,
}, over)

// Fill in every source column the case does not name as already nullable, so only the named ones drift.
const withRest = (rows) => rows.concat(['id', 'a', 'b'].filter(n => !rows.some(r => r.COLUMN_NAME === n)).map(n => liveCol(n, { IS_NULLABLE: 'YES' })))

// Run alterTableForDrift against fake live columns and return the ALTERs it issued.
async function altersFor(liveRows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-drift-relax-'))
    fs.writeFileSync(path.join(dir, 't.sql'), SOURCE)
    const db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass')
    db.sqlPath = dir
    const alters = []
    const conn = { query: async (sql) => {
        if (/information_schema\.columns/i.test(sql)) return withRest(liveRows)
        alters.push(sql)
        return []
    } }
    await db.alterTableForDrift('t.sql', conn)
    return alters
}

describe('Database#alterTableForDrift() NOT NULL relax keeps live attributes', () => {
    it('reads every attribute a bare MODIFY could drop from the live column', async () => {
        let probe = ''
        const db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass')
        db.sqlPath = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-drift-relax-'))
        fs.writeFileSync(path.join(db.sqlPath, 't.sql'), SOURCE)
        await db.alterTableForDrift('t.sql', { query: async (sql) => { if (!probe) probe = sql; return [] } })
        for (const col of ['COLUMN_DEFAULT', 'COLUMN_COMMENT', 'GENERATION_EXPRESSION', 'COLLATION_NAME'])
            assert.match(probe, new RegExp(col), 'live query must read ' + col)
    })

    it('skips the relax when the live column carries a DEFAULT, COMMENT, ON UPDATE or generation expression', async () => {
        for (const over of [
            { COLUMN_DEFAULT: '0' },
            { COLUMN_COMMENT: 'why' },
            { EXTRA: 'on update current_timestamp()' },
            { GENERATION_EXPRESSION: '`a` + 1', EXTRA: 'VIRTUAL GENERATED' },
        ]) {
            assert.deepStrictEqual(await altersFor([liveCol('b', over)]), [], JSON.stringify(over))
        }
    })

    it('restates the live collation when it relaxes a clean column', async () => {
        const alters = await altersFor([liveCol('a', { COLUMN_TYPE: 'varchar(10)', COLLATION_NAME: 'utf8mb4_bin' }), liveCol('b')])
        assert.deepStrictEqual(alters, [
            'ALTER TABLE `t` MODIFY `a` varchar(10) COLLATE utf8mb4_bin NULL',
            'ALTER TABLE `t` MODIFY `b` int(11) NULL',
        ])
    })

    it('still never relaxes a primary-key or AUTO_INCREMENT column', async () => {
        const alters = await altersFor([liveCol('id', { COLUMN_KEY: 'PRI' }), liveCol('b', { EXTRA: 'auto_increment' })])
        assert.deepStrictEqual(alters, [])
    })
})
