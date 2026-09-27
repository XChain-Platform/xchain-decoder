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
})
