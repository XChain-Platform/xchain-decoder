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
const Database = require('../../src/db.js')

describe('Database session timezone', () => {
    it('pins connection parameters to UTC without changing pool safeguards', () => {
        const db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass')

        assert.strictEqual(db.connectionPoolParams.timezone, 'Z')
        assert.strictEqual(db.connectionParams.timezone, 'Z')
        assert.strictEqual(db.connectionPoolParams.connectionLimit, 10)
        assert.strictEqual(db.connectionPoolParams.insertIdAsNumber, true)
    })

    it('pins every pooled session to a strict sql_mode without NO_BACKSLASH_ESCAPES', () => {
        const { DECODER_SQL_MODE } = require('../../src/db/constants.js')
        const db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass')

        assert.ok(DECODER_SQL_MODE.split(',').includes('STRICT_TRANS_TABLES'))
        assert.ok(!DECODER_SQL_MODE.includes('NO_BACKSLASH_ESCAPES'))
        assert.strictEqual(db.connectionPoolParams.initSql, "SET SESSION sql_mode='" + DECODER_SQL_MODE + "'")
    })
})
