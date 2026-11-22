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

const at = '2026-11-19T12:00:00Z'
const halt = (id, reason = 'safe-depth halt') => ({ id, time: at, code: 'REORG_HALT', data: JSON.stringify({ reason, at }) })
const clear = (id, target, extra = {}) => ({
    id, time: at, code: 'REORG_HALT_CLEARED',
    data: JSON.stringify({ reason: 'audited operator clear', at, ...extra,
        ...(target === undefined ? {} : { cleared_halt_id: target }) })
})

function memoryDb(initial){
    const events = [...initial]
    const db = new Database('h', 3306, 'xchain_test', 'u', 'p')
    const query = async (sql, params) => {
        if (/@@SESSION\.sql_mode/.test(sql)) return [{ mode: 'STRICT_TRANS_TABLES' }]
        if (/INSERT INTO events/.test(sql)){
            const payload = JSON.parse(params[2])
            events.push({ id: events.length ? Number(events.at(-1).id) + 1 : 1,
                time: payload.at, code: params[1], data: params[2] })
            return { affectedRows: 1 }
        }
        if (/LIMIT 1;/.test(sql)) return [...events].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 1)
        if (/LIMIT 1001;/.test(sql)) return [...events].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 1001)
        throw new Error('unexpected query: ' + sql)
    }
    db.pool = { getConnection: async () => ({ query, release: async () => {} }) }
    return { db, events }
}

describe('REORG_HALT clears bind to the halt they name', () => {
    it('keeps a newer halt live when a delayed clear names the older halt', async () => {
        const { db } = memoryDb([halt(10), clear(11, 10), halt(12), clear(13, 10)])
        const state = await db.readReorgHaltState()
        assert.strictEqual(state.halted, true)
        assert.strictEqual(state.id, 12)
        assert.strictEqual(state.stale_clear, true)
        assert.strictEqual((await db.getReorgHaltMarker()).id, 12)
    })

    it('lets a later audited clear recover from a stale clear', async () => {
        const { db } = memoryDb([halt(10), clear(11, 10), halt(12), clear(13, 10), clear(14, 12)])
        const state = await db.readReorgHaltState()
        assert.strictEqual(state.halted, false)
        assert.strictEqual(state.cleared_reason, 'audited operator clear')
    })

    it('keeps legacy clears valid but fails closed on a null target', async () => {
        const legacy = memoryDb([halt(10), clear(11, undefined)])
        assert.strictEqual((await legacy.db.readReorgHaltState()).halted, false)
        const unreadable = memoryDb([halt(10), clear(11, null)])
        assert.strictEqual((await unreadable.db.readReorgHaltState()).id, 10)
    })

    it('reports a stale clear read-back as superseded', async () => {
        const { db, events } = memoryDb([halt(10)])
        const originalInsert = db.insertEvent.bind(db)
        db.insertEvent = async (...args) => {
            events.push(clear(11, 10), halt(12))
            return originalInsert(...args)
        }
        const result = await db.clearReorgHalt({ reason: 'delayed clear for halt ten', expectedHaltId: 10 })
        assert.deepStrictEqual(result, { cleared: false, alreadyClear: false, superseded: true, liveHaltId: 12 })
        assert.strictEqual((await db.readReorgHaltState()).id, 12)
    })
})
