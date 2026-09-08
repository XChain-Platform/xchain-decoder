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
 * The audited REORG_HALT clear.
 *
 * A halt marker used to be cleared only by rebuilding the schema, so a database
 * nothing had been purged from still owed a full resync. The clear writes a
 * REORG_HALT_CLEARED row (reason, checks, the halt it supersedes) and the newest
 * of the two codes decides; the halt row is never deleted.
 */

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const Database = require('../../src/db.js')
const { run, parseArgs, EXIT } = require('../../src/clear-reorg-halt.js')

function dbAnswering(handler) {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_mainnet', 'u', 'p')
    const query = sinon.stub().callsFake(async (sql, params) => handler(sql, params))
    db.pool = { getConnection: sinon.stub().resolves({ query, release: sinon.stub().resolves() }) }
    return { db, query }
}

const halt    = (id) => ({ id, time: '2026-09-07 06:29:07', code: 'REORG_HALT',         data: JSON.stringify({ reason: 'safe-depth', at: '2026-09-07T06:29:07Z' }) })
const cleared = (id) => ({ id, time: '2026-09-08 10:00:00', code: 'REORG_HALT_CLEARED', data: JSON.stringify({ reason: 'zero dispensers', at: '2026-09-08T10:00:00Z' }) })

describe('Database: the newest REORG_HALT / REORG_HALT_CLEARED row decides', function () {
    afterEach(() => sinon.restore())

    it('a halt with no clear is live', async function () {
        const { db } = dbAnswering(() => [halt(7)])
        assert.strictEqual(await db.isReorgHalted(), true)
        const m = await db.getReorgHaltMarker()
        assert.strictEqual(m.halted, true)
        assert.strictEqual(m.reason, 'safe-depth')
        assert.strictEqual(m.cleared_at, null)
    })

    it('a clear newer than the halt reads as not halted, and says when and why it was cleared', async function () {
        const { db } = dbAnswering(() => [cleared(9)])
        assert.strictEqual(await db.isReorgHalted(), false)
        const m = await db.getReorgHaltMarker()
        assert.deepStrictEqual(m, { halted: false, at: null, reason: null, cleared_at: '2026-09-08T10:00:00Z', cleared_reason: 'zero dispensers' })
    })

    it('no row at all is not halted', async function () {
        const { db } = dbAnswering(() => [])
        assert.strictEqual(await db.isReorgHalted(), false)
        assert.strictEqual((await db.getReorgHaltMarker()).halted, false)
    })

    it('asks for the newest of BOTH codes in one query', async function () {
        const { db, query } = dbAnswering(() => [])
        await db.isReorgHalted()
        const sql = String(query.firstCall.args[0])
        assert.match(sql, /code IN \('REORG_HALT', 'REORG_HALT_CLEARED'\)/)
        assert.match(sql, /ORDER BY id DESC LIMIT 1/)
    })

    it('a halt row with an unreadable code or payload still counts as live (fail-closed)', async function () {
        const { db } = dbAnswering(() => [{ id: 3, time: 't', code: undefined, data: '{not json' }])
        assert.strictEqual(await db.isReorgHalted(), true)
    })

    it('clearReorgHalt writes a REORG_HALT_CLEARED row that supersedes the halt and confirms by read-back', async function () {
        let state = [halt(7)]
        const inserted = []
        const { db } = dbAnswering((sql, params) => {
            if (/INSERT INTO events/.test(sql)) { inserted.push(params); state = [cleared(8)]; return { affectedRows: 1 } }
            return state
        })
        const res = await db.clearReorgHalt({ reason: 'mainnet decoder, zero dispensers, range re-synced', checks: { dispensers: 0 }, forced: false })
        assert.deepStrictEqual(res, { cleared: true, alreadyClear: false })
        assert.strictEqual(inserted.length, 1)
        assert.strictEqual(inserted[0][1], 'REORG_HALT_CLEARED')
        const payload = JSON.parse(inserted[0][2])
        assert.strictEqual(payload.reason, 'mainnet decoder, zero dispensers, range re-synced')
        assert.strictEqual(payload.cleared_halt_id, 7)
        assert.strictEqual(payload.cleared_halt_reason, 'safe-depth')
        assert.deepStrictEqual(payload.checks, { dispensers: 0 })
        assert.strictEqual(payload.forced, false)
    })

    it('clearReorgHalt is a no-op on a database that is not halted', async function () {
        const { db, query } = dbAnswering(() => [])
        assert.deepStrictEqual(await db.clearReorgHalt({ reason: 'long enough reason' }), { cleared: false, alreadyClear: true })
        assert.ok(!query.getCalls().some(c => /INSERT/.test(String(c.args[0]))), 'nothing written')
    })

    it('clearReorgHalt refuses a missing or trivial reason before touching the database', async function () {
        const { db, query } = dbAnswering(() => [halt(7)])
        await assert.rejects(() => db.clearReorgHalt({ reason: 'ok' }), /reason of at least 8 characters/)
        await assert.rejects(() => db.clearReorgHalt({}), /reason of at least 8 characters/)
        assert.strictEqual(query.callCount, 0)
    })

    it('clearReorgHalt reports not-cleared when the write does not land', async function () {
        const { db } = dbAnswering((sql) => {
            if (/INSERT INTO events/.test(sql)) throw Object.assign(new Error('disk full'), { errno: 1 })
            return [halt(7)]
        })
        assert.deepStrictEqual(await db.clearReorgHalt({ reason: 'long enough reason' }), { cleared: false, alreadyClear: false })
    })

    it('a later halt after a clear is live again', async function () {
        const { db } = dbAnswering(() => [halt(12)])
        assert.strictEqual(await db.isReorgHalted(), true)
    })
})

describe('clear-reorg-halt CLI', function () {
    function fakeDb({ halted = true, deletesAboveTip = 0, dispensers = 0, dispenserTxs = false, clearResult = { cleared: true, alreadyClear: false } } = {}) {
        const calls = { clear: [] }
        const db = {
            getReorgHaltMarker:        async () => (halted ? { halted: true, at: '2026-09-07T06:29:07Z', reason: 'safe-depth', cleared_at: null, cleared_reason: null }
                                                          : { halted: false, at: null, reason: null, cleared_at: '2026-09-08T10:00:00Z', cleared_reason: 'earlier clear' }),
            countReorgDeletesAboveTip: async () => deletesAboveTip,
            countDispensers:           async () => dispensers,
            hasDispenserTransactions:  async () => dispenserTxs,
            clearReorgHalt:            async (opts) => { calls.clear.push(opts); return clearResult }
        }
        return { db, calls }
    }
    const quiet = { log: () => {}, error: () => {} }
    const REASON = 'BTC mainnet decoder, no dispensers exist yet, block range intact'

    it('parses --reason, --force and --dry-run', function () {
        assert.deepStrictEqual(parseArgs(['--reason', 'x y z', '--force', '--dry-run']),
            { reason: 'x y z', force: true, dryRun: true, help: false, bad: null })
        assert.strictEqual(parseArgs(['--reason=inline']).reason, 'inline')
        assert.match(parseArgs(['--reason']).bad, /requires a text argument/)
        assert.match(parseArgs(['--bogus']).bad, /unknown argument/)
    })

    it('refuses without a substantive reason and writes nothing', async function () {
        const { db, calls } = fakeDb()
        assert.strictEqual(await run({ db, argv: [], ...quiet }), EXIT.USAGE)
        assert.strictEqual(await run({ db, argv: ['--reason', 'short'], ...quiet }), EXIT.USAGE)
        assert.strictEqual(calls.clear.length, 0)
    })

    it('clears a clean database and records the checks', async function () {
        const { db, calls } = fakeDb()
        const lines = []
        assert.strictEqual(await run({ db, argv: ['--reason', REASON], log: (l) => lines.push(l), error: quiet.error }), EXIT.OK)
        assert.strictEqual(calls.clear.length, 1)
        assert.strictEqual(calls.clear[0].reason, REASON)
        assert.strictEqual(calls.clear[0].forced, false)
        assert.deepStrictEqual(calls.clear[0].checks, { deletes_above_tip: 0, dispensers: 0, dispenser_transactions: false })
        assert.ok(lines.some(l => /cleared\./.test(l)))
    })

    it('is a no-op when no halt is live', async function () {
        const { db, calls } = fakeDb({ halted: false })
        const lines = []
        assert.strictEqual(await run({ db, argv: ['--reason', REASON], log: (l) => lines.push(l), error: quiet.error }), EXIT.OK)
        assert.strictEqual(calls.clear.length, 0)
        assert.ok(lines.some(l => /no live REORG_HALT marker/.test(l) && /earlier clear/.test(l)))
    })

    it('refuses, and cannot be forced, while rolled-back blocks are still missing above the tip', async function () {
        const { db, calls } = fakeDb({ deletesAboveTip: 5 })
        assert.strictEqual(await run({ db, argv: ['--reason', REASON, '--force'], ...quiet }), EXIT.NOT_RESYNCED)
        assert.strictEqual(calls.clear.length, 0)
    })

    it('refuses a database that has held dispenser state unless forced, and records the force', async function () {
        const { db, calls } = fakeDb({ dispensers: 3 })
        assert.strictEqual(await run({ db, argv: ['--reason', REASON], ...quiet }), EXIT.DISPENSER_STATE)
        assert.strictEqual(calls.clear.length, 0)

        const forced = fakeDb({ dispenserTxs: true })
        assert.strictEqual(await run({ db: forced.db, argv: ['--reason', REASON, '--force'], ...quiet }), EXIT.OK)
        assert.strictEqual(forced.calls.clear[0].forced, true)
    })

    it('--dry-run reports the verdict and writes nothing', async function () {
        const { db, calls } = fakeDb()
        const lines = []
        assert.strictEqual(await run({ db, argv: ['--reason', REASON, '--dry-run'], log: (l) => lines.push(l), error: quiet.error }), EXIT.OK)
        assert.strictEqual(calls.clear.length, 0)
        assert.ok(lines.some(l => /dry run/.test(l)))
    })

    it('reports failure when the clear row does not land', async function () {
        const { db } = fakeDb({ clearResult: { cleared: false, alreadyClear: false } })
        assert.strictEqual(await run({ db, argv: ['--reason', REASON], ...quiet }), EXIT.FAILED)
    })
})
