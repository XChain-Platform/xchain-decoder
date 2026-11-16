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
 *********************************************************************/

'use strict'

const assert = require('assert')
const Database = require('../../../src/db.js')
const { run, EXIT } = require('../../../src/clear_reorg_halt.js')

const halt = () => ({ id: 7, time: 't', code: 'REORG_HALT', data: JSON.stringify({ reason: 'safe-depth' }) })
const cleared = () => ({ id: 8, time: 't', code: 'REORG_HALT_CLEARED', data: JSON.stringify({ reason: 'long enough reason' }) })

function makeConnection(mode){
    const calls = []
    const counts = { release: 0, destroy: 0 }
    let state = [halt()]
    return {
        calls,
        counts,
        async query(sql){
            calls.push(String(sql))
            if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode }]
            if (/INSERT INTO events/.test(sql)){ state = [cleared()]; return { affectedRows: 1 } }
            return state
        },
        async release(){ counts.release += 1 },
        async destroy(){ counts.destroy += 1 }
    }
}

function makeDb(connections){
    const db = Object.create(Database.prototype)
    db.transactionConnection = null
    db.DUPLICATED_TRANSACTION = 1
    let index = 0
    db.getConnection = async () => connections[Math.min(index++, connections.length - 1)]
    return db
}

describe('clearReorgHalt checks sql_mode on its writing connection', function () {
    it('refuses and destroys a lax writing connection after a separate strict check', async function () {
        const strict = makeConnection('STRICT_TRANS_TABLES')
        const lax = makeConnection('NO_ENGINE_SUBSTITUTION')
        const db = makeDb([strict, lax])
        await db.assertStrictSqlMode()
        const result = await db.clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 7 })
        assert.strictEqual(result.laxSession, true)
        assert.ok(!lax.calls.some((sql) => /INSERT INTO events|REORG_HALT_CLEARED/.test(sql)))
        assert.deepStrictEqual(lax.counts, { release: 0, destroy: 1 })
    })

    it('refuses NO_BACKSLASH_ESCAPES on the writing connection', async function () {
        const conn = makeConnection('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES')
        const result = await makeDb([conn]).clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 7 })
        assert.strictEqual(result.laxSession, true)
        assert.deepStrictEqual(conn.counts, { release: 0, destroy: 1 })
    })

    it('checks, reads, inserts, and reads back on one strict connection', async function () {
        const conn = makeConnection('STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION')
        const result = await makeDb([conn]).clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 7 })
        assert.deepStrictEqual(result, { cleared: true, alreadyClear: false })
        assert.match(conn.calls[0], /@@SESSION\.sql_mode/)
        assert.strictEqual(conn.calls.length, 4)
        assert.strictEqual(conn.calls.filter((sql) => /INSERT INTO events/.test(sql)).length, 1)
        assert.strictEqual(conn.calls.filter((sql) => /REORG_HALT_CLEARED/.test(sql)).length, 2)
        assert.deepStrictEqual(conn.counts, { release: 1, destroy: 0 })
    })

    it('caller-owned helpers do not release the supplied connection', async function () {
        const conn = makeConnection('STRICT_TRANS_TABLES')
        const db = makeDb([conn])
        await db.readReorgHaltState(conn)
        await db.insertEvent('REORG_HALT_CLEARED', { reason: 'long enough reason' }, undefined, conn)
        assert.deepStrictEqual(conn.counts, { release: 0, destroy: 0 })
    })

    it('the CLI reports a binding writing-connection refusal', async function () {
        const errors = []
        const db = {
            getReorgHaltMarker: async () => ({ halted: true, id: 7, at: null, reason: null }),
            countReorgDeletesAboveTip: async () => 0,
            countDispensers: async () => 0,
            hasDispenserTransactions: async () => false,
            assertStrictSqlMode: async () => {},
            clearReorgHalt: async () => ({ cleared: false, alreadyClear: false, laxSession: true, error: 'bad mode' })
        }
        const code = await run({ db, argv: ['--reason', 'long enough reason'], log: () => {}, error: (line) => errors.push(line) })
        assert.strictEqual(code, EXIT.FAILED)
        assert.match(errors.join('\n'), /REFUSED.*strict-mode check.*Nothing was cleared/)
    })
})
