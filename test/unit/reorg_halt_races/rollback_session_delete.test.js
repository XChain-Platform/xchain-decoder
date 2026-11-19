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
const { finishHaltedWalk } = require('../../../src/XChainDecoder/reorg_verification/halted_walk.js')

// A lock session that records every statement. `owned` answers the in-transaction
// ownership read; `dieAt` makes the session fail from the first matching statement on,
// the way a killed or dropped MariaDB session does.
function lockSession({ owned = 1, dieAt = null } = {}){
    const calls = []
    let dead = false
    const step = (name) => {
        calls.push(name)
        if (dead || (dieAt && dieAt.test(name))){
            dead = true
            throw Object.assign(new Error('Connection killed by MariaDB'), { code: 'ER_CONNECTION_KILLED' })
        }
    }
    return {
        calls,
        beginTransaction: async () => step('BEGIN'),
        commit: async () => step('COMMIT'),
        rollback: async () => step('ROLLBACK'),
        release: async () => step('RELEASE'),
        query: async (sql) => {
            step(sql.replace(/\s+/g, ' ').trim())
            if (/IS_USED_LOCK/.test(sql)) return [{ owned }]
            if (/GET_LOCK/.test(sql)) return [{ l: 1 }]
            return { affectedRows: 1 }
        },
    }
}

// A Database whose pool must never be touched by a session-bound operation: each
// draw is counted and hands back a connection that fails every call at once.
function sessionDb(){
    const db = new Database('h', 3306, 'xchain_test', 'u', 'p')
    const pool = { draws: 0 }
    const fail = async () => { throw new Error('the pool was used') }
    const poison = { query: fail, beginTransaction: fail, commit: fail, rollback: fail, release: async () => {} }
    db.pool = { getConnection: async () => { pool.draws++; return poison } }
    return { db, pool }
}

const LOCK_NAME = 'xchain_reorg_xchain_test'
const writes = (calls) => calls.filter((c) => /^(DELETE|UPDATE|INSERT)/.test(c))

describe('halted-walk delete on the rollback lock session', () => {
    it('runs the ownership read, every delete and the commit on the lock session alone', async () => {
        const { db, pool } = sessionDb()
        const connection = lockSession()
        assert.strictEqual(await db.deleteBlockOnRollbackSession(9, 'hash9', { connection, name: LOCK_NAME }), true)
        assert.strictEqual(connection.calls[0], 'BEGIN')
        assert.match(connection.calls[1], /IS_USED_LOCK/)
        assert.ok(writes(connection.calls).some((c) => /DELETE FROM blocks/.test(c)))
        assert.ok(writes(connection.calls).some((c) => /INSERT INTO events/.test(c)))
        assert.strictEqual(connection.calls[connection.calls.length - 1], 'COMMIT')
        assert.strictEqual(pool.draws, 0)
    })

    it('deletes nothing and rolls back when the session no longer owns the lock', async () => {
        const { db, pool } = sessionDb()
        const connection = lockSession({ owned: 0 })
        await assert.rejects(() => db.deleteBlockOnRollbackSession(9, 'hash9', { connection, name: LOCK_NAME }),
            (err) => err.rollbackLockLost === true)
        assert.deepStrictEqual(writes(connection.calls), [])
        assert.ok(!connection.calls.includes('COMMIT'))
        assert.ok(connection.calls.includes('ROLLBACK'))
        assert.strictEqual(pool.draws, 0)
    })

    it('never commits when the lock session dies between the ownership read and the delete', async () => {
        const { db, pool } = sessionDb()
        const connection = lockSession({ dieAt: /^DELETE FROM transaction_outputs/ })
        await assert.rejects(() => db.deleteBlockOnRollbackSession(9, 'hash9', { connection, name: LOCK_NAME }))
        assert.ok(!connection.calls.includes('COMMIT'))
        assert.ok(!writes(connection.calls).some((c) => /INSERT INTO events/.test(c)))
        assert.strictEqual(pool.draws, 0)
    })

    it('stops the halted walk when ownership vanishes after its pre-check', async () => {
        const { db, pool } = sessionDb()
        const connection = lockSession({ owned: 0 })
        db.getLastBlockIndex = async () => 1
        db.getBlockByIndex = async (height) => ({ block_hash: height === 1 ? 'old' : 'fork' })
        db.ownsReorgRollbackLock = async () => true
        let poolDeletes = 0
        db.deleteBlockByIndex = async () => { poolDeletes++ }
        const ctx = {
            db, startBlockIndex: 0, dispenserExpireSafeDepth: 10, sleep: async () => {},
            connector: {
                getBlockHash: async (height) => height === 1 ? 'new' : 'fork',
                getBlockHeader: async () => ({ confirmations: -1 }),
            },
        }
        const walk = { haltStop: null, rollbackLock: { connection, name: LOCK_NAME } }
        const blocks = []
        await finishHaltedWalk.call(ctx, 1, 0, blocks, walk)
        assert.strictEqual(poolDeletes, 0)
        assert.deepStrictEqual(blocks, [])
        assert.deepStrictEqual(writes(connection.calls), [])
        assert.match(walk.haltStop, /rollback lock was lost/)
        assert.strictEqual(pool.draws, 0)
    })
})

describe('clear-reorg-halt on the rollback lock session', () => {
    it('draws the lock session from the pool even while a transaction is open', async () => {
        const db = new Database('h', 3306, 'xchain_test', 'u', 'p')
        const pooled = lockSession()
        db.pool = { getConnection: async () => pooled }
        db.transactionConnection = lockSession()
        const lock = await db.acquireReorgRollbackLock(0)
        assert.strictEqual(lock.connection, pooled)
    })

    it('runs every check, the append and the read-back on the lock session', async () => {
        const { db, pool } = sessionDb()
        const connection = lockSession()
        const seen = []
        db.acquireReorgRollbackLock = async () => ({ connection, name: LOCK_NAME })
        db.releaseReorgRollbackLock = async () => {}
        db.getReorgHaltMarker = async () => { seen.push(await db.getConnection()); return { halted: true, id: 7 } }
        db.countReorgDeletesAboveTip = async () => { seen.push(await db.getConnection()); return 0 }
        db.countDispensers = async () => 0
        db.hasDispenserTransactions = async () => false
        db.assertStrictSqlMode = async () => {}
        db.clearReorgHalt = async () => { seen.push(await db.getConnection()); return { cleared: true, alreadyClear: false } }
        const code = await run({ db, argv: ['--reason', 'database checked after the halted rollback'], log: () => {}, error: () => {} })
        assert.strictEqual(code, EXIT.OK)
        assert.strictEqual(seen.length, 3)
        assert.ok(seen.every((c) => c === connection))
        assert.strictEqual(db.transactionConnection, null)
        assert.strictEqual(pool.draws, 0)
    })

    it('refuses to bind the lock session over an open transaction', async () => {
        const { db } = sessionDb()
        const open = lockSession()
        db.transactionConnection = open
        await assert.rejects(() => db.runOnReorgRollbackSession({ connection: lockSession(), name: LOCK_NAME }, async () => {}))
        assert.strictEqual(db.transactionConnection, open)
    })
})
