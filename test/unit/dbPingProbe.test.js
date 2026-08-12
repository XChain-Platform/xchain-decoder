// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression coverage for the API health/status DB probe.
//
// The probes used to call db.getConnection(), which returns the shared
// this.transactionConnection while a block transaction is open, and then
// .release()d it directly: any monitor polling /status or `health` mid-block
// handed the block's live transaction connection back to the pool while the
// block loop kept writing on it (per-block atomicity destroyed, externally
// triggerable, no auth). db.ping() must draw its own pooled connection and
// never touch the transaction connection.

const assert = require('assert')
const Database = require('../../src/db.js')

function makeDb(name = 'test_db') {
    return new Database('127.0.0.1', 3306, name, 'user', 'pass')
}

function makeTrackedConn() {
    return {
        releaseCount: 0,
        queryLog: [],
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async release() { this.releaseCount++ },
        async query(sql) { this.queryLog.push(sql); return [] }
    }
}

describe('Database.ping() health probe isolation', () => {
    it('draws a pooled connection even while a block transaction is open', async () => {
        const db = makeDb()
        const txConn = makeTrackedConn()
        const probeConn = makeTrackedConn()

        // Open a block transaction on txConn, then hand the probe its own conn.
        db.pool.getConnection = async () => txConn
        await db.beginTransaction()
        assert.strictEqual(db.transactionConnection, txConn)
        db.pool.getConnection = async () => probeConn

        const ok = await db.ping()
        assert.strictEqual(ok, true)
        // The probe ran on its own connection and released it exactly once.
        assert.strictEqual(probeConn.queryLog.length, 1)
        assert.match(probeConn.queryLog[0], /SELECT 1/i)
        assert.strictEqual(probeConn.releaseCount, 1)
        // The open transaction connection was never queried or released.
        assert.strictEqual(txConn.queryLog.length, 0, 'probe must not query the tx connection')
        assert.strictEqual(txConn.releaseCount, 0, 'probe must not release the tx connection')
        assert.strictEqual(db.transactionConnection, txConn, 'transaction still owns its connection')
    })

    it('releases its pooled connection and rethrows when the probe query fails', async () => {
        const db = makeDb()
        const probeConn = makeTrackedConn()
        probeConn.query = async () => { throw new Error('db down') }
        db.pool.getConnection = async () => probeConn

        await assert.rejects(() => db.ping(), /db down/)
        assert.strictEqual(probeConn.releaseCount, 1, 'connection released even on failure')
    })

    it('control: getConnection() mid-transaction returns the shared tx connection (the hazard ping avoids)', async () => {
        const db = makeDb()
        const txConn = makeTrackedConn()
        db.pool.getConnection = async () => txConn
        await db.beginTransaction()
        assert.strictEqual(await db.getConnection(), txConn,
            'getConnection short-circuits to the open transaction; probes must never use it')
    })
})
