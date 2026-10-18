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
const sinon  = require('sinon')
const Database = require('../../../src/db.js')

function dbAnswering(handler) {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p')
    const query = sinon.stub().callsFake(async (sql, params) => handler(sql, params))
    db.pool = { getConnection: sinon.stub().resolves({ query, release: sinon.stub().resolves() }) }
    return { db, query }
}

const clearRow = (id, data) => ({ id, time: '2026-09-08 10:00:00', code: 'REORG_HALT_CLEARED', data })
const auditedClear = (id) => clearRow(id, JSON.stringify({ reason: 'long enough reason', at: '2026-09-08T11:00:00Z', cleared_halt_id: 9 }))

describe('Database: the newest REORG_HALT / REORG_HALT_CLEARED row decides', function () {
    afterEach(() => sinon.restore())

    it('a clear row with an unparseable payload still counts as live (fail-closed)', async function () {
        const { db } = dbAnswering(() => [clearRow(9, '{not json')])
        assert.strictEqual(await db.isReorgHalted(), true)
        const m = await db.getReorgHaltMarker()
        assert.strictEqual(m.halted, true)
        assert.strictEqual(m.id, 9)
        assert.strictEqual(m.cleared_at, null)
        assert.match(m.reason, /unaudited REORG_HALT_CLEARED/)
    })

    it('a clear row with no reason or a reason under 8 characters still counts as live (fail-closed)', async function () {
        const shapes = ['{}', 'null', '[]', JSON.stringify({ reason: 'short' }), JSON.stringify({ reason: 12345678 }), JSON.stringify({ reason: '      ok' })]
        for (const data of shapes) {
            const { db } = dbAnswering(() => [clearRow(9, data)])
            assert.strictEqual(await db.isReorgHalted(), true, 'clear row data ' + data + ' must not lift the halt')
        }
    })

    it('a clear row holding an already-parsed payload with a valid reason still lifts the halt', async function () {
        const { db } = dbAnswering(() => [clearRow(9, { reason: 'zero dispensers', at: '2026-09-08T10:00:00Z' })])
        assert.strictEqual(await db.isReorgHalted(), false)
    })

    it('an audited clear supersedes an unaudited clear row', async function () {
        let state = [clearRow(9, '{}')]
        const inserted = []
        const { db } = dbAnswering((sql, params) => {
            if (/INSERT INTO events/.test(sql)) { inserted.push(params); state = [auditedClear(10)]; return { affectedRows: 1 } }
            return state
        })
        const res = await db.clearReorgHalt({ reason: 'long enough reason', expectedHaltId: 9 })
        assert.deepStrictEqual(res, { cleared: true, alreadyClear: false })
        assert.strictEqual(JSON.parse(inserted[0][2]).cleared_halt_id, 9)
    })

    it('markReorgHalted writes a REORG_HALT row when the live halt is an unaudited clear row', async function () {
        let state = [clearRow(9, '{}')]
        const inserted = []
        const { db } = dbAnswering((sql, params) => {
            if (/INSERT INTO events/.test(sql)) {
                inserted.push(params)
                state = [{ id: 10, time: 't', code: 'REORG_HALT', data: params[2] }]
                return { affectedRows: 1 }
            }
            return state
        })
        assert.strictEqual(await db.markReorgHalted('over-deep'), true)
        assert.strictEqual(inserted.length, 1)
        assert.strictEqual(inserted[0][1], 'REORG_HALT')
    })
})
