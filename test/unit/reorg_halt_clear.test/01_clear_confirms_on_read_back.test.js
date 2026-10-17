/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The audited REORG_HALT clear reports cleared only on what a post-write
 * read sees, never on the write's ack.
 */

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const Database = require('../../../src/db.js')

function dbAnswering(handler) {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p')
    const query = sinon.stub().callsFake(async (sql, params) => handler(sql, params))
    db.pool = { getConnection: sinon.stub().resolves({ query, release: sinon.stub().resolves() }) }
    return { db, query }
}

const halt = (id) => ({ id, time: '2026-09-07 06:29:07', code: 'REORG_HALT', data: JSON.stringify({ reason: 'safe-depth', at: '2026-09-07T06:29:07Z' }) })

// The INSERT binds the code as a parameter, so a SELECT naming REORG_HALT_CLEARED
// in its text is always a halt-state read.
const stateReads = (query) => query.getCalls()
    .map(c => String(c.args[0]))
    .filter(s => /SELECT[\s\S]*REORG_HALT_CLEARED/.test(s)).length

describe('Database: the newest REORG_HALT / REORG_HALT_CLEARED row decides', function () {
    afterEach(() => sinon.restore())

    it('clearReorgHalt reports not-cleared when the write lands but the read-back still shows a halt', async function () {
        const { db, query } = dbAnswering((sql) => {
            if (/INSERT INTO events/.test(sql)) return { affectedRows: 1 }
            return [halt(7)]
        })
        const res = await db.clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 7 })
        assert.deepStrictEqual(res, { cleared: false, alreadyClear: false })
        const inserts = query.getCalls().filter(c => /INSERT INTO events/.test(String(c.args[0]))).length
        assert.strictEqual(inserts, 1, 'the clear row was written')
        assert.strictEqual(stateReads(query), 2, 'the pre-check read and the post-write read-back both ran')
    })

    it('clearReorgHalt refuses a DUPLICATED_TRANSACTION write (errno 1062) without a read-back', async function () {
        const { db, query } = dbAnswering((sql) => {
            if (/INSERT INTO events/.test(sql)) throw Object.assign(new Error('Duplicate entry'), { errno: 1062 })
            return [halt(7)]
        })
        const res = await db.clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 7 })
        assert.deepStrictEqual(res, { cleared: false, alreadyClear: false })
        assert.strictEqual(stateReads(query), 1, 'a write that is not exactly true refuses before any read-back')
    })
})
