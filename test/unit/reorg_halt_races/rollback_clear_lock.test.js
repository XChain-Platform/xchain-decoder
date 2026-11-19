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
const { verifyReorg } = require('../../../src/XChainDecoder/reorg_verification.js')
const { finishHaltedWalk } = require('../../../src/XChainDecoder/reorg_verification/halted_walk.js')
const { validateClearedHaltResume } = require('../../../src/XChainDecoder/reorg_halt.js')

const reason = 'database checked after the halted rollback finished'

function clearDb(overrides = {}){
    return {
        acquireReorgRollbackLock: async () => ({ id: 'lock' }),
        releaseReorgRollbackLock: async () => {},
        getReorgHaltMarker: async () => ({ halted: true, id: 7 }),
        countReorgDeletesAboveTip: async () => 0,
        countDispensers: async () => 0,
        hasDispenserTransactions: async () => false,
        assertStrictSqlMode: async () => {},
        clearReorgHalt: async () => ({ cleared: true, alreadyClear: false }),
        ...overrides,
    }
}

describe('rollback and halt-clear exclusion', () => {
    it('refuses the CLI before any check when a rollback holds the lock', async () => {
        let touched = false
        const db = clearDb({
            acquireReorgRollbackLock: async () => null,
            getReorgHaltMarker: async () => { touched = true },
        })
        const code = await run({ db, argv: ['--reason', reason], log: () => {}, error: () => {} })
        assert.strictEqual(code, EXIT.ROLLBACK_IN_PROGRESS)
        assert.strictEqual(touched, false)
    })

    it('holds the lock through the checks, clear and read-back result', async () => {
        const calls = []
        const db = clearDb({
            acquireReorgRollbackLock: async () => { calls.push('acquire'); return { id: 'lock' } },
            countReorgDeletesAboveTip: async () => { calls.push('count'); return 0 },
            clearReorgHalt: async () => { calls.push('clear'); return { cleared: true, alreadyClear: false } },
            releaseReorgRollbackLock: async () => { calls.push('release') },
        })
        const code = await run({ db, argv: ['--reason', reason], log: () => {}, error: () => {} })
        assert.strictEqual(code, EXIT.OK)
        assert.ok(calls.indexOf('acquire') < calls.indexOf('count'))
        assert.ok(calls.indexOf('count') < calls.indexOf('clear'))
        assert.ok(calls.indexOf('clear') < calls.indexOf('release'))
    })

    it('makes a busy rollback wait without deleting', async () => {
        let deleted = false
        const ctx = { db: { acquireReorgRollbackLock: async () => null,
            deleteBlockByIndex: async () => { deleted = true } } }
        await assert.rejects(() => verifyReorg.call(ctx, 1), (err) => err.reorgWait === true)
        assert.strictEqual(deleted, false)
    })

    it('stops a halted walk before deletion when lock ownership is lost', async () => {
        let deletes = 0
        const ctx = {
            startBlockIndex: 0, dispenserExpireSafeDepth: 10, sleep: async () => {},
            db: {
                getLastBlockIndex: async () => 1,
                getBlockByIndex: async (height) => ({ block_hash: height === 1 ? 'old' : 'fork' }),
                ownsReorgRollbackLock: async () => false,
                deleteBlockByIndex: async () => { deletes++ },
            },
            connector: {
                getBlockHash: async (height) => height === 1 ? 'new' : 'fork',
                getBlockHeader: async () => ({ confirmations: -1 }),
            },
        }
        const walk = { haltStop: null, rollbackLock: { id: 'lock' } }
        const blocks = []
        await finishHaltedWalk.call(ctx, 1, 0, blocks, walk)
        assert.strictEqual(deletes, 0)
        assert.match(walk.haltStop, /rollback lock was lost/)
    })
})

describe('resume-time rollback recount', () => {
    it('re-halts and stays parked when a clear left deleted heights above the tip', async () => {
        let marked = null
        const ctx = {
            db: { countReorgDeletesAboveTip: async () => 5,
                markReorgHalted: async (why) => { marked = why; return true } },
            logError: () => {}, reorgHalted: false,
        }
        assert.strictEqual(await validateClearedHaltResume.call(ctx), false)
        assert.strictEqual(ctx.reorgHalted, true)
        assert.match(marked, /5 rolled-back block/)
    })

    it('resumes only on a proven zero and stays parked on an unreadable count', async () => {
        const ok = { db: { countReorgDeletesAboveTip: async () => 0 }, logError: () => {} }
        assert.strictEqual(await validateClearedHaltResume.call(ok), true)
        const unread = { db: { countReorgDeletesAboveTip: async () => { throw new Error('down') } }, logError: () => {} }
        assert.strictEqual(await validateClearedHaltResume.call(unread), false)
    })
})

describe('Database rollback lock session', () => {
    it('acquires, verifies and releases on the same connection', async () => {
        const sql = []
        const connection = {
            query: async (query) => {
                sql.push(query)
                if (/GET_LOCK/.test(query)) return [{ l: 1 }]
                if (/IS_USED_LOCK/.test(query)) return [{ owned: 1 }]
                return [{ released: 1 }]
            },
            release: async () => { sql.push('connection.release') },
        }
        const db = new Database('h', 3306, 'xchain_test', 'u', 'p')
        db.pool = { getConnection: async () => connection }
        const lock = await db.acquireReorgRollbackLock(0)
        assert.strictEqual(await db.ownsReorgRollbackLock(lock), true)
        await db.releaseReorgRollbackLock(lock)
        assert.match(sql[0], /GET_LOCK/)
        assert.match(sql[1], /IS_USED_LOCK/)
        assert.match(sql[2], /RELEASE_LOCK/)
        assert.strictEqual(sql[3], 'connection.release')
    })
})
